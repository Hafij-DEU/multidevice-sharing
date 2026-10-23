import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CanonicalError, canonicalJson, signDomain, spkiSha256, verifyDomain } from '../src/mesh/canonical.ts';

describe('canonicalJson', () => {
  it('sorts keys recursively, no whitespace, JSON.stringify string escaping', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'é\n' }] })).toBe('{"a":[{"c":"é\\n","d":2}],"b":1}');
  });

  it('keeps array order and encodes scalars', () => {
    expect(canonicalJson([3, 1, 2, null, true, false, 'x'])).toBe('[3,1,2,null,true,false,"x"]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(-7)).toBe('-7');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalJson(Object.create(null, { k: { value: 1, enumerable: true } }))).toBe('{"k":1}');
  });

  it('sorts keys by UTF-16 code unit, not code point', () => {
    // U+FF5E (BMP) sorts after U+1F600 (surrogates D83D DE00) in UTF-16 order, before it in code-point order.
    expect(canonicalJson({ '～': 1, '\u{1f600}': 2, B: 3, a: 4 })).toBe('{"B":3,"a":4,"\u{1f600}":2,"～":1}');
  });

  it('escapes control chars and lone surrogates like JSON.stringify', () => {
    expect(canonicalJson('\u0000\u001f"\\\ud800')).toBe('"\\u0000\\u001f\\"\\\\\\ud800"');
  });

  it('rejects non-integers, unsafe integers and non-finite numbers', () => {
    for (const v of [1.5, 2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity]) {
      expect(() => canonicalJson(v)).toThrow(CanonicalError);
    }
    expect(() => canonicalJson({ a: [{ b: 0.1 }] })).toThrow(CanonicalError);
  });

  it('rejects undefined, functions, symbols, bigint (also nested)', () => {
    for (const v of [undefined, () => 1, Symbol('x'), 10n, { a: undefined }, [undefined], [() => 1], { a: { b: 1n } }]) {
      expect(() => canonicalJson(v)).toThrow(CanonicalError);
    }
    // sparse array holes are undefined too
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 3])).toThrow(CanonicalError);
  });

  it('rejects non-plain objects and cycles', () => {
    for (const v of [Buffer.from('x'), new Date(0), new Map(), new Set(), /x/, new Uint8Array(1), new (class A {})(), new Number(1)]) {
      expect(() => canonicalJson(v)).toThrow(CanonicalError);
    }
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(CanonicalError);
  });
});

function keyPair(): { priv: KeyObject; pub: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { priv: privateKey, pub: publicKey };
}

describe('signDomain / verifyDomain', () => {
  it('round trips for string and Buffer payloads', () => {
    const { priv, pub } = keyPair();
    const sig = signDomain('meshdrop/test\0', 'payload', priv);
    expect(typeof sig).toBe('string');
    expect(verifyDomain('meshdrop/test\0', 'payload', sig, pub)).toBe(true);
    expect(verifyDomain('meshdrop/test\0', Buffer.from('payload'), sig, pub)).toBe(true);
    expect(verifyDomain('meshdrop/test\0', Buffer.from('payload'), signDomain('meshdrop/test\0', Buffer.from('payload'), priv), pub)).toBe(true);
  });

  it('fails on flipped payload byte, other domain, other key', () => {
    const { priv, pub } = keyPair();
    const payload = Buffer.from('hello world');
    const sig = signDomain('d1', payload, priv);
    const flipped = Buffer.from(payload);
    flipped[3] = flipped[3]! ^ 1;
    expect(verifyDomain('d1', flipped, sig, pub)).toBe(false);
    expect(verifyDomain('d2', payload, sig, pub)).toBe(false);
    expect(verifyDomain('d1', payload, sig, keyPair().pub)).toBe(false);
  });

  it('domain/payload boundary is unambiguous (0x00 separator)', () => {
    const { priv, pub } = keyPair();
    const sig = signDomain('ab', 'c', priv);
    expect(verifyDomain('a', 'b\0c', sig, pub)).toBe(false);
    expect(verifyDomain('ab', 'c', sig, pub)).toBe(true);
  });

  it('returns false (never throws) on malformed input', () => {
    const { pub } = keyPair();
    for (const s of ['', '!!!not base64!!!', 'AAAA', 'MEUCIQ', Buffer.alloc(200, 1).toString('base64')]) {
      expect(verifyDomain('d', 'p', s, pub)).toBe(false);
    }
    expect(verifyDomain('d', 'p', undefined as unknown as string, pub)).toBe(false);
    expect(verifyDomain('d', 'p', 'AAAA', undefined as unknown as KeyObject)).toBe(false);
    expect(verifyDomain('d', undefined as unknown as string, 'AAAA', pub)).toBe(false);
  });

  it('signatures are DER-encoded (starts with 0x30 SEQUENCE)', () => {
    const { priv } = keyPair();
    const der = Buffer.from(signDomain('d', 'p', priv), 'base64');
    expect(der[0]).toBe(0x30);
    expect(der.length).toBeGreaterThanOrEqual(68);
    expect(der.length).toBeLessThanOrEqual(72);
  });
});

