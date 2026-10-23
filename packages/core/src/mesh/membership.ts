/**
 * The signed membership list: the mesh's root of trust.
 *
 * A mesh is identified by its root key (the hub's `hub/root-key.pem`); the mesh id is the lowercase
 * hex SHA-256 of the root SPKI DER. The hub publishes a `MembershipList` signed by that root key;
 * every device pins the root public key as its anchor (`mesh/anchor.pem`) and decides who it trusts
 * from the newest list that verifies against the anchor.
 *
 * SIGNED BYTES (v1): ECDSA P-256 / SHA-256 (DER, base64) over
 *   utf8("meshdrop-membership-v1") || 0x00 || utf8(canonicalJson(list))
 * (see canonical.ts). Frozen vector: protocol/vectors/membership-v1.json.
 *
 * LIST RULES (validateList): `v` is 1; `mesh` is 64 lowercase hex; `version` is an integer >= 1 that
 * only ever increases; deviceIds are 64 lowercase hex and unique; exactly one member has role "hub" and
 * it is `hub.deviceId`; every `publicKeyPem` is a canonical EC P-256 SPKI PEM; no revoked id is also a
 * member; revoked ids are unique; at most 256 members; no unknown fields anywhere (the signature covers
 * every field, so a field a verifier ignores would be a covert channel).
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { canonicalJson, signDomain, spkiSha256, verifyDomain } from './canonical.ts';
import { DEVICE_ID_RE, canonicalSpki } from '../trust.ts';

/** Domain label for membership signatures (the 0x00 separator is added by signDomain/verifyDomain). */
export const MEMBERSHIP_DOMAIN = 'meshdrop-membership-v1';

/** Maximum number of entries in `members`. */
export const MAX_MEMBERS = 256;

export interface Member {
  deviceId: string;
  alias: string;
  publicKeyPem: string;
  role: 'hub' | 'member';
  addedAt: number;
}

export interface MembershipList {
  v: 1;
  mesh: string;
  version: number;
  issuedAt: number;
  hub: { deviceId: string; urls: string[] };
  members: Member[];
  revoked: { deviceId: string; revokedAt: number }[];
}

export interface SignedMembership {
  list: MembershipList;
  /** Base64 DER ECDSA-P256/SHA-256 signature over the canonical JSON of `list`. */
  sig: string;
}

/** Thrown for any invalid, unverifiable, stale-fork or otherwise rejected membership data. */
export class MembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MembershipError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, keys: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw new MembershipError(`invalid list: unknown field ${where}.${k}`);
  }
  for (const k of keys) {
    if (!(k in o)) throw new MembershipError(`invalid list: missing field ${where}.${k}`);
  }
}

function hexId(v: unknown, where: string): string {
  if (typeof v !== 'string' || !DEVICE_ID_RE.test(v)) throw new MembershipError(`invalid list: ${where} must be 64 lowercase hex characters`);
  return v;
}

function int(v: unknown, where: string, min: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new MembershipError(`invalid list: ${where} must be an integer >= ${min}`);
  return v;
}

