/**
 * Passphrase-encrypted recovery file for the mesh root key and the signed membership list.
 *
 * A reinstalled hub that loads this file gets the same root key, hence the same mesh id, and every
 * device keeps trusting it. Frozen vector: protocol/vectors/recovery-v1.json.
 *
 * FILE FORMAT (v1): UTF-8 JSON text, exactly these members in this order, no whitespace:
 *   {"v":1,"kdf":"scrypt","N":131072,"r":8,"p":1,"salt":<b64>,"nonce":<b64>,"ct":<b64>}
 *   base64 is standard and padded; salt is 16 random bytes, nonce is 12 random bytes.
 *   key        = scrypt(utf8(NFC(passphrase)), salt, dkLen 32, N, r, p, maxmem 256 MiB)
 *                The passphrase is Unicode-normalized with NFC (RFC 8265 OpaqueString style) before UTF-8
 *                encoding, on both write and read, so "café" typed as NFC (macOS/Linux/Windows differ) or
 *                NFD unlocks the same file. A passphrase that is not well-formed Unicode (lone surrogate)
 *                is refused: RecoveryError('bad-passphrase-format') on write, and on read it is treated
 *                as 'bad-passphrase-or-corrupt'. MIN_PASSPHRASE_CHARS counts code points after NFC.
 *   ct         = AES-256-GCM(key, nonce, AAD = utf8("meshdrop-recovery-v1"), plaintext) as ciphertext || 16-byte tag
 *   plaintext  = utf8(canonicalJson({rootKeyPem, membership}))
 *                rootKeyPem = PKCS#8 PEM of the EC P-256 root private key; membership = SignedMembership.
 *
 * READER RULES (importRecovery)
 *  - The reader takes N/r/p from the file but accepts exactly N = 131072, r = 8 and p in 1..4
 *    (production writes p = 1). Anything else, in particular lower values (an attacker-crafted file
 *    must not silently force a weak KDF) or higher ones (memory / CPU DoS), is refused with
 *    'bad-kdf-params' BEFORE scrypt runs. Higher N/r are refused by the 256 MiB memory budget anyway.
 *  - Input larger than 1 MiB is refused (a real file is well under 100 KiB).
 *  - A wrong passphrase and any tampering are indistinguishable (GCM failure) and throw
 *    RecoveryError('bad-passphrase-or-corrupt'). After authentication the root key must be an EC P-256
 *    private key and the membership must verify against the PUBLIC key derived from that root key,
 *    otherwise RecoveryError('invalid-contents').
 *  - Error messages are fixed codes; they never contain the passphrase or key bytes.
 *
 * The scrypt parameters, salt and nonce can only be overridden through the clearly named
 * `__exportRecoveryForTest` / `__importRecoveryForTest`; the public exportRecovery always writes
 * N=131072, r=8, p=1 with a random salt and nonce, and importRecovery always enforces the floor.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, KeyObject, randomBytes, scryptSync } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { verifySigned, type SignedMembership } from './membership.ts';

/** Minimum passphrase length (Unicode code points) accepted when writing a recovery file. */
export const MIN_PASSPHRASE_CHARS = 10;

export type RecoveryErrorCode = 'bad-passphrase-or-corrupt' | 'passphrase-too-short' | 'bad-passphrase-format' | 'bad-kdf-params' | 'invalid-contents';

