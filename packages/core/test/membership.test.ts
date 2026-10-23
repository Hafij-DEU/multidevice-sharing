import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, signDomain, spkiSha256, verifyDomain } from '../src/mesh/canonical.ts';
import {
  MEMBERSHIP_DOMAIN,
  MembershipError,
  signList,
  validateList,
  verifySigned,
  type Member,
  type MembershipList,
} from '../src/mesh/membership.ts';
import { hasRootKey, loadOrCreateRootKey } from '../src/mesh/rootkey.ts';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'meshdrop-membership-'));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const hex32 = () => randomBytes(32).toString('hex');
function spkiPem(pub: KeyObject): string {
  return pub.export({ type: 'spki', format: 'pem' }) as string;
}
function newKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

interface Fixture {
  root: KeyObject;
  rootPub: KeyObject;
  list: MembershipList;
}

/** A valid list for a fresh mesh: one hub, two members. */
function fixture(version = 1): Fixture {
  const r = newKey();
  const mk = (role: Member['role'], alias: string, i: number): Member => ({
    deviceId: hex32(),
    alias,
    publicKeyPem: spkiPem(newKey().publicKey),
    role,
    addedAt: 1790000000000 + i,
  });
  const hub = mk('hub', 'Hub', 0);
  const list: MembershipList = {
    v: 1,
    mesh: spkiSha256(r.publicKey),
    version,
    issuedAt: 1790000001000,
    hub: { deviceId: hub.deviceId, urls: ['https://192.168.1.2:53318'] },
    members: [hub, mk('member', 'Laptop', 1), mk('member', 'Phone ✓', 2)],
    revoked: [],
  };
  return { root: r.privateKey, rootPub: r.publicKey, list };
}

const clone = <T>(v: T): T => structuredClone(v);

describe('sign / verify', () => {
  it('uses the frozen domain', () => {
    expect(MEMBERSHIP_DOMAIN).toBe('meshdrop-membership-v1');
  });

  it('round-trips and signs canonical JSON under the membership domain', () => {
    const f = fixture();
    const s = signList(f.list, f.root);
    expect(s.list).toEqual(f.list);
    expect(verifyDomain(MEMBERSHIP_DOMAIN, canonicalJson(s.list), s.sig, f.rootPub)).toBe(true);
    expect(verifySigned(s, f.rootPub)).toEqual(f.list);
  });

  it('signList refuses an invalid list', () => {
    const f = fixture();
    f.list.members.push(clone(f.list.members[1]!));
    expect(() => signList(f.list, f.root)).toThrow(MembershipError);
  });

  it('rejects a tampered member alias', () => {
    const f = fixture();
    const s = signList(f.list, f.root);
    const t = clone(s);
    t.list.members[1]!.alias = 'Mallory';
    expect(() => verifySigned(t, f.rootPub)).toThrow(MembershipError);
  });

  it('rejects tampering with version, revoked and hub urls', () => {
    const f = fixture();
    const s = signList(f.list, f.root);
    for (const mut of [
      (l: MembershipList) => void (l.version += 1),
      (l: MembershipList) => void l.revoked.push({ deviceId: hex32(), revokedAt: 1 }),
      (l: MembershipList) => void l.hub.urls.push('https://evil.example:1'),
    ]) {
      const t = clone(s);
      mut(t.list);
      expect(() => verifySigned(t, f.rootPub)).toThrow(MembershipError);
    }
  });

  it('rejects a list signed by a different root key', () => {
    const f = fixture();
    const other = newKey();
    // Same mesh id (the real root's), but signed by someone else.
    const forged = { list: f.list, sig: signDomain(MEMBERSHIP_DOMAIN, canonicalJson(f.list), other.privateKey) };
    expect(() => verifySigned(forged, f.rootPub)).toThrow(MembershipError);
    // Foreign root with its own mesh id, checked against our anchor.
    const g = fixture();
    expect(() => verifySigned(signList(g.list, g.root), f.rootPub)).toThrow(MembershipError);
  });

  it('rejects a list whose mesh field does not equal the anchor hash', () => {
    const f = fixture();
    const l = clone(f.list);
    l.mesh = hex32();
    // validly signed by the anchor key, but names another mesh
    const s = { list: l, sig: signDomain(MEMBERSHIP_DOMAIN, canonicalJson(l), f.root) };
    expect(() => verifySigned(s, f.rootPub)).toThrow(/mesh/);
  });

  it('rejects a validly signed but invalid list', () => {
    const f = fixture();
    const l = clone(f.list);
    l.members[1]!.role = 'hub';
    const s = { list: l, sig: signDomain(MEMBERSHIP_DOMAIN, canonicalJson(l), f.root) };
    expect(() => verifySigned(s, f.rootPub)).toThrow(/invalid list: hub/);
  });

  it('rejects a signature made under another domain', () => {
    const f = fixture();
    const s = { list: f.list, sig: signDomain('meshdrop-other-v1', canonicalJson(f.list), f.root) };
    expect(() => verifySigned(s, f.rootPub)).toThrow(MembershipError);
  });

  it('throws MembershipError (never TypeError) on garbage input', () => {
    const f = fixture();
    for (const bad of [null, undefined, 1, 'x', {}, { list: null, sig: 'AA==' }, { list: f.list }, { list: f.list, sig: 5 }, { list: f.list, sig: '' }]) {
      expect(() => verifySigned(bad as never, f.rootPub), JSON.stringify(bad)).toThrow(MembershipError);
    }
  });

  it('rejects a non-P-256 anchor', () => {
    const f = fixture();
    const s = signList(f.list, f.root);
    const ed = generateKeyPairSync('ed25519').publicKey;
    expect(() => verifySigned(s, ed)).toThrow(MembershipError);
  });
});