/** Checks `l` against the list rules and returns a normalised deep copy. Throws MembershipError. */
export function validateList(l: unknown): MembershipList {
  if (!isObj(l)) throw new MembershipError('invalid list: expected an object');
  exactKeys(l, ['v', 'mesh', 'version', 'issuedAt', 'hub', 'members', 'revoked'], 'list');
  if (l.v !== 1) throw new MembershipError('invalid list: unsupported v');
  const mesh = hexId(l.mesh, 'mesh');
  const version = int(l.version, 'version', 1);
  const issuedAt = int(l.issuedAt, 'issuedAt', Number.MIN_SAFE_INTEGER);

  if (!isObj(l.hub)) throw new MembershipError('invalid list: hub must be an object');
  exactKeys(l.hub, ['deviceId', 'urls'], 'hub');
  const hubId = hexId(l.hub.deviceId, 'hub.deviceId');
  if (!Array.isArray(l.hub.urls) || l.hub.urls.some((u) => typeof u !== 'string')) throw new MembershipError('invalid list: hub.urls must be an array of strings');
  const urls = [...(l.hub.urls as string[])];

  if (!Array.isArray(l.members)) throw new MembershipError('invalid list: members must be an array');
  if (l.members.length > MAX_MEMBERS) throw new MembershipError(`invalid list: more than ${MAX_MEMBERS} members`);
  const seen = new Set<string>();
  const members: Member[] = [];
  let hubs = 0;
  l.members.forEach((m: unknown, i: number) => {
    const at = `members[${i}]`;
    if (!isObj(m)) throw new MembershipError(`invalid list: ${at} must be an object`);
    exactKeys(m, ['deviceId', 'alias', 'publicKeyPem', 'role', 'addedAt'], at);
    const deviceId = hexId(m.deviceId, `${at}.deviceId`);
    if (seen.has(deviceId)) throw new MembershipError(`invalid list: duplicate deviceId ${at}`);
    seen.add(deviceId);
    if (typeof m.alias !== 'string') throw new MembershipError(`invalid list: ${at}.alias must be a string`);
    if (m.role !== 'hub' && m.role !== 'member') throw new MembershipError(`invalid list: ${at}.role must be "hub" or "member"`);
    if (typeof m.publicKeyPem !== 'string') throw new MembershipError(`invalid list: ${at}.publicKeyPem must be a string`);
    try {
      canonicalSpki(m.publicKeyPem);
    } catch {
      throw new MembershipError(`invalid list: ${at}.publicKeyPem is not an EC P-256 SPKI PEM`);
    }
    const addedAt = int(m.addedAt, `${at}.addedAt`, Number.MIN_SAFE_INTEGER);
    if (m.role === 'hub') {
      hubs++;
      if (deviceId !== hubId) throw new MembershipError('invalid list: hub-role member is not hub.deviceId');
    }
    members.push({ deviceId, alias: m.alias, publicKeyPem: m.publicKeyPem, role: m.role, addedAt });
  });
  if (hubs !== 1) throw new MembershipError('invalid list: exactly one member must have role "hub"');

  if (!Array.isArray(l.revoked)) throw new MembershipError('invalid list: revoked must be an array');
  const revSeen = new Set<string>();
  const revoked = l.revoked.map((r: unknown, i: number) => {
    const at = `revoked[${i}]`;
    if (!isObj(r)) throw new MembershipError(`invalid list: ${at} must be an object`);
    exactKeys(r, ['deviceId', 'revokedAt'], at);
    const deviceId = hexId(r.deviceId, `${at}.deviceId`);
    if (seen.has(deviceId)) throw new MembershipError(`invalid list: ${at} is also a member`);
    if (revSeen.has(deviceId)) throw new MembershipError(`invalid list: duplicate ${at}`);
    revSeen.add(deviceId);
    return { deviceId, revokedAt: int(r.revokedAt, `${at}.revokedAt`, Number.MIN_SAFE_INTEGER) };
  });

  return { v: 1, mesh, version, issuedAt, hub: { deviceId: hubId, urls }, members, revoked };
}

/** Validates `l` and signs it with the mesh root key. */
export function signList(l: MembershipList, rootKey: KeyObject): SignedMembership {
  const list = validateList(l);
  return { list, sig: signDomain(MEMBERSHIP_DOMAIN, canonicalJson(list), rootKey) };
}

/**
 * Verifies `s` against the pinned `anchor` (root public key): signature over the canonical list,
 * `list.mesh === spkiSha256(anchor)`, then validateList. Returns the validated list; throws
 * MembershipError on any failure (never anything else, whatever `s` is).
 */
export function verifySigned(s: SignedMembership, anchor: KeyObject): MembershipList {
  if (!isObj(s) || !isObj(s.list) || typeof s.sig !== 'string' || s.sig === '') throw new MembershipError('malformed signed membership');
  let payload: string;
  try {
    payload = canonicalJson(s.list);
  } catch (e) {
    throw new MembershipError(`malformed signed membership: ${(e as Error).message}`);
  }
  if (!verifyDomain(MEMBERSHIP_DOMAIN, payload, s.sig, anchor)) throw new MembershipError('bad signature');
  if ((s.list as { mesh?: unknown }).mesh !== spkiSha256(anchor)) throw new MembershipError('list is for a different mesh');
  return validateList(s.list);
}

/** Parses an anchor PEM (must be a canonical EC P-256 SPKI public key). Throws MembershipError. */
export function parseAnchor(pem: string): KeyObject {
  try {
    canonicalSpki(pem);
    return createPublicKey(pem);
  } catch {
    throw new MembershipError('invalid anchor: expected an EC P-256 SPKI PEM');
  }
}