/** Thrown for every recovery file failure. `message === code`; it never contains secrets. */
export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  constructor(code: RecoveryErrorCode) {
    super(code);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

const AAD = Buffer.from('meshdrop-recovery-v1', 'utf8');
const PROD_N = 131072;
const PROD_R = 8;
const PROD_P = 1;
const MAX_N = 2 ** 20;
const MAX_P = 4;
const MAXMEM = 256 * 1024 ** 2;
const MAX_FILE_CHARS = 1024 * 1024;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const FILE_KEYS = ['v', 'kdf', 'N', 'r', 'p', 'salt', 'nonce', 'ct'];

interface Kdf {
  N: number;
  r: number;
  p: number;
}

/** Test-only knobs for the export side. Never reachable from the public exportRecovery. */
export interface RecoveryExportTestParams {
  scrypt?: Kdf;
  salt?: Buffer;
  nonce?: Buffer;
}

/** Test-only knob for the import side: lifts the production N/r/p floor (the cap still applies). */
export interface RecoveryImportTestParams {
  allowWeakKdf?: boolean;
}

function isP256(key: KeyObject, type: 'public' | 'private'): boolean {
  return key.type === type && key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

function isPow2(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0 && n <= MAX_N;
}

/**
 * Throws bad-kdf-params unless the parameters are acceptable. Production: exactly N=131072, r=8, p in 1..4.
 * Test mode (`weakOk`): any power-of-two N <= 2^20, r 1..64, p 1..4, still within the memory budget.
 */
function checkKdf(k: Kdf, weakOk: boolean): void {
  const { N, r, p } = k;
  const bad = (): never => {
    throw new RecoveryError('bad-kdf-params');
  };
  if (!Number.isInteger(r) || !Number.isInteger(p) || p < 1 || p > MAX_P) bad();
  if (weakOk) {
    if (!isPow2(N) || r < 1 || r > 64) bad();
  } else if (N !== PROD_N || r !== PROD_R) {
    bad();
  }
  if (128 * r * (N + 2 + p) > MAXMEM) bad();
}

/** NFC-normalized passphrase; null when it is not well-formed Unicode. */
function normalizePassphrase(passphrase: unknown): string | null {
  // String.prototype.isWellFormed (Node >= 20) is newer than this project's TS lib target.
  if (typeof passphrase !== 'string' || !(passphrase as string & { isWellFormed(): boolean }).isWellFormed()) return null;
  return passphrase.normalize('NFC');
}

function deriveKey(passphrase: string, salt: Buffer, k: Kdf): Buffer {
  try {
    return scryptSync(passphrase, salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: MAXMEM });
  } catch {
    throw new RecoveryError('bad-kdf-params');
  }
}

function encrypt(rootKey: KeyObject, s: SignedMembership, passphrase: string, t: RecoveryExportTestParams): string {
  const pass = normalizePassphrase(passphrase);
  if (pass === null) throw new RecoveryError('bad-passphrase-format');
  if ([...pass].length < MIN_PASSPHRASE_CHARS) throw new RecoveryError('passphrase-too-short');
  if (!(rootKey instanceof KeyObject) || !isP256(rootKey, 'private')) throw new TypeError('exportRecovery: rootKey must be a P-256 private KeyObject');
  // Refuse to write a file that importRecovery would reject: the list must verify against this root key.
  const list = verifySigned(s, createPublicKey(rootKey));
  const kdf = t.scrypt ?? { N: PROD_N, r: PROD_R, p: PROD_P };
  checkKdf(kdf, t.scrypt !== undefined);
  const salt = t.salt ?? randomBytes(SALT_LEN);
  const nonce = t.nonce ?? randomBytes(NONCE_LEN);
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN) throw new TypeError('exportRecovery: salt must be 16 bytes and nonce 12 bytes');
  const plaintext = canonicalJson({ rootKeyPem: rootKey.export({ type: 'pkcs8', format: 'pem' }), membership: { list, sig: s.sig } });
  const key = deriveKey(pass, salt, kdf);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return JSON.stringify({
    v: 1,
    kdf: 'scrypt',
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
  });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Strict standard-padded base64 decode of exactly `len` bytes (or at least `min` when `len` is undefined); null if not canonical. */
function b64(v: unknown, len: number | undefined, min: number): Buffer | null {
  if (typeof v !== 'string') return null;
  const b = Buffer.from(v, 'base64');
  if (b.toString('base64') !== v) return null;
  if (len !== undefined ? b.length !== len : b.length < min) return null;
  return b;
}

function decrypt(text: string, passphrase: string, weakOk: boolean): { rootKey: KeyObject; membership: SignedMembership } {
  const corrupt = (): never => {
    throw new RecoveryError('bad-passphrase-or-corrupt');
  };
  const pass = normalizePassphrase(passphrase);
  if (typeof text !== 'string' || pass === null || text.length > MAX_FILE_CHARS) return corrupt();
  let f: unknown;
  try {
    f = JSON.parse(text);
  } catch {
    return corrupt();
  }
  if (!isObj(f)) return corrupt();
  const keys = Object.keys(f);
  if (keys.length !== FILE_KEYS.length || !FILE_KEYS.every((k) => keys.includes(k))) return corrupt();
  if (f.v !== 1 || f.kdf !== 'scrypt') return corrupt();
  if (typeof f.N !== 'number' || typeof f.r !== 'number' || typeof f.p !== 'number') return corrupt();
  const salt = b64(f.salt, SALT_LEN, 0);
  const nonce = b64(f.nonce, NONCE_LEN, 0);
  const ct = b64(f.ct, undefined, TAG_LEN);
  if (!salt || !nonce || !ct) return corrupt();

  const kdf: Kdf = { N: f.N, r: f.r, p: f.p };
  checkKdf(kdf, weakOk); // before any key derivation

  const key = deriveKey(pass, salt, kdf);
  let plain: string;
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(AAD);
    d.setAuthTag(ct.subarray(ct.length - TAG_LEN));
    plain = Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_LEN)), d.final()]).toString('utf8');
  } catch {
    return corrupt();
  }

  // The file authenticated; now the contents must be a P-256 root key and a list it signed.
  const invalid = (): never => {
    throw new RecoveryError('invalid-contents');
  };
  let body: unknown;
  try {
    body = JSON.parse(plain);
  } catch {
    return invalid();
  }
  if (!isObj(body) || Object.keys(body).length !== 2 || typeof body.rootKeyPem !== 'string' || !('membership' in body)) return invalid();
  let rootKey: KeyObject;
  try {
    rootKey = createPrivateKey(body.rootKeyPem);
  } catch {
    return invalid();
  }
  if (!isP256(rootKey, 'private')) return invalid();
  const m = body.membership as SignedMembership;
  try {
    const list = verifySigned(m, createPublicKey(rootKey));
    return { rootKey, membership: { list, sig: m.sig } };
  } catch {
    return invalid();
  }
}