describe('validateList', () => {
  it('accepts a valid list and returns an equal copy', () => {
    const f = fixture();
    const out = validateList(f.list);
    expect(out).toEqual(f.list);
    expect(out).not.toBe(f.list);
  });

  it('accepts exactly 256 members, rejects 257', () => {
    const f = fixture();
    const filler = (i: number): Member => ({
      deviceId: i.toString(16).padStart(64, '0'),
      alias: `m${i}`,
      publicKeyPem: f.list.members[1]!.publicKeyPem,
      role: 'member',
      addedAt: 1,
    });
    f.list.members = [f.list.members[0]!, ...Array.from({ length: 255 }, (_, i) => filler(i))];
    expect(f.list.members).toHaveLength(256);
    expect(() => validateList(f.list)).not.toThrow();
    f.list.members.push(filler(1000));
    expect(() => validateList(f.list)).toThrow(/256/);
  });

  const rejects: [string, (l: MembershipList) => unknown][] = [
    ['two hub-role members', (l) => void (l.members[1]!.role = 'hub')],
    ['no hub-role member', (l) => void (l.members[0]!.role = 'member')],
    ['hub.deviceId is not the hub member', (l) => void (l.hub.deviceId = l.members[1]!.deviceId)],
    ['hub.deviceId is not a member at all', (l) => void (l.hub.deviceId = hex32())],
    ['duplicate deviceId', (l) => void (l.members[2]!.deviceId = l.members[1]!.deviceId)],
    ['uppercase hex deviceId', (l) => void (l.members[1]!.deviceId = l.members[1]!.deviceId.toUpperCase().replace(/^([0-9A-F])/, 'A'))],
    ['short deviceId', (l) => void (l.members[1]!.deviceId = 'abcd')],
    ['non-P-256 (ed25519) key', (l) => void (l.members[1]!.publicKeyPem = spkiPem(generateKeyPairSync('ed25519').publicKey))],
    ['non-P-256 (secp256k1) key', (l) => void (l.members[1]!.publicKeyPem = spkiPem(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey))],
    ['private key in publicKeyPem', (l) => void (l.members[1]!.publicKeyPem = newKey().privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)],
    ['garbage key', (l) => void (l.members[1]!.publicKeyPem = 'nope')],
    ['revoked id that is also a member', (l) => void l.revoked.push({ deviceId: l.members[1]!.deviceId, revokedAt: 5 })],
    ['duplicate revoked id', (l) => void l.revoked.push({ deviceId: 'a'.repeat(64), revokedAt: 1 }, { deviceId: 'a'.repeat(64), revokedAt: 2 })],
    ['version 0', (l) => void (l.version = 0)],
    ['fractional version', (l) => void (l.version = 1.5)],
    ['string version', (l) => void ((l as unknown as Record<string, unknown>).version = '2')],
    ['v != 1', (l) => void ((l as unknown as Record<string, unknown>).v = 2)],
    ['bad mesh id', (l) => void (l.mesh = 'xyz')],
    ['unknown field', (l) => void ((l as unknown as Record<string, unknown>).extra = 1)],
    ['unknown member field', (l) => void ((l.members[1] as unknown as Record<string, unknown>).admin = true)],
    ['bad role', (l) => void ((l.members[1] as unknown as Record<string, unknown>).role = 'root')],
    ['non-string alias', (l) => void ((l.members[1] as unknown as Record<string, unknown>).alias = 7)],
    ['non-integer addedAt', (l) => void (l.members[1]!.addedAt = 1.5)],
    ['hub.urls not strings', (l) => void ((l.hub as unknown as Record<string, unknown>).urls = [1])],
    ['members not an array', (l) => void ((l as unknown as Record<string, unknown>).members = {})],
    ['revoked entry malformed', (l) => void l.revoked.push({ deviceId: 'zz', revokedAt: 1 })],
  ];
  for (const [name, mut] of rejects) {
    it(`rejects: ${name}`, () => {
      const f = fixture();
      mut(f.list);
      expect(() => validateList(f.list)).toThrow(MembershipError);
    });
  }

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 3, 'x', [], true]) expect(() => validateList(bad)).toThrow(MembershipError);
  });

  it('accepts revoked ids that are not members', () => {
    const f = fixture();
    f.list.revoked.push({ deviceId: hex32(), revokedAt: 1790000000500 });
    expect(validateList(f.list).revoked).toHaveLength(1);
  });
});

