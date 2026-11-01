// Quick Share's messages, by field number (Nearby Connections "offline" frames and the Nearby Sharing
// frames carried inside them). Only what a one-shot file/text transfer over the LAN needs is here.
import { randomBytes } from 'node:crypto';
import { Fields, Writer } from './proto.ts';

// OfflineFrame.V1Frame.FrameType
export const F_CONNECTION_REQUEST = 1;
export const F_CONNECTION_RESPONSE = 2;
export const F_PAYLOAD_TRANSFER = 3;
export const F_BANDWIDTH_UPGRADE = 4;
export const F_KEEP_ALIVE = 5;
export const F_DISCONNECTION = 6;

// PayloadHeader.PayloadType
export const P_BYTES = 1;
export const P_FILE = 2;
export const LAST_CHUNK = 1;

// Sharing V1Frame.FrameType
export const S_INTRODUCTION = 1;
export const S_RESPONSE = 2;
export const S_PAIRED_KEY_ENCRYPTION = 3;
export const S_PAIRED_KEY_RESULT = 4;
export const S_CANCEL = 6;

// Sharing ConnectionResponseFrame.Status
export const R_ACCEPT = 1;
export const R_REJECT = 2;
export const R_NOT_ENOUGH_SPACE = 3;
export const R_UNSUPPORTED = 4;
export const R_TIMED_OUT = 5;

const MEDIUM_WIFI_LAN = 5;
const OS_LINUX = 100;
const PAIRED_KEY_UNABLE = 3;

function offline(type: number, field: number, body: Writer): Buffer {
  return new Writer().int(1, 1).msg(2, new Writer().int(1, type).msg(field, body)).done();
}

export function connectionRequest(endpointId: string, name: string, info: Buffer): Buffer {
  return offline(F_CONNECTION_REQUEST, 2, new Writer().str(1, endpointId).str(2, name).int(5, MEDIUM_WIFI_LAN).bytes(6, info));
}

export function connectionResponse(): Buffer {
  return offline(F_CONNECTION_RESPONSE, 3, new Writer().int(1, 0).int(3, 1).msg(4, new Writer().int(1, OS_LINUX)));
}

export function keepAlive(ack: boolean): Buffer {
  return offline(F_KEEP_ALIVE, 6, new Writer().int(1, ack));
}

export function disconnection(): Buffer {
  return offline(F_DISCONNECTION, 7, new Writer());
}

export interface Chunk {
  id: bigint;
  type: number;
  totalSize: number;
  fileName?: string;
  flags: number;
  offset: number;
  body: Buffer;
}

export function payloadTransfer(c: Omit<Chunk, 'body'> & { body?: Buffer }): Buffer {
  const header = new Writer().int(1, c.id).int(2, c.type).int(3, c.totalSize).int(4, false).str(5, c.fileName);
  const chunk = new Writer().int(1, c.flags).int(2, c.offset).bytes(3, c.body);
  return offline(F_PAYLOAD_TRANSFER, 4, new Writer().int(1, 1).msg(2, header).msg(3, chunk));
}

/** A parsed OfflineFrame: its type and the V1 frame's fields. */
export function parseOffline(b: Buffer): { type: number; v1: Fields } {
  const f = new Fields(b);
  const v1 = f.msg(2);
  if (!v1) throw new Error('not a v1 offline frame');
  return { type: v1.int(1) ?? 0, v1 };
}

export function parseChunk(v1: Fields): Chunk | null {
  const pt = v1.msg(4);
  if (!pt || (pt.int(1) ?? 1) !== 1) return null; // only DATA packets; control messages (cancel) end the transfer elsewhere
  const h = pt.msg(2);
  const c = pt.msg(3);
  if (!h || !c) return null;
  return {
    id: h.big(1) ?? 0n,
    type: h.int(2) ?? 0,
    totalSize: h.int(3) ?? 0,
    ...(h.str(5) !== undefined ? { fileName: h.str(5)! } : {}),
    flags: c.int(1) ?? 0,
    offset: c.int(2) ?? 0,
    body: c.bytes(3) ?? Buffer.alloc(0),
  };
}

/** PayloadTransfer with a CONTROL packet: the peer cancelled or failed this payload. */
export function isControl(v1: Fields): boolean {
  return (v1.msg(4)?.int(1) ?? 1) === 2;
}

// ---- Nearby Sharing frames (each travels as one BYTES payload) ------------------------------------------

function sharing(type: number, field?: number, body?: Writer): Buffer {
  const v1 = new Writer().int(1, type);
  if (field !== undefined && body) v1.msg(field, body);
  return new Writer().int(1, 1).msg(2, v1).done();
}

