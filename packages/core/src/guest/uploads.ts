// What LAN guests send (M5a). A guest first offers (names, sizes, browser-made thumbnails, text);
// nothing is stored until the owner accepts. Accepted files are uploaded in slices at exact offsets
// (so a cut upload resumes where it stopped), kept in partialDir, and moved into the inbox under a
// free name once complete. Reject or end: partial data is deleted and further writes get 410.
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { safeRelPath, uniqueName } from '../sanitize.ts';

export const MAX_GUEST_FILES = 1000;
export const MAX_GUEST_TEXT = 64 * 1024;
export const MAX_GUEST_THUMB = 48 * 1024;
export const MAX_GUEST_SLICE = 4 * 1024 * 1024;
export const MAX_GUEST_PENDING = 4;

const THUMB_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const TYPE_RE = /^[\x21-\x7e][\x20-\x7e]{0,127}$/;

export class GuestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.name = 'GuestError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface GuestFile { name: string; size: number; type?: string; thumb?: string }

export type GuestEvent =
  | { type: 'guest-offer'; id: string; files: GuestFile[]; text?: string }
  | { type: 'guest-file'; id: string; path: string }
  | { type: 'guest-received'; id: string; files: string[]; text?: string }
  | { type: 'guest-rejected'; id: string };

export type GuestStatus = 'pending' | 'accepted' | 'rejected' | 'done';

interface Offer {
  id: string;
  status: GuestStatus;
  files: (GuestFile & { rel: string; received: number; path?: string })[];
  text?: string;
  /** Serializes writes to one offer (one file at a time keeps offsets exact). */
  lock: Promise<unknown>;
}

const bad = (): never => {
  throw new GuestError(400, 'bad-offer');
};

function parseOffer(b: unknown): { files: Offer['files']; text?: string } {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) bad();
  const o = b as Record<string, unknown>;
  const files = o.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_GUEST_FILES) bad();
  let text: string | undefined;
  if (o.text !== undefined) {
    if (typeof o.text !== 'string' || Buffer.byteLength(o.text) > MAX_GUEST_TEXT) bad();
    if ((o.text as string).length > 0) text = o.text as string;
  }
  const out: Offer['files'] = [];
  for (const f of files as unknown[]) {
    if (typeof f !== 'object' || f === null) bad();
    const x = f as Record<string, unknown>;
    if (typeof x.name !== 'string' || !Number.isSafeInteger(x.size) || (x.size as number) < 0) bad();
    let rel: string;
    try {
      rel = safeRelPath(x.name as string);
    } catch {
      return bad();
    }
    if (rel === '') bad();
    const g: Offer['files'][number] = { name: x.name as string, size: x.size as number, rel, received: 0 };
    if (x.type !== undefined) {
      if (typeof x.type !== 'string' || !TYPE_RE.test(x.type)) bad();
      g.type = x.type as string;
    }
    if (x.thumb !== undefined) {
      if (typeof x.thumb !== 'string' || x.thumb.length > MAX_GUEST_THUMB || !THUMB_RE.test(x.thumb)) bad();
      g.thumb = x.thumb as string;
    }
    out.push(g);
  }
  if (out.length === 0 && text === undefined) bad();
  return text !== undefined ? { files: out, text } : { files: out };
}

async function readSlice(body: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > MAX_GUEST_SLICE) throw new GuestError(413, 'too-large');
    parts.push(b);
  }
  return Buffer.concat(parts);
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

export class GuestUploads {
  readonly #offers = new Map<string, Offer>();
  readonly partialDir: string;
  readonly inboxRoot: string;
  readonly onEvent: (e: GuestEvent) => void;

  constructor(partialDir: string, inboxRoot: string, onEvent: (e: GuestEvent) => void) {
    this.partialDir = partialDir;
    this.inboxRoot = inboxRoot;
    this.onEvent = onEvent;
  }

