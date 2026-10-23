import { sign, type KeyObject } from 'node:crypto';

// Minimal DER encoder, just enough to emit a self-signed X.509 v3 certificate.
// The certificate DER is the root of device identity (deviceId = sha256(DER)), so the
// output must stay standard and byte-stable for a given key + serial + name.

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(content.length), content]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utcTime = (s: string): Buffer => tlv(0x17, Buffer.from(s, 'ascii'));
const generalizedTime = (s: string): Buffer => tlv(0x18, Buffer.from(s, 'ascii'));

/** Non-negative INTEGER from big-endian magnitude bytes (minimal form). */
function integer(magnitude: Buffer): Buffer {
  let i = 0;
  while (i < magnitude.length - 1 && magnitude[i] === 0) i++;
  let body = magnitude.subarray(i);
  if (body.length === 0) body = Buffer.from([0]);
  if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';

export interface SelfSignedCertOptions {
  publicKey: KeyObject;
  privateKey: KeyObject;
  commonName: string;
  /** Big-endian serial number bytes (treated as an unsigned integer). */
  serial: Buffer;
}

/** Builds a DER self-signed v3 certificate: ECDSA-with-SHA256, basicConstraints CA:false. */
export function buildSelfSignedCert(opts: SelfSignedCertOptions): Buffer {
  const sigAlg = seq(oid(OID_ECDSA_SHA256));
  const name = seq(set(seq(oid(OID_COMMON_NAME), utf8(opts.commonName))));
  // RFC 5280 4.1.2.5: UTCTime for dates through 2049, GeneralizedTime from 2050 (here: "no expiry").
  const validity = seq(utcTime('200101000000Z'), generalizedTime('99991231235959Z'));
  const spki = opts.publicKey.export({ type: 'spki', format: 'der' });
  // basicConstraints: critical, value = SEQUENCE {} (cA defaults to FALSE, so it is omitted in DER)
  const basicConstraints = seq(oid(OID_BASIC_CONSTRAINTS), bool(true), octets(seq()));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // version v3
    integer(opts.serial),
    sigAlg,
    name, // issuer
    validity,
    name, // subject (self-signed)
    spki,
    explicit(3, seq(basicConstraints)),
  );
  const signature = sign('sha256', tbs, opts.privateKey); // DER-encoded ECDSA-Sig-Value
  return seq(tbs, sigAlg, bitString(signature));
}
