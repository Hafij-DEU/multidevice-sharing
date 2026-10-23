import { createCipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, spkiSha256 } from '../src/mesh/canonical.ts';
import { MembershipError, signList, type Member, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import {
  MIN_PASSPHRASE_CHARS,
  RecoveryError,
  __exportRecoveryForTest,
  __importRecoveryForTest,
  exportRecovery,
  importRecovery,
} from '../src/mesh/recovery.ts';

const PASS = 'correct horse battery staple';

function spkiPem(pub: KeyObject): string {
  return pub.export({ type: 'spki', format: 'pem' }) as string;
}
function newKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function mkList(root: KeyObject): MembershipList {
  const hubKey = newKey().publicKey;
  const phoneKey = newKey().publicKey;
  const hubId = randomBytes(32).toString('hex');
  const member = (deviceId: string, alias: string, role: Member['role'], pub: KeyObject): Member => ({
    deviceId,
    alias,
    publicKeyPem: spkiPem(pub),
    role,
    addedAt: 1790000000000,
  });
  return {
    v: 1,
    mesh: spkiSha256(createPublicKey(root)),
    version: 2,
    issuedAt: 1790000300000,
    hub: { deviceId: hubId, urls: ['https://192.168.1.10:53318'] },
    members: [member(hubId, 'Hub', 'hub', hubKey), member(randomBytes(32).toString('hex'), 'Phone ✓', 'member', phoneKey)],
    revoked: [],
  };
}

function fixture(): { root: KeyObject; signed: SignedMembership } {
  const root = newKey().privateKey;
  return { root, signed: signList(mkList(root), root) };
}

// Weak (fast) parameters, usable only through the explicit test-only switch.
const WEAK = { N: 1024, r: 8, p: 1 };

/** Encrypts `plaintext` exactly as the recovery format does, with arbitrary KDF params (for crafting hostile files). */
function craft(plaintext: string, passphrase: string, kdf: { N: number; r: number; p: number }, over: Record<string, unknown> = {}): string {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { ...kdf, maxmem: 256 * 1024 ** 2 });
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from('meshdrop-recovery-v1', 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return JSON.stringify({
    v: 1,
    kdf: 'scrypt',
    ...kdf,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    ...over,
  });
}

function expectRecoveryError(fn: () => unknown, code?: string): RecoveryError {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RecoveryError);
  if (code) expect((err as RecoveryError).code).toBe(code);
  return err as RecoveryError;
}

describe('recovery file: round trip and format', () => {
  it('restores the same root key and the same membership', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    const out = importRecovery(text, PASS);
    expect(out.rootKey.type).toBe('private');
    expect(spkiSha256(createPublicKey(out.rootKey))).toBe(spkiSha256(createPublicKey(root)));
    expect(out.rootKey.export({ type: 'pkcs8', format: 'pem' })).toBe(root.export({ type: 'pkcs8', format: 'pem' }));
    expect(out.membership).toEqual(signed);
  });

  it('always writes the production KDF parameters, a 16-byte salt and a 12-byte nonce', () => {
    const { root, signed } = fixture();
    const f = JSON.parse(exportRecovery(root, signed, PASS)) as Record<string, unknown>;
    expect(Object.keys(f)).toEqual(['v', 'kdf', 'N', 'r', 'p', 'salt', 'nonce', 'ct']);
    expect(f).toMatchObject({ v: 1, kdf: 'scrypt', N: 131072, r: 8, p: 1 });
    expect(Buffer.from(f.salt as string, 'base64')).toHaveLength(16);
    expect(Buffer.from(f.nonce as string, 'base64')).toHaveLength(12);
  });

  it('uses a fresh salt and nonce every time', () => {
    const { root, signed } = fixture();
    const a = JSON.parse(exportRecovery(root, signed, PASS)) as { salt: string; nonce: string };
    const b = JSON.parse(exportRecovery(root, signed, PASS)) as { salt: string; nonce: string };
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('does not contain the key or the passphrase in the clear', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(PASS);
    expect(text).not.toContain('Phone');
  });
});