/**
 * Encrypts the root key and the signed membership list under `passphrase` (>= MIN_PASSPHRASE_CHARS
 * characters after NFC). Always scrypt N=131072, r=8, p=1. Throws RecoveryError('passphrase-too-short' | 'bad-passphrase-format'), TypeError for a
 * key that is not a P-256 private key, MembershipError if `s` does not verify against `rootKey`.
 */
export function exportRecovery(rootKey: KeyObject, s: SignedMembership, passphrase: string): string {
  return encrypt(rootKey, s, passphrase, {});
}

/**
 * Decrypts a recovery file. Throws RecoveryError (see the file header for the codes); never leaks the
 * passphrase or key bytes. Returns the root private key and the verified membership.
 */
export function importRecovery(text: string, passphrase: string): { rootKey: KeyObject; membership: SignedMembership } {
  return decrypt(text, passphrase, false);
}

/** TEST ONLY: exportRecovery with explicit scrypt parameters, salt and nonce (frozen vectors, fast tests). */
export function __exportRecoveryForTest(rootKey: KeyObject, s: SignedMembership, passphrase: string, t: RecoveryExportTestParams): string {
  return encrypt(rootKey, s, passphrase, t);
}

/** TEST ONLY: importRecovery that can accept weak scrypt parameters. */
export function __importRecoveryForTest(text: string, passphrase: string, t: RecoveryImportTestParams): { rootKey: KeyObject; membership: SignedMembership } {
  return decrypt(text, passphrase, t.allowWeakKdf === true);
}
