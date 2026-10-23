/**
 * Canonical JSON and domain-separated ECDSA signatures for MeshDrop mesh messages.
 *
 * Everything signed in the mesh (membership lists, relay envelopes, invites) is the UTF-8 encoding
 * of `canonicalJson(value)`, so a second engine (the Java engine) must produce the exact same bytes.
 * Frozen vectors: protocol/vectors/canonical-v1.json.
 *
 * CANONICAL JSON RULES (v1)
 *  1. Output is a string; callers encode it as UTF-8 (no BOM) before hashing/signing.
 *  2. No whitespace anywhere: `{"a":1,"b":[2,3]}`.
 *  3. Objects: members are emitted in ascending order of their keys, compared by UTF-16 code units
 *     (the order of ECMAScript's default `Array.prototype.sort` on strings; Java `String.compareTo`).
 *     This is NOT code point order: U+1F600 (surrogates D83D DE00) sorts before U+FF5E.
 *     Keys are unique by construction; nested objects are canonicalised recursively.
 *     Only own enumerable string keys are used; symbol keys are ignored.
 *  4. Arrays: elements in their original order, each canonicalised. Holes (sparse arrays) are an error.
 *  5. Strings (values and keys): exactly the escaping of ECMAScript `JSON.stringify` (well-formed):
 *     wrap in `"`; escape `"` and `\` as `\"` `\\`; U+0008 U+000C U+000A U+000D U+0009 as
 *     `\b \f \n \r \t`; other code units below U+0020 as `\u00xx` (lowercase hex); lone
 *     surrogates as `\udxxx` (lowercase hex). Every other character (including U+007F, U+2028 and all
 *     non-ASCII) is emitted raw. `/` is not escaped.
 *  6. Numbers: only safe integers (|n| <= 2^53 - 1). Printed as plain decimal with optional leading
 *     `-`, no exponent, no leading zeros; negative zero prints as `0`. Fractions, NaN, +-Infinity and
 *     out-of-range integers are an error.
 *  7. `true`, `false`, `null` are literal.
 *  8. Anything else is an error: `undefined` (also as an object member value), functions, symbols,
 *     bigint, and non-plain objects (prototype other than Object.prototype or null: Buffer, Date,
 *     Map, Set, RegExp, typed arrays, class instances, boxed primitives). Cycles are an error and
 *     nesting deeper than MAX_DEPTH is an error.
 *
 * SIGNATURES
 *  ECDSA P-256 with SHA-256, DER encoded, transported as standard padded base64. The signed message is
 *  `utf8(domain) || 0x00 || payload`. `domain` is a non-empty label of printable ASCII (0x21-0x7E; no
 *  NUL, no space, no non-ASCII) WITHOUT a trailing NUL: the single 0x00 separator is inserted by
 *  signDomain/verifyDomain. Because a domain can never contain 0x00, the first 0x00 of the signed
 *  message always ends the domain, so (domain, payload) pairs cannot collide. `payload` is raw bytes
 *  (a string payload is taken as UTF-8). signDomain throws on a bad domain or a key that is not a
 *  private P-256 KeyObject; verifyDomain returns false for a bad domain or any public key that is not a
 *  P-256 (prime256v1) EC public KeyObject. Java: `Signature.getInstance("SHA256withECDSA")`.
 */
import { createHash, sign, verify, KeyObject } from 'node:crypto';

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

/** Maximum nesting depth accepted by canonicalJson. */
export const MAX_DEPTH = 64;

function isPlain(o: object): boolean {
  const p = Object.getPrototypeOf(o) as unknown;
  return p === Object.prototype || p === null;
}

function ser(v: unknown, depth: number, path: string, stack: Set<object>): string {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new CanonicalError(`${path}: number is not a safe integer`);
      return String(v === 0 ? 0 : v); // -0 -> "0"
    case 'object':
      break;
    default:
      throw new CanonicalError(`${path}: unsupported type ${typeof v}`);
  }
  if (v === null) return 'null';
  if (depth > MAX_DEPTH) throw new CanonicalError(`${path}: nested deeper than ${MAX_DEPTH}`);
  if (stack.has(v)) throw new CanonicalError(`${path}: cyclic structure`);
  stack.add(v);
  try {
    if (Array.isArray(v)) {
      const parts: string[] = [];
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) throw new CanonicalError(`${path}[${i}]: sparse array hole`);
        parts.push(ser(v[i], depth + 1, `${path}[${i}]`, stack));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlain(v)) throw new CanonicalError(`${path}: non-plain object`);
    const rec = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(rec).sort()) {
      parts.push(`${JSON.stringify(k)}:${ser(rec[k], depth + 1, `${path}.${k}`, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(v);
  }
}

/** Canonical JSON of `v` (see the rules in the file header). Throws CanonicalError on unsupported input. */
export function canonicalJson(v: unknown): string {
  return ser(v, 0, '$', new Set());
}

const DOMAIN_RE = /^[\x21-\x7e]+$/;

function validDomain(domain: unknown): domain is string {
  return typeof domain === 'string' && DOMAIN_RE.test(domain);
}

function isP256(key: unknown, type: 'public' | 'private'): key is KeyObject {
  return (
    key instanceof KeyObject &&
    key.type === type &&
    key.asymmetricKeyType === 'ec' &&
    key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
  );
}

function signedMessage(domain: string, payload: Buffer | string): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0]), typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload]);
}

/**
 * Base64 (standard, padded) DER ECDSA-P256/SHA-256 signature over `utf8(domain) || 0x00 || payload`.
 * Throws if `domain` is not non-empty printable ASCII (0x21-0x7E) or `key` is not a private P-256 KeyObject.
 */
export function signDomain(domain: string, payload: Buffer | string, key: KeyObject): string {
  if (!validDomain(domain)) throw new TypeError('signDomain: domain must be non-empty printable ASCII (0x21-0x7E)');
  if (!isP256(key, 'private')) throw new TypeError('signDomain: key must be a P-256 private KeyObject');
  return sign('sha256', signedMessage(domain, payload), key).toString('base64');
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Verify a signDomain signature. Returns false on any malformed input (bad domain, non-P-256 key...); never throws. */
export function verifyDomain(domain: string, payload: Buffer | string, sigB64: string, pub: KeyObject): boolean {
  try {
    if (!validDomain(domain) || typeof sigB64 !== 'string' || !B64.test(sigB64)) return false;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return false;
    if (!isP256(pub, 'public')) return false;
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length === 0) return false;
    return verify('sha256', signedMessage(domain, payload), pub, sig);
  } catch {
    return false;
  }
}

/** Lowercase hex SHA-256 of the public key's SPKI DER (the mesh id for the root key). */
export function spkiSha256(pub: KeyObject): string {
  return createHash('sha256').update(pub.export({ format: 'der', type: 'spki' })).digest('hex');
}
