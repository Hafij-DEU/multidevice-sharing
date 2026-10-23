// Relay envelopes (protocol v1): one receiver-API request or response carried over the hub link.
//
// The sending device signs the header (which binds the body by its SHA-256), so the hub can route
// and store envelopes but cannot forge or alter them.
//   sig   = signDomain('meshdrop-envelope-v1', canonicalJson(header without sig), senderKey)
//   frame = u32be(len(H)) || H || body,  H = utf8(canonicalJson(header))
import { createHash, type KeyObject } from 'node:crypto';
import { canonicalJson, signDomain, verifyDomain } from './canonical.ts';

export const ENVELOPE_DOMAIN = 'meshdrop-envelope-v1';
export const MAX_HEADER_BYTES = 16384;

export interface EnvelopeHeader {
  v: 1;
  kind: 'req' | 'res';
  /** 16 random bytes, base64url without padding (22 chars); a res repeats its req's id. */
  id: string;
  from: string;
  to: string;
  method?: string;
  path?: string;
  status?: number;
  contentType?: string;
  bodySha256: string;
  /** Held delivery only: total bytes the sender will upload for this session (on the offer). */
  holdBytes?: number;
  sig: string;
}

export interface Envelope {
  header: EnvelopeHeader;
  body: Buffer;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const METHODS = new Set(['GET', 'POST', 'PUT']);
/** Path segments are [A-Za-z0-9_-]+ only: no dots (so no '..'), no query, no encoding tricks. */
const PATH_RE = /^\/mesh\/v1\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const CONTENT_TYPE_RE = /^[\x21-\x7e][\x20-\x7e]{0,127}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const KEYS = new Set(['v', 'kind', 'id', 'from', 'to', 'method', 'path', 'status', 'contentType', 'bodySha256', 'holdBytes', 'sig']);

const bad = (why: string): never => {
  throw new EnvelopeError(`invalid envelope: ${why}`);
};

/** Validates every header field; `sig` is required unless `signed` is false. */
function checkHeader(h: unknown, signed: boolean): asserts h is EnvelopeHeader {
  if (typeof h !== 'object' || h === null || Array.isArray(h)) bad('header is not an object');
  const o = h as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) bad(`unknown field ${JSON.stringify(k).slice(0, 40)}`);
  if (o.v !== 1) bad('v');
  if (o.kind !== 'req' && o.kind !== 'res') bad('kind');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) bad('id');
  if (typeof o.from !== 'string' || !DEVICE_ID_RE.test(o.from)) bad('from');
  if (typeof o.to !== 'string' || !DEVICE_ID_RE.test(o.to)) bad('to');
  if (typeof o.bodySha256 !== 'string' || !HEX64_RE.test(o.bodySha256)) bad('bodySha256');
  if (o.contentType !== undefined && (typeof o.contentType !== 'string' || !CONTENT_TYPE_RE.test(o.contentType))) bad('contentType');
  if (o.holdBytes !== undefined && (!Number.isSafeInteger(o.holdBytes) || (o.holdBytes as number) < 0)) bad('holdBytes');
  if (o.kind === 'req') {
    if (typeof o.method !== 'string' || !METHODS.has(o.method)) bad('method');
    if (typeof o.path !== 'string' || !PATH_RE.test(o.path)) bad('path');
    if (o.status !== undefined) bad('status on a req');
  } else {
    if (!Number.isInteger(o.status) || (o.status as number) < 100 || (o.status as number) > 599) bad('status');
    if (o.method !== undefined || o.path !== undefined || o.holdBytes !== undefined) bad('req fields on a res');
  }
  if (signed) {
    if (typeof o.sig !== 'string' || !B64_RE.test(o.sig) || o.sig.length > 200) bad('sig');
  } else if (o.sig !== undefined) {
    bad('sig');
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function sealEnvelope(h: Omit<EnvelopeHeader, 'sig' | 'bodySha256'>, body: Buffer, key: KeyObject): Envelope {
  const unsigned = { ...h, bodySha256: sha256(body) };
  checkHeader(unsigned, false);
  const sig = signDomain(ENVELOPE_DOMAIN, canonicalJson(unsigned), key);
  return { header: { ...unsigned, sig }, body };
}

/** Verifies an envelope and returns its header; throws EnvelopeError on anything wrong. */
export function openEnvelope(e: Envelope, pubOf: (id: string) => KeyObject | undefined): EnvelopeHeader {
  checkHeader(e.header, true);
  const { sig, ...unsigned } = e.header;
  const pub = pubOf(unsigned.from);
  if (!pub) bad('unknown sender');
  if (!verifyDomain(ENVELOPE_DOMAIN, canonicalJson(unsigned), sig, pub!)) bad('bad signature');
  if (sha256(e.body) !== unsigned.bodySha256) bad('body hash mismatch');
  return e.header;
}

export function encodeFrame(e: Envelope): Buffer {
  const head = Buffer.from(canonicalJson(e.header), 'utf8');
  if (head.length > MAX_HEADER_BYTES) bad('header too long');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, e.body]);
}

/** Parses a frame; the header is shape-checked here and must still go through openEnvelope. */
export function decodeFrame(buf: Buffer): Envelope {
  if (buf.length < 4) bad('truncated frame');
  const len = buf.readUInt32BE(0);
  if (len > MAX_HEADER_BYTES) bad('header too long');
  if (buf.length < 4 + len) bad('truncated frame');
  let header: unknown;
  try {
    header = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  } catch {
    return bad('header is not JSON');
  }
  checkHeader(header, true);
  return { header, body: buf.subarray(4 + len) };
}

/** Remembers envelope ids for `ttlMs` (bounded to `max` entries, oldest evicted first). */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(max = 10_000, ttlMs = 600_000, now: () => number = Date.now) {
    this.#max = max;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get size(): number {
    return this.#seen.size;
  }

  /** True if `id` was seen within the TTL; otherwise records it and returns false. */
  seen(id: string): boolean {
    const now = this.#now();
    for (const [k, t] of this.#seen) {
      if (now - t <= this.#ttlMs) break; // insertion order = time order
      this.#seen.delete(k);
    }
    const t = this.#seen.get(id);
    if (t !== undefined && now - t <= this.#ttlMs) return true;
    this.#seen.delete(id);
    this.#seen.set(id, now);
    while (this.#seen.size > this.#max) {
      const oldest = this.#seen.keys().next().value as string;
      this.#seen.delete(oldest);
    }
    return false;
  }
}