describe('root key', () => {
  it('is stable across calls, PKCS8 at hub/root-key.pem with mode 0600 in a 0700 dir', async () => {
    const home = tmp();
    expect(await hasRootKey(home)).toBe(false);
    const a = await loadOrCreateRootKey(home);
    expect(await hasRootKey(home)).toBe(true);
    const b = await loadOrCreateRootKey(home);
    expect(spkiSha256(createPublicKey(a))).toBe(spkiSha256(createPublicKey(b)));
    const file = join(home, 'hub', 'root-key.pem');
    expect(readFileSync(file, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'hub')).mode & 0o777).toBe(0o700);
    expect(a.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(a.type).toBe('private');
  });

  it('survives concurrent first calls with a single key', async () => {
    const home = tmp();
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateRootKey(home)));
    const ids = new Set(keys.map((k) => spkiSha256(createPublicKey(k))));
    expect(ids.size).toBe(1);
  });

  it('refuses (and does not overwrite) a corrupt or non-P-256 key file', async () => {
    const home = tmp();
    await loadOrCreateRootKey(home);
    const file = join(home, 'hub', 'root-key.pem');
    writeFileSync(file, 'garbage', { mode: 0o600 });
    await expect(loadOrCreateRootKey(home)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('garbage');
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(file, ed, { mode: 0o600 });
    await expect(loadOrCreateRootKey(home)).rejects.toThrow();
  });

  it('tightens a loose key file mode on load', async () => {
    const home = tmp();
    await loadOrCreateRootKey(home);
    const file = join(home, 'hub', 'root-key.pem');
    (await import('node:fs')).chmodSync(file, 0o644);
    await loadOrCreateRootKey(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('hasRootKey is false for a missing home', async () => {
    expect(await hasRootKey(join(tmp(), 'nope'))).toBe(false);
    expect(existsSync(join(tmp(), 'nope'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Frozen cross-engine vector: protocol/vectors/membership-v1.json
// ---------------------------------------------------------------------------------------------

const VECTOR_URL = new URL('../../../protocol/vectors/membership-v1.json', import.meta.url);

/** P-256 private key from its raw 32-byte scalar (PKCS#8 without the optional public key). */
function privFromScalar(dHex: string): KeyObject {
  const der = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'), Buffer.from(dHex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

const ROOT_SCALAR = '1f2e3d4c5b6a79887766554433221100ffeeddccbbaa99887766554433221101';
const HUB_SCALAR = '2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2b';
const LAPTOP_SCALAR = '3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3c';
const PHONE_SCALAR = '4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4d';

const NOTES = [
  'Frozen MeshDrop membership vector (v1). A second engine (Java) must reproduce `canonical` byte-for-byte from `list` and must accept `signatureB64`.',
  'signed message = UTF-8(domain) || 0x00 || UTF-8(canonical); domain is "meshdrop-membership-v1". Signature: ECDSA P-256 / SHA-256, DER, standard padded base64, verified against the root SPKI. ECDSA is randomised, so the stored signature is verified, not regenerated.',
  'list.mesh = lowercase hex SHA-256 of the root SPKI DER (rootSpkiDerHex) = meshId. Member deviceIds here are arbitrary 64-hex values (real ones are SHA-256 of the device certificate DER).',
  'Validity rules (validateList): v==1; mesh 64 lowercase hex; version integer >= 1; hub.deviceId equals the single member with role "hub"; deviceIds 64 lowercase hex and unique; each publicKeyPem is a canonical EC P-256 SPKI PEM; no revoked id in members; revoked ids unique; at most 256 members; no unknown fields.',
];

function buildList(): { list: MembershipList; root: KeyObject; rootSpki: Buffer } {
  const root = privFromScalar(ROOT_SCALAR);
  const rootPub = createPublicKey(root);
  const mk = (scalar: string, deviceId: string, alias: string, role: Member['role'], addedAt: number): Member => ({
    deviceId,
    alias,
    publicKeyPem: spkiPem(createPublicKey(privFromScalar(scalar))),
    role,
    addedAt,
  });
  const hub = mk(HUB_SCALAR, '11'.repeat(32), 'Home Hub', 'hub', 1790000000000);
  const list: MembershipList = {
    v: 1,
    mesh: spkiSha256(rootPub),
    version: 3,
    issuedAt: 1790000300000,
    hub: { deviceId: hub.deviceId, urls: ['https://192.168.1.10:53318', 'https://hub.example.net:443'] },
    members: [hub, mk(LAPTOP_SCALAR, '22'.repeat(32), 'Laptop ✓', 'member', 1790000100000), mk(PHONE_SCALAR, '33'.repeat(32), 'Phone', 'member', 1790000200000)],
    revoked: [{ deviceId: '44'.repeat(32), revokedAt: 1790000250000 }],
  };
  return { list, root, rootSpki: rootPub.export({ type: 'spki', format: 'der' }) };
}

interface MembershipVector {
  description: string[];
  domain: string;
  rootPrivateKeyScalarHex: string;
  rootSpkiDerHex: string;
  meshId: string;
  list: MembershipList;
  canonical: string;
  canonicalHex: string;
  signedMessageHex: string;
  signatureB64: string;
}

function compute(): MembershipVector {
  const { list, root, rootSpki } = buildList();
  const canonical = canonicalJson(list);
  return {
    description: NOTES,
    domain: MEMBERSHIP_DOMAIN,
    rootPrivateKeyScalarHex: ROOT_SCALAR,
    rootSpkiDerHex: rootSpki.toString('hex'),
    meshId: list.mesh,
    list,
    canonical,
    canonicalHex: Buffer.from(canonical, 'utf8').toString('hex'),
    signedMessageHex: Buffer.concat([Buffer.from(MEMBERSHIP_DOMAIN, 'utf8'), Buffer.from([0]), Buffer.from(canonical, 'utf8')]).toString('hex'),
    signatureB64: signList(list, root).sig,
  };
}

describe('frozen vector (membership-v1.json)', () => {
  if (process.env.UPDATE_VECTORS === '1') {
    it('regenerates membership-v1.json', () => {
      writeFileSync(VECTOR_URL, JSON.stringify(compute(), null, 2) + '\n');
      expect(existsSync(VECTOR_URL)).toBe(true);
    });
  }

  it('list and canonical bytes match byte-for-byte', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as MembershipVector;
    expect(canonicalJson(vec.list)).toBe(vec.canonical);
    expect(Buffer.from(vec.canonical, 'utf8').toString('hex')).toBe(vec.canonicalHex);
    const got = compute();
    expect({ ...got, signatureB64: '' }).toEqual({ ...vec, signatureB64: '' });
  });

  it('the stored signature verifies against the stored root, via verifySigned', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as MembershipVector;
    const rootPub = createPublicKey({ key: Buffer.from(vec.rootSpkiDerHex, 'hex'), format: 'der', type: 'spki' });
    expect(spkiSha256(rootPub)).toBe(vec.meshId);
    expect(verifyDomain(vec.domain, vec.canonical, vec.signatureB64, rootPub)).toBe(true);
    expect(verifySigned({ list: vec.list, sig: vec.signatureB64 }, rootPub)).toEqual(vec.list);
    const tampered = clone(vec.list);
    tampered.members[1]!.alias = 'Laptop';
    expect(() => verifySigned({ list: tampered, sig: vec.signatureB64 }, rootPub)).toThrow(MembershipError);
  });
});