  #get(id: string): Offer {
    const o = typeof id === 'string' ? this.#offers.get(id) : undefined;
    if (!o) throw new GuestError(404, 'not-found');
    return o;
  }

  #emit(e: GuestEvent): void {
    try {
      this.onEvent(e);
    } catch {
      /* a failing listener must not break an upload */
    }
  }

  offer(body: unknown): { id: string; status: 'pending' } {
    const { files, text } = parseOffer(body);
    let pending = 0;
    for (const o of this.#offers.values()) if (o.status === 'pending') pending++;
    if (pending >= MAX_GUEST_PENDING) throw new GuestError(429, 'too-many');
    const id = randomBytes(12).toString('base64url');
    const o: Offer = { id, status: 'pending', files, lock: Promise.resolve(), ...(text !== undefined ? { text } : {}) };
    this.#offers.set(id, o);
    const view = files.map(({ name, size, type, thumb }) => ({ name, size, ...(type ? { type } : {}), ...(thumb ? { thumb } : {}) }));
    this.#emit({ type: 'guest-offer', id, files: view, ...(text !== undefined ? { text } : {}) });
    return { id, status: 'pending' };
  }

  /** Offers waiting for the owner's answer (for the accept prompt). */
  pending(): { id: string; files: GuestFile[]; text?: string }[] {
    return [...this.#offers.values()]
      .filter((o) => o.status === 'pending')
      .map((o) => ({ id: o.id, files: o.files.map(({ name, size, type, thumb }) => ({ name, size, ...(type ? { type } : {}), ...(thumb ? { thumb } : {}) })), ...(o.text !== undefined ? { text: o.text } : {}) }));
  }

  status(id: string): { status: GuestStatus; files: { name: string; size: number; received: number }[] } {
    const o = this.#get(id);
    return { status: o.status, files: o.files.map((f) => ({ name: f.name, size: f.size, received: f.received })) };
  }

  async accept(id: string): Promise<void> {
    const o = this.#get(id);
    if (o.status !== 'pending') throw new GuestError(409, o.status);
    o.status = 'accepted';
    await fsp.mkdir(join(this.partialDir, id), { recursive: true });
    for (const [i, f] of o.files.entries()) if (f.size === 0) await this.#complete(o, i);
    await this.#maybeDone(o);
  }

  async reject(id: string): Promise<void> {
    const o = this.#get(id);
    if (o.status === 'done' || o.status === 'rejected') return;
    o.status = 'rejected';
    await fsp.rm(join(this.partialDir, id), { recursive: true, force: true });
    this.#emit({ type: 'guest-rejected', id });
  }

  /** The session ended: every unfinished offer is dropped with its partial data. */
  async cancelAll(): Promise<void> {
    for (const o of this.#offers.values()) if (o.status === 'pending' || o.status === 'accepted') await this.reject(o.id);
  }

  /** Writes one slice at `offset` (which must equal what is stored so far); returns the new total. */
  write(id: string, fileIdx: number, offset: number, body: Readable): Promise<number> {
    const o = this.#get(id);
    const run = o.lock.then(() => this.#write(o, fileIdx, offset, body));
    o.lock = run.catch(() => {});
    return run;
  }

  async #write(o: Offer, fileIdx: number, offset: number, body: Readable): Promise<number> {
    if (o.status === 'rejected') throw new GuestError(410, 'rejected');
    if (o.status === 'pending') throw new GuestError(409, 'not-accepted');
    const f = Number.isSafeInteger(fileIdx) && fileIdx >= 0 ? o.files[fileIdx] : undefined;
    if (!f) throw new GuestError(404, 'not-found');
    if (f.path !== undefined) return f.received; // complete already (a repeated last slice)
    if (offset !== f.received) throw new GuestError(409, 'offset', { received: f.received });
    const data = await readSlice(body);
    if (o.status !== 'accepted') throw new GuestError(410, 'rejected'); // rejected while reading
    if (f.received + data.length > f.size) throw new GuestError(400, 'too-large');
    const part = join(this.partialDir, o.id, String(fileIdx));
    const fh = await fsp.open(part, f.received === 0 ? 'w' : 'r+');
    try {
      await fh.write(data, 0, data.length, f.received);
    } finally {
      await fh.close();
    }
    f.received += data.length;
    if (f.received === f.size) {
      await this.#complete(o, fileIdx);
      await this.#maybeDone(o);
    }
    return f.received;
  }

  async #complete(o: Offer, i: number): Promise<void> {
    const f = o.files[i]!;
    const dir = join(this.inboxRoot, dirname(f.rel));
    await fsp.mkdir(dir, { recursive: true });
    const name = await uniqueName(dir, basename(f.rel));
    const dest = join(dir, name);
    if (f.size === 0) await fsp.writeFile(dest, Buffer.alloc(0), { flag: 'wx' });
    else await moveFile(join(this.partialDir, o.id, String(i)), dest);
    f.path = dest;
    this.#emit({ type: 'guest-file', id: o.id, path: dest });
  }

  async #maybeDone(o: Offer): Promise<void> {
    if (o.status !== 'accepted' || o.files.some((f) => f.path === undefined)) return;
    o.status = 'done';
    await fsp.rm(join(this.partialDir, o.id), { recursive: true, force: true });
    this.#emit({ type: 'guest-received', id: o.id, files: o.files.map((f) => f.path!), ...(o.text !== undefined ? { text: o.text } : {}) });
  }
}