describe('recovery file: passphrase', () => {
  it('MIN_PASSPHRASE_CHARS is 10', () => {
    expect(MIN_PASSPHRASE_CHARS).toBe(10);
  });

  it('export rejects a 9-character passphrase and accepts exactly 10 characters', () => {
    const { root, signed } = fixture();
    expectRecoveryError(() => exportRecovery(root, signed, '123456789'), 'passphrase-too-short');
    expectRecoveryError(() => exportRecovery(root, signed, ''), 'passphrase-too-short');
    expect(() => __exportRecoveryForTest(root, signed, '1234567890', { scrypt: WEAK })).not.toThrow();
    // characters, not UTF-16 code units: 9 emoji are 18 code units but only 9 characters
    expectRecoveryError(() => exportRecovery(root, signed, '\u{1f600}'.repeat(9)), 'passphrase-too-short');
    expect(() => __exportRecoveryForTest(root, signed, '\u{1f600}'.repeat(10), { scrypt: WEAK })).not.toThrow();
  });

  it('a wrong passphrase throws RecoveryError(bad-passphrase-or-corrupt)', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    const e = expectRecoveryError(() => importRecovery(text, PASS + 'x'), 'bad-passphrase-or-corrupt');
    expect(e.message).toBe('bad-passphrase-or-corrupt');
  });

  it('error messages never contain the passphrase or key material', () => {
    const { root, signed } = fixture();
    const secret = 'sup3r-s3cret-pass-phrase!';
    const text = exportRecovery(root, signed, secret);
    const pem = (root.export({ type: 'pkcs8', format: 'pem' }) as string).split('\n')[1]!;
    const errs: RecoveryError[] = [
      expectRecoveryError(() => importRecovery(text, secret + '1')),
      expectRecoveryError(() => exportRecovery(root, signed, 'short')),
      expectRecoveryError(() => importRecovery(craft('{}', secret, WEAK), secret)),
    ];
    for (const e of errs) {
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain(pem);
      expect(String(e.stack)).not.toContain(secret);
    }
  });
});

describe('recovery file: tampering', () => {
  function mutate(text: string, f: (o: Record<string, unknown>) => void): string {
    const o = JSON.parse(text) as Record<string, unknown>;
    f(o);
    return JSON.stringify(o);
  }

  it('one flipped ct byte throws', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    const flipAt = (i: number) =>
      mutate(text, (o) => {
        const ct = Buffer.from(o.ct as string, 'base64');
        ct[i] = ct[i]! ^ 0x01;
        o.ct = ct.toString('base64');
      });
    expectRecoveryError(() => importRecovery(flipAt(0), PASS), 'bad-passphrase-or-corrupt');
    const len = Buffer.from((JSON.parse(text) as { ct: string }).ct, 'base64').length;
    expectRecoveryError(() => importRecovery(flipAt(len - 1), PASS), 'bad-passphrase-or-corrupt'); // inside the GCM tag
  });

  it('a flipped nonce or salt byte throws', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    for (const field of ['nonce', 'salt']) {
      const bad = mutate(text, (o) => {
        const b = Buffer.from(o[field] as string, 'base64');
        b[0] = b[0]! ^ 0x80;
        o[field] = b.toString('base64');
      });
      expectRecoveryError(() => importRecovery(bad, PASS), 'bad-passphrase-or-corrupt');
    }
  });

  it('a truncated ct throws', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    for (const n of [0, 5, 15]) {
      const bad = mutate(text, (o) => void (o.ct = Buffer.from(o.ct as string, 'base64').subarray(0, n).toString('base64')));
      expectRecoveryError(() => importRecovery(bad, PASS), 'bad-passphrase-or-corrupt');
    }
  });

  it('structurally malformed files throw RecoveryError', () => {
    const { root, signed } = fixture();
    const text = exportRecovery(root, signed, PASS);
    const bads: unknown[] = [
      'not json',
      '',
      '[]',
      'null',
      '"x"',
      mutate(text, (o) => void (o.v = 2)),
      mutate(text, (o) => void (o.kdf = 'pbkdf2')),
      mutate(text, (o) => void (o.extra = 1)),
      mutate(text, (o) => void delete o.nonce),
      mutate(text, (o) => void (o.salt = Buffer.alloc(15).toString('base64'))),
      mutate(text, (o) => void (o.nonce = Buffer.alloc(13).toString('base64'))),
      mutate(text, (o) => void (o.ct = 'not base64!!')),
      mutate(text, (o) => void (o.ct = 7)),
      mutate(text, (o) => void (o.N = '131072')),
      'x'.repeat(2 * 1024 * 1024),
      undefined,
      42,
    ];
    for (const b of bads) expectRecoveryError(() => importRecovery(b as string, PASS));
  });
});