export function pairedKeyEncryption(): Buffer {
  return sharing(S_PAIRED_KEY_ENCRYPTION, 4, new Writer().bytes(1, randomBytes(72)).bytes(2, randomBytes(6)));
}

export function pairedKeyResult(): Buffer {
  return sharing(S_PAIRED_KEY_RESULT, 5, new Writer().int(1, PAIRED_KEY_UNABLE));
}

export function sharingResponse(status: number): Buffer {
  return sharing(S_RESPONSE, 3, new Writer().int(1, status));
}

export function cancel(): Buffer {
  return sharing(S_CANCEL);
}

export interface FileMeta {
  name: string;
  size: number;
  payloadId: bigint;
  mime: string;
  kind: number;
}

export interface TextMeta {
  title: string;
  size: number;
  payloadId: bigint;
  kind: number;
}

export function introduction(files: FileMeta[], texts: TextMeta[]): Buffer {
  const body = new Writer();
  for (const f of files) {
    body.msg(1, new Writer().str(1, f.name).int(2, f.kind).int(3, f.payloadId).int(4, f.size).str(5, f.mime).int(6, randomId()));
  }
  for (const t of texts) body.msg(2, new Writer().str(2, t.title).int(3, t.kind).int(4, t.payloadId).int(5, t.size).int(6, randomId()));
  return sharing(S_INTRODUCTION, 2, body);
}

export interface Sharing {
  type: number;
  files: FileMeta[];
  texts: TextMeta[];
  /** S_RESPONSE: the status. */
  status?: number;
}

export function parseSharing(b: Buffer): Sharing {
  const v1 = new Fields(b).msg(2);
  if (!v1) throw new Error('not a v1 sharing frame');
  const type = v1.int(1) ?? 0;
  const out: Sharing = { type, files: [], texts: [] };
  if (type === S_INTRODUCTION) {
    const intro = v1.msg(2);
    for (const f of intro?.msgs(1) ?? []) {
      out.files.push({ name: f.str(1) ?? 'file', kind: f.int(2) ?? 0, payloadId: f.big(3) ?? 0n, size: f.int(4) ?? 0, mime: f.str(5) ?? 'application/octet-stream' });
    }
    for (const t of intro?.msgs(2) ?? []) out.texts.push({ title: t.str(2) ?? '', kind: t.int(3) ?? 0, payloadId: t.big(4) ?? 0n, size: t.int(5) ?? 0 });
  } else if (type === S_RESPONSE) {
    const s = v1.msg(3)?.int(1);
    if (s !== undefined) out.status = s;
  }
  return out;
}

/** A random positive int64 (payload and metadata ids). */
export function randomId(): bigint {
  return randomBytes(8).readBigUInt64BE() >> 1n;
}

// ---- endpoint info (who a device is: its name and kind) --------------------------------------------------

export const DEVICE_UNKNOWN = 0;
export const DEVICE_PHONE = 1;
export const DEVICE_TABLET = 2;
export const DEVICE_LAPTOP = 3;

/** Longest prefix of `s` that fits in `max` UTF-8 bytes, cut between code points. */
function cut(s: string, max: number): Buffer {
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return Buffer.from(out, 'utf8');
}

/** Byte 0: version (3 bits), visibility (1), device type (3), reserved (1); 16 random bytes; name length; name. */
export function endpointInfo(name: string, deviceType: number): Buffer {
  const n = cut(name, 150); // keeps the base64 TXT value under 255 bytes
  return Buffer.concat([Buffer.from([(deviceType & 7) << 1]), randomBytes(16), Buffer.from([n.length]), n]);
}

export function parseEndpointInfo(b: Buffer | undefined): { name?: string; deviceType: number } {
  if (!b || b.length < 1) return { deviceType: DEVICE_UNKNOWN };
  const deviceType = (b[0]! >> 1) & 7;
  if (b.length < 18) return { deviceType };
  const len = b[17]!;
  if (b.length < 18 + len) return { deviceType };
  return { name: b.subarray(18, 18 + len).toString('utf8'), deviceType };
}

// FileMetadata.Type
export const K_UNKNOWN = 0;
export const K_IMAGE = 1;
export const K_VIDEO = 2;
export const K_APP = 3;
export const K_AUDIO = 4;
export const K_DOCUMENT = 5;

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function mimeOf(name: string): { mime: string; kind: number } {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const mime = MIME[ext] ?? 'application/octet-stream';
  const kind = mime.startsWith('image/') ? K_IMAGE : mime.startsWith('video/') ? K_VIDEO : mime.startsWith('audio/') ? K_AUDIO
    : ext === 'apk' ? K_APP : mime === 'application/octet-stream' ? K_UNKNOWN : K_DOCUMENT;
  return { mime, kind };
}
