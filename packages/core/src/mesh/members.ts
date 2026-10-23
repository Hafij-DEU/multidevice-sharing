/**
 * Device-side mesh state and the trust decisions derived from it.
 *
 * `<home>/mesh/anchor.pem`      the mesh root public key (SPKI PEM), pinned when the device joined
 * `<home>/mesh/membership.json` the newest accepted SignedMembership, exactly `{ "list": ..., "sig": ... }`
 *
 * Both are written atomically (tmp + fsync + rename) at mode 0600. load() fails closed: files that do
 * not verify against the anchor throw instead of being ignored. accept() is the only way the list moves:
 * it verifies against the anchor first, never lets the version go backwards, and persists before it
 * reports 'updated'.
 */
import { type KeyObject } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonical.ts';
import { MembershipError, parseAnchor, verifySigned, type MembershipList, type SignedMembership } from './membership.ts';
import { writeFileAtomic, type TrustSource, type TrustedDevice } from '../trust.ts';

function meshDir(home: string): string {
  return join(home, 'mesh');
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export class MembershipStore implements TrustSource {
  readonly anchor: KeyObject;
  readonly #file: string;
  #signed: SignedMembership;
  #canon: string;
  #members = new Map<string, TrustedDevice>();
  #revoked = new Set<string>();

  private constructor(file: string, anchor: KeyObject, signed: SignedMembership, list: MembershipList) {
    this.#file = file;
    this.anchor = anchor;
    this.#signed = structuredClone(signed);
    this.#canon = canonicalJson(list);
    this.#index(list);
  }

  #index(list: MembershipList): void {
    this.#members = new Map(
      list.members.map((m) => [m.deviceId, { deviceId: m.deviceId, alias: m.alias, publicKeyPem: m.publicKeyPem, addedAt: m.addedAt }]),
    );
    this.#revoked = new Set(list.revoked.map((r) => r.deviceId));
  }

  /**
   * Loads the persisted state. Returns null when this device has no mesh state at all. Anything
   * else that is not a fully verifying anchor + list (one file missing, corrupt, tampered, signed by
   * another root...) throws MembershipError.
   */
  static async load(home: string): Promise<MembershipStore | null> {
    const dir = meshDir(home);
    const anchorPem = readOptional(join(dir, 'anchor.pem'));
    const raw = readOptional(join(dir, 'membership.json'));
    if (anchorPem === null && raw === null) return null;
    if (anchorPem === null || raw === null) throw new MembershipError('incomplete mesh state: anchor.pem and membership.json must both exist');
    const anchor = parseAnchor(anchorPem);
    let signed: SignedMembership;
    try {
      signed = JSON.parse(raw) as SignedMembership;
    } catch {
      throw new MembershipError('corrupt membership.json');
    }
    const list = verifySigned(signed, anchor);
    return new MembershipStore(join(dir, 'membership.json'), anchor, signed, list);
  }

  /**
   * Starts mesh state for a device from a trusted anchor and a list that verifies against it, and
   * persists both. Refuses to replace an existing (complete) mesh state: leaving a mesh means removing
   * the state first. A half-written state (one file) is completed.
   */
  static async init(home: string, anchorPub: KeyObject, s: SignedMembership): Promise<MembershipStore> {
    const dir = meshDir(home);
    const list = verifySigned(s, anchorPub);
    if (readOptional(join(dir, 'anchor.pem')) !== null && readOptional(join(dir, 'membership.json')) !== null) {
      throw new MembershipError('mesh state already exists');
    }
    const anchorFile = join(dir, 'anchor.pem');
    const file = join(dir, 'membership.json');
    writeFileAtomic(anchorFile, anchorPub.export({ type: 'spki', format: 'pem' }) as string);
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
    writeFileAtomic(file, JSON.stringify({ list: s.list, sig: s.sig }, null, 2) + '\n');
    return new MembershipStore(file, anchorPub, s, list);
  }

  /** The newest accepted signed list (a copy). */
  current(): SignedMembership {
    return structuredClone(this.#signed);
  }

  list(): MembershipList {
    return structuredClone(this.#signed.list);
  }

  /**
   * Offers a signed list. It must verify against the anchor (else MembershipError, state unchanged).
   * A lower version is 'stale' and changes nothing; the identical list is 'same'; the same version
   * with a different list or signature is a fork and throws MembershipError('fork'); a higher
   * version is persisted and only then adopted ('updated').
   */
  accept(s: SignedMembership): 'updated' | 'same' | 'stale' {
    const list = verifySigned(s, this.anchor);
    const cur = this.#signed.list.version;
    if (list.version < cur) return 'stale';
    if (list.version === cur) {
      if (s.sig === this.#signed.sig && canonicalJson(list) === this.#canon) return 'same';
      throw new MembershipError('fork');
    }
    writeFileAtomic(this.#file, JSON.stringify({ list: s.list, sig: s.sig }, null, 2) + '\n');
    this.#signed = structuredClone({ list: s.list, sig: s.sig });
    this.#canon = canonicalJson(list);
    this.#index(list);
    return 'updated';
  }

  isTrusted(deviceId: string): boolean {
    return this.#members.has(deviceId);
  }

  get(deviceId: string): TrustedDevice | undefined {
    const d = this.#members.get(deviceId);
    return d && { ...d };
  }

  /** True when the current list revokes `deviceId`. */
  isRevoked(deviceId: string): boolean {
    return this.#revoked.has(deviceId);
  }
}

/**
 * Mesh members plus M1 manually paired devices. A device the mesh list revokes is untrusted even if
 * the manual store still lists it; for a device in both, the mesh list's alias and key win.
 */
export class CompositeTrust implements TrustSource {
  readonly #members: MembershipStore | null;
  readonly #manual: TrustSource;

  constructor(members: MembershipStore | null, manual: TrustSource) {
    this.#members = members;
    this.#manual = manual;
  }

  isTrusted(deviceId: string): boolean {
    if (this.#members?.isTrusted(deviceId)) return true;
    if (this.#members?.isRevoked(deviceId)) return false;
    return this.#manual.isTrusted(deviceId);
  }

  get(deviceId: string): TrustedDevice | undefined {
    const m = this.#members?.get(deviceId);
    if (m) return m;
    if (this.#members?.isRevoked(deviceId)) return undefined;
    return this.#manual.get(deviceId);
  }
}