describe('recovery file: KDF parameter floor and cap', () => {
  const plain = canonicalJson({ rootKeyPem: 'x', membership: {} });

  it('refuses attacker-chosen weak parameters in the production import, before running scrypt', () => {
    for (const kdf of [
      { N: 1024, r: 8, p: 1 },
      { N: 65536, r: 8, p: 1 },
      { N: 131072, r: 4, p: 1 },
      { N: 131072, r: 8, p: 0 },
    ]) {
      const t0 = Date.now();
      expectRecoveryError(() => importRecovery(craft(plain, PASS, kdf), PASS), 'bad-kdf-params');
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });

  it('refuses parameters above the cap and anything exceeding the memory budget, without allocating', () => {
    const base = JSON.parse(craft(plain, PASS, WEAK)) as Record<string, unknown>;
    for (const kdf of [
      { N: 2 ** 21, r: 8, p: 1 }, // above 2^20
      { N: 2 ** 20, r: 8, p: 1 }, // 1 GiB > 256 MiB budget
      { N: 2 ** 18, r: 8, p: 1 }, // over the memory budget
      { N: 131072, r: 16, p: 1 }, // over the memory budget
      { N: 131072, r: 8, p: 1000 }, // CPU DoS
      { N: 131073, r: 8, p: 1 }, // not a power of two
      { N: 131072.5, r: 8, p: 1 },
      { N: -131072, r: 8, p: 1 },
    ]) {
      const t0 = Date.now();
      const file = JSON.stringify({ ...base, ...kdf });
      expectRecoveryError(() => importRecovery(file, PASS), 'bad-kdf-params');
      expectRecoveryError(() => __importRecoveryForTest(file, PASS, { allowWeakKdf: true }), 'bad-kdf-params');
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });

  it('the test-only switch allows weak parameters; production import still refuses the same file', () => {
    const { root, signed } = fixture();
    const text = __exportRecoveryForTest(root, signed, PASS, { scrypt: WEAK });
    expect(JSON.parse(text)).toMatchObject({ N: 1024, r: 8, p: 1 });
    expectRecoveryError(() => importRecovery(text, PASS), 'bad-kdf-params');
    const out = __importRecoveryForTest(text, PASS, { allowWeakKdf: true });
    expect(out.membership).toEqual(signed);
  });
});

describe('recovery file: contents are verified', () => {
  const imp = (text: string) => __importRecoveryForTest(text, PASS, { allowWeakKdf: true });

  it('rejects a non-P-256 root key even when the file authenticates', () => {
    const { signed } = fixture();
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    for (const pem of [ed, p384, 'garbage']) {
      expectRecoveryError(() => imp(craft(canonicalJson({ rootKeyPem: pem, membership: signed }), PASS, WEAK)), 'invalid-contents');
    }
  });

  it('rejects a membership that was not signed by the root key in the file', () => {
    const { root } = fixture();
    const other = fixture(); // list for a different mesh, signed by a different key
    const text = craft(canonicalJson({ rootKeyPem: root.export({ type: 'pkcs8', format: 'pem' }), membership: other.signed }), PASS, WEAK);
    expectRecoveryError(() => imp(text), 'invalid-contents');
  });

  it('rejects a tampered membership signature or list', () => {
    const { root, signed } = fixture();
    const pem = root.export({ type: 'pkcs8', format: 'pem' }) as string;
    const badSig: SignedMembership = { ...signed, sig: Buffer.alloc(70, 1).toString('base64') };
    expectRecoveryError(() => imp(craft(canonicalJson({ rootKeyPem: pem, membership: badSig }), PASS, WEAK)), 'invalid-contents');
    const badList: SignedMembership = { ...signed, list: { ...signed.list, version: 99 } };
    expectRecoveryError(() => imp(craft(canonicalJson({ rootKeyPem: pem, membership: badList }), PASS, WEAK)), 'invalid-contents');
  });

  it('rejects plaintext of the wrong shape (non-JSON, extra or missing fields)', () => {
    const { root, signed } = fixture();
    const pem = root.export({ type: 'pkcs8', format: 'pem' }) as string;
    for (const pt of ['nope', '[]', canonicalJson({ rootKeyPem: pem }), canonicalJson({ rootKeyPem: pem, membership: signed, extra: 1 }), canonicalJson({ rootKeyPem: 1, membership: signed })]) {
      expectRecoveryError(() => imp(craft(pt, PASS, WEAK)), 'invalid-contents');
    }
  });

  it('export refuses a non-P-256 key and a membership that does not verify against the key', () => {
    const { root, signed } = fixture();
    expect(() => exportRecovery(generateKeyPairSync('ed25519').privateKey, signed, PASS)).toThrow();
    expect(() => exportRecovery(createPublicKey(root), signed, PASS)).toThrow();
    expect(() => exportRecovery(fixture().root, signed, PASS)).toThrow(MembershipError);
  });
});

// ---------------------------------------------------------------------------------------------
// Frozen cross-engine vector: protocol/vectors/recovery-v1.json
// ---------------------------------------------------------------------------------------------

const VECTOR_URL = new URL('../../../protocol/vectors/recovery-v1.json', import.meta.url);
const MEMBERSHIP_VECTOR_URL = new URL('../../../protocol/vectors/membership-v1.json', import.meta.url);

const VEC_PASSPHRASE = 'meshdrop recovery vector passphrase ✓';
const VEC_SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const VEC_NONCE = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');

const NOTES = [
  'Frozen MeshDrop recovery-file vector (v1). A second engine must decrypt `file` with `passphrase` to exactly `plaintext`, and must reproduce `file` byte-for-byte from the fixed `salt`/`nonce` (salt and nonce are random in real files).',
  'file = JSON {v:1,kdf:"scrypt",N,r,p,salt,nonce,ct}, keys in that order, no whitespace, base64 (standard, padded) for salt/nonce/ct. N=131072, r=8, p=1 (readers refuse N<131072, r<8, p<1, N>2^20 and anything over 256 MiB scrypt memory).',
  'key = scrypt(passphrase as UTF-8, salt, dkLen 32, N, r, p, maxmem 256 MiB). ct = AES-256-GCM(key, nonce 12 bytes, AAD = UTF-8("meshdrop-recovery-v1"), plaintext as UTF-8) as ciphertext || 16-byte tag.',
  'plaintext = canonical JSON (see canonical-v1.json) of {rootKeyPem, membership}: rootKeyPem is the PKCS#8 PEM of the P-256 mesh root private key; membership is the SignedMembership ({list, sig}) which must verify against the public key derived from rootKeyPem.',
  'Minimum passphrase length when writing: 10 characters (Unicode code points).',
];

interface RecoveryVector {
  description: string[];
  passphrase: string;
  saltHex: string;
  nonceHex: string;
  rootPrivateKeyScalarHex: string;
  rootKeyPem: string;
  membership: SignedMembership;
  plaintext: string;
  plaintextHex: string;
  scryptKeyHex: string;
  file: string;
}

function privFromScalar(dHex: string): KeyObject {
  const der = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'), Buffer.from(dHex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function computeVector(): RecoveryVector {
  // Reuse the frozen membership vector's list+signature (ECDSA is randomised, so we never re-sign).
  const m = JSON.parse(readFileSync(MEMBERSHIP_VECTOR_URL, 'utf8')) as { rootPrivateKeyScalarHex: string; list: MembershipList; signatureB64: string };
  const root = privFromScalar(m.rootPrivateKeyScalarHex);
  const membership: SignedMembership = { list: m.list, sig: m.signatureB64 };
  const rootKeyPem = root.export({ type: 'pkcs8', format: 'pem' }) as string;
  const plaintext = canonicalJson({ rootKeyPem, membership });
  const file = __exportRecoveryForTest(root, membership, VEC_PASSPHRASE, { salt: VEC_SALT, nonce: VEC_NONCE });
  return {
    description: NOTES,
    passphrase: VEC_PASSPHRASE,
    saltHex: VEC_SALT.toString('hex'),
    nonceHex: VEC_NONCE.toString('hex'),
    rootPrivateKeyScalarHex: m.rootPrivateKeyScalarHex,
    rootKeyPem,
    membership,
    plaintext,
    plaintextHex: Buffer.from(plaintext, 'utf8').toString('hex'),
    scryptKeyHex: scryptSync(VEC_PASSPHRASE, VEC_SALT, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }).toString('hex'),
    file,
  };
}

describe('frozen vector (recovery-v1.json)', () => {
  if (process.env.UPDATE_VECTORS === '1') {
    it('regenerates recovery-v1.json', () => {
      writeFileSync(VECTOR_URL, JSON.stringify(computeVector(), null, 2) + '\n');
      expect(existsSync(VECTOR_URL)).toBe(true);
    });
  }

  const vec = (): RecoveryVector => JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as RecoveryVector;

  it('decrypts to the expected plaintext (production parameters, public importRecovery)', () => {
    const v = vec();
    const out = importRecovery(v.file, v.passphrase);
    expect(out.rootKey.export({ type: 'pkcs8', format: 'pem' })).toBe(v.rootKeyPem);
    expect(out.membership).toEqual(v.membership);
    expect(canonicalJson({ rootKeyPem: v.rootKeyPem, membership: v.membership })).toBe(v.plaintext);
    expect(Buffer.from(v.plaintext, 'utf8').toString('hex')).toBe(v.plaintextHex);
  });

  it('is reproduced byte-for-byte from the fixed salt and nonce, and the key matches', () => {
    const v = vec();
    const root = privFromScalar(v.rootPrivateKeyScalarHex);
    expect(__exportRecoveryForTest(root, v.membership, v.passphrase, { salt: Buffer.from(v.saltHex, 'hex'), nonce: Buffer.from(v.nonceHex, 'hex') })).toBe(v.file);
    expect(scryptSync(v.passphrase, Buffer.from(v.saltHex, 'hex'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }).toString('hex')).toBe(v.scryptKeyHex);
    expect(JSON.parse(v.file)).toMatchObject({ v: 1, kdf: 'scrypt', N: 131072, r: 8, p: 1 });
  });

  it('wrong passphrase against the vector fails', () => {
    const v = vec();
    expectRecoveryError(() => importRecovery(v.file, v.passphrase + '!'), 'bad-passphrase-or-corrupt');
  });
});