describe('spkiSha256', () => {
  it('is lowercase hex sha256 of SPKI DER', () => {
    const { pub } = keyPair();
    const h = spkiSha256(pub);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(spkiSha256(createPublicKey(pub.export({ format: 'pem', type: 'spki' })))).toBe(h);
    expect(spkiSha256(keyPair().pub)).not.toBe(h);
  });
});

// ---------------------------------------------------------------------------------------------
// Frozen cross-engine vectors: protocol/vectors/canonical-v1.json
// ---------------------------------------------------------------------------------------------

const VECTOR_URL = new URL('../../../protocol/vectors/canonical-v1.json', import.meta.url);

/** P-256 private key from its raw 32-byte scalar (PKCS#8 without the optional public key). */
function privFromScalar(dHex: string): KeyObject {
  const der = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'), Buffer.from(dHex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

const CASES: { name: string; input: unknown }[] = [
  { name: 'scalars-null', input: null },
  { name: 'scalars-true', input: true },
  { name: 'integer-negative', input: -42 },
  { name: 'integer-max-safe', input: Number.MAX_SAFE_INTEGER },
  { name: 'empty-object', input: {} },
  { name: 'empty-array', input: [] },
  { name: 'spec-example', input: { b: 1, a: [{ d: 2, c: 'é\n' }] } },
  { name: 'array-order-kept', input: [3, 1, 2, { z: 0, y: [] }] },
  { name: 'key-order-utf16', input: { '～': 1, '\u{1f600}': 2, B: 3, a: 4, '': 5, aa: 6, '10': 7, '9': 8 } },
  { name: 'escapes', input: { s: '"\\/\b\f\n\r\t\u0000\u001f\u007f  raw é €' } },
  { name: 'lone-surrogate', input: { s: '\ud800x\udc00' } },
  {
    name: 'membership-like',
    input: { v: 1, meshId: 'ab'.repeat(32), seq: 7, issuedAt: 1790000000000, devices: [{ id: '11'.repeat(32), name: 'Laptop ✓', role: 'member' }, { id: '22'.repeat(32), name: 'Phone', role: 'hub' }] },
  },
];

const SIGN_INPUT = {
  privateKeyScalarHex: '4b1e54cdaf25624ade1bc2bae65dfa0596aeac64bccb4370fd91c0c4daa80524',
  domain: 'meshdrop/v1/test\0',
  payloadValue: { b: 1, a: [{ d: 2, c: 'é\n' }] },
};

const NOTES = [
  'Frozen MeshDrop canonical JSON + domain-separated signature vector (v1). A second engine (Java) must reproduce every canonical string byte-for-byte and must accept the stored signature.',
  'canonicalJson: object keys sorted ascending by UTF-16 code unit (Java String.compareTo); no whitespace; strings escaped exactly like ECMAScript JSON.stringify (well-formed, lone surrogates as \\udXXX lowercase hex); integers only, safe range, plain decimal, -0 prints 0; arrays keep order; output is UTF-8.',
  'cases[].canonical is the expected canonical string; canonicalHex is its UTF-8 bytes.',
  'signature: ECDSA P-256 / SHA-256, DER, base64 (standard, padded) over UTF-8(domain) || 0x00 || payload. ECDSA is randomised, so the stored signature is verified, not regenerated. payload here is UTF-8 of canonicalJson(payloadValue). domain already includes its trailing NUL as the caller passes it; the 0x00 separator is added in addition.',
  'spkiSha256Hex = hex SHA-256 of the public key SPKI DER (spkiDerHex).',
];

interface VectorFile {
  description: string[];
  cases: { name: string; input: unknown; canonical: string; canonicalHex: string }[];
  signing: {
    privateKeyScalarHex: string;
    domain: string;
    payloadValue: unknown;
    payload: string;
    signedMessageHex: string;
    spkiDerHex: string;
    spkiSha256Hex: string;
    signatureB64: string;
  };
}

function compute(): VectorFile {
  const sk = privFromScalar(SIGN_INPUT.privateKeyScalarHex);
  const pub = createPublicKey(sk);
  const payload = canonicalJson(SIGN_INPUT.payloadValue);
  const spki = pub.export({ format: 'der', type: 'spki' });
  return {
    description: NOTES,
    cases: CASES.map((c) => {
      const canonical = canonicalJson(c.input);
      return { name: c.name, input: c.input, canonical, canonicalHex: Buffer.from(canonical, 'utf8').toString('hex') };
    }),
    signing: {
      ...SIGN_INPUT,
      payload,
      signedMessageHex: Buffer.concat([Buffer.from(SIGN_INPUT.domain, 'utf8'), Buffer.from([0]), Buffer.from(payload, 'utf8')]).toString('hex'),
      spkiDerHex: spki.toString('hex'),
      spkiSha256Hex: spkiSha256(pub),
      signatureB64: signDomain(SIGN_INPUT.domain, payload, sk),
    },
  };
}

describe('frozen vectors (canonical-v1.json)', () => {
  if (process.env.UPDATE_VECTORS === '1') {
    it('regenerates canonical-v1.json', () => {
      writeFileSync(VECTOR_URL, JSON.stringify(compute(), null, 2) + '\n');
      expect(existsSync(VECTOR_URL)).toBe(true);
    });
  }

  it('canonical strings match byte-for-byte', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile;
    expect(vec.cases.length).toBe(CASES.length);
    for (const c of vec.cases) {
      expect(canonicalJson(c.input), c.name).toBe(c.canonical);
      expect(Buffer.from(c.canonical, 'utf8').toString('hex'), c.name).toBe(c.canonicalHex);
    }
    // everything except the randomised signature is deterministic
    const got = compute();
    expect({ ...got, signing: { ...got.signing, signatureB64: '' } }).toEqual({ ...vec, signing: { ...vec.signing, signatureB64: '' } });
  });

  it('the stored signature verifies, and nothing else does', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile;
    const s = vec.signing;
    const pub = createPublicKey({ key: Buffer.from(s.spkiDerHex, 'hex'), format: 'der', type: 'spki' });
    expect(spkiSha256(pub)).toBe(s.spkiSha256Hex);
    expect(s.payload).toBe(canonicalJson(s.payloadValue));
    expect(verifyDomain(s.domain, s.payload, s.signatureB64, pub)).toBe(true);
    expect(verifyDomain(s.domain + 'x', s.payload, s.signatureB64, pub)).toBe(false);
    expect(verifyDomain(s.domain, s.payload + ' ', s.signatureB64, pub)).toBe(false);
  });
});
