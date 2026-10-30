// LocalSend protocol v2 (M6), receiving side: LocalSend users on the LAN are untrusted, so every send
// waits for the owner (prepare-upload is answered only after Accept, or 403). One session at a time.
//   POST /api/localsend/v2/register        {device info} -> our info
//   GET  /api/localsend/v2/info            our info
//   POST /api/localsend/v2/prepare-upload  {info, files:{id:{id,fileName,size,fileType,preview?}}} -> {sessionId, files:{id:token}} | 204 | 403 | 409
//   POST /api/localsend/v2/upload?sessionId&fileId&token   raw bytes
//   POST /api/localsend/v2/cancel?sessionId
// A message (text/* with a preview) is received from the preview; nothing is uploaded for it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ensureDir, land } from '../guest/uploads.ts';
import { safeRelPath } from '../sanitize.ts';

const LS_PREFIX = '/api/localsend/v2/';
const MAX_JSON = 1024 * 1024;
const MAX_FILES = 1000;
const MAX_TEXT = 64 * 1024;

export interface LsInfo {
  alias: string;
  version: string;
  deviceModel?: string | null;
  deviceType?: string | null;
  fingerprint: string;
  port?: number;
  protocol?: 'http' | 'https';
  download?: boolean;
}

export interface LsPeer { alias: string; fingerprint: string; deviceModel?: string; deviceType?: string }

export type LsEvent =
  | { type: 'offer'; id: string; from: LsPeer; files: { name: string; size: number; type?: string }[]; text?: string }
  | { type: 'received'; id: string; from: LsPeer; files: string[]; text?: string }
  | { type: 'rejected' | 'cancelled'; id: string; from: LsPeer }
  | { type: 'register'; info: LsInfo; address: string };

interface LsFile { id: string; rel: string; name: string; size: number; type?: string; token: string; path?: string; text?: string }
interface Session {
  id: string;
  from: LsPeer;
  files: LsFile[];
  text?: string;
  state: 'pending' | 'accepted' | 'rejected' | 'done' | 'cancelled';
  answer: (ok: boolean) => void;
}

class LsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);

function peerOf(info: unknown): LsPeer {
  const i = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
  const alias = str(i.alias, 128);
  const fingerprint = str(i.fingerprint, 256);
  if (!alias || !fingerprint) throw new LsError(400, 'invalid device info');
  return { alias, fingerprint, ...(str(i.deviceModel, 128) ? { deviceModel: i.deviceModel as string } : {}), ...(str(i.deviceType, 32) ? { deviceType: i.deviceType as string } : {}) };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_JSON) throw new LsError(413, 'too large');
    parts.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new LsError(400, 'invalid json');
  }
}

export interface LocalSendReceiverOptions {
  self: () => LsInfo;
  partialDir: string;
  inboxRoot: string;
  onEvent: (e: LsEvent) => void;
  /** How long a sender waits for the owner's answer (default 120 s). */
  answerTimeoutMs?: number;
  /** False while receiving is paused: offers get 403. */
  accepting?: () => boolean;
}

export class LocalSendReceiver {
  readonly #o: LocalSendReceiverOptions;
  #session: Session | null = null;

  constructor(o: LocalSendReceiverOptions) {
    this.#o = o;
  }

  #emit(e: LsEvent): void {
    try {
      this.#o.onEvent(e);
    } catch {
      /* a failing listener must not break a transfer */
    }
  }

  has(id: string): boolean {
    return this.#session?.id === id;
  }

  pending(): { id: string; alias: string; files: { name: string; size: number; type?: string }[]; text?: string }[] {
    const s = this.#session;
    if (!s || s.state !== 'pending') return [];
    return [{ id: s.id, alias: s.from.alias, files: s.files.filter((f) => f.text === undefined).map((f) => ({ name: f.name, size: f.size, ...(f.type ? { type: f.type } : {}) })), ...(s.text !== undefined ? { text: s.text } : {}) }];
  }

  accept(id: string): void {
    if (this.#session?.id === id && this.#session.state === 'pending') this.#session.answer(true);
  }

  reject(id: string): void {
    if (this.#session?.id === id && this.#session.state === 'pending') this.#session.answer(false);
  }

  async #drop(s: Session, state: 'cancelled' | 'rejected'): Promise<void> {
    if (this.#session === s) this.#session = null;
    s.state = state;
    await fsp.rm(join(this.#o.partialDir, s.id), { recursive: true, force: true });
    this.#emit({ type: state, id: s.id, from: s.from });
  }

  /** Handles /api/localsend/v2/*; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'https://ls');
    if (!url.pathname.startsWith(LS_PREFIX)) return false;
    const route = url.pathname.slice(LS_PREFIX.length);
    const json = (status: number, v?: unknown) => {
      if (v === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      const b = Buffer.from(JSON.stringify(v));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
    };
    const run = async () => {
      const m = req.method ?? 'GET';
      if ((route === 'info' && m === 'GET') || (route === 'register' && m === 'POST')) {
        if (route === 'register') {
          const info = (await readJson(req)) as LsInfo;
          peerOf(info);
          this.#emit({ type: 'register', info, address: req.socket.remoteAddress ?? '' });
        }
        return json(200, this.#o.self());
      }
      if (route === 'prepare-upload' && m === 'POST') return this.#prepare(req, res, json);
      if (route === 'upload' && m === 'POST') return this.#upload(req, url, json);
      if (route === 'cancel' && m === 'POST') {
        const s = this.#session;
        if (s && s.id === url.searchParams.get('sessionId')) {
          if (s.state === 'pending') s.answer(false);
          await this.#drop(s, 'cancelled');
        }
        return json(200);
      }
      return json(404, { message: 'not found' });
    };
    run().catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      json(e instanceof LsError ? e.status : 500, { message: e instanceof LsError ? e.message : 'internal error' });
    });
    return true;
  }

  async #prepare(req: IncomingMessage, res: ServerResponse, json: (s: number, v?: unknown) => void): Promise<void> {
    if (this.#o.accepting?.() === false) throw new LsError(403, 'not receiving');
    const body = (await readJson(req)) as { info?: unknown; files?: unknown };
    const from = peerOf(body.info);
    if (typeof body.files !== 'object' || body.files === null || Array.isArray(body.files)) throw new LsError(400, 'invalid files');
    const entries = Object.entries(body.files as Record<string, unknown>);
    if (entries.length === 0 || entries.length > MAX_FILES) throw new LsError(400, 'invalid files');
    const files: LsFile[] = [];
    const texts: string[] = [];
    for (const [key, v] of entries) {
      const f = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
      const name = str(f.fileName, 1024);
      const size = f.size;
      if (!name || !Number.isSafeInteger(size) || (size as number) < 0 || key.length > 128) throw new LsError(400, 'invalid file');
      let rel: string;
      try {
        rel = safeRelPath(name);
      } catch {
        throw new LsError(400, 'invalid file name');
      }
      if (rel === '' || rel.split('/')[0]!.toLowerCase() === '.meshdrop-partial') throw new LsError(400, 'invalid file name');
      const type = str(f.fileType, 128);
      const preview = str(f.preview, MAX_TEXT);
      const isText = preview !== undefined && (type ?? '').startsWith('text/');
      if (isText) texts.push(preview);
      files.push({ id: key, rel, name, size: size as number, token: randomBytes(16).toString('base64url'), ...(type ? { type } : {}), ...(isText ? { text: preview } : {}) });
    }
    if (this.#session && (this.#session.state === 'pending' || this.#session.state === 'accepted')) throw new LsError(409, 'blocked by another session');
    let answer!: (ok: boolean) => void;
    const answered = new Promise<boolean>((r) => (answer = r));
    const s: Session = { id: randomBytes(12).toString('base64url'), from, files, state: 'pending', answer, ...(texts.length ? { text: texts.join('\n\n') } : {}) };
    this.#session = s;
    this.#emit({ type: 'offer', id: s.id, from, files: files.filter((f) => f.text === undefined).map((f) => ({ name: f.name, size: f.size, ...(f.type ? { type: f.type } : {}) })), ...(s.text !== undefined ? { text: s.text } : {}) });
    const timer = setTimeout(() => answer(false), this.#o.answerTimeoutMs ?? 120_000);
    const gone = () => answer(false); // the sender gave up waiting
    res.once('close', gone);
    const ok = await answered;
    clearTimeout(timer);
    res.removeListener('close', gone);
    if (!ok || s.state !== 'pending') {
      if (s.state === 'pending') await this.#drop(s, 'rejected');
      throw new LsError(403, 'rejected');
    }
    s.state = 'accepted';
    const uploads = files.filter((f) => f.text === undefined);
    if (uploads.length === 0) {
      await this.#finish(s);
      return json(204);
    }
    await fsp.mkdir(join(this.#o.partialDir, s.id), { recursive: true });
    for (const f of uploads) if (f.size === 0) await this.#landFile(s, f);
    if (uploads.every((f) => f.path !== undefined)) {
      await this.#finish(s);
      return json(204);
    }
    json(200, { sessionId: s.id, files: Object.fromEntries(uploads.filter((f) => f.path === undefined).map((f) => [f.id, f.token])) });
  }

  async #upload(req: IncomingMessage, url: URL, json: (s: number, v?: unknown) => void): Promise<void> {
    const s = this.#session;
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!s || s.state !== 'accepted' || !same(s.id, sid)) throw new LsError(403, 'invalid session');
    const f = s.files.find((x) => x.id === url.searchParams.get('fileId') && x.text === undefined);
    if (!f || !same(f.token, url.searchParams.get('token') ?? '')) throw new LsError(403, 'invalid token');
    if (f.path !== undefined) throw new LsError(409, 'already received');
    const part = join(this.#o.partialDir, s.id, f.id.replace(/[^A-Za-z0-9_-]/g, '_'));
    const fh = await fsp.open(part, 'w');
    let n = 0;
    try {
      for await (const c of req) {
        n += (c as Buffer).length;
        if (n > f.size) throw new LsError(400, 'more data than announced');
        if (s.state !== 'accepted') throw new LsError(403, 'cancelled');
        await fh.write(c as Buffer);
      }
    } finally {
      await fh.close();
    }
    if (n !== f.size) {
      await fsp.rm(part, { force: true });
      throw new LsError(400, 'incomplete file');
    }
    await this.#landFile(s, f, part);
    if (s.files.every((x) => x.text !== undefined || x.path !== undefined)) await this.#finish(s);
    json(200);
  }

  async #landFile(s: Session, f: LsFile, part?: string): Promise<void> {
    const p = part ?? join(this.#o.partialDir, s.id, '_empty');
    if (!part) await fsp.writeFile(p, Buffer.alloc(0));
    const parts = f.rel.split('/');
    const base = parts.pop()!;
    f.path = await land(p, await ensureDir(this.#o.inboxRoot, parts), base);
  }

  async #finish(s: Session): Promise<void> {
    s.state = 'done';
    if (this.#session === s) this.#session = null;
    await fsp.rm(join(this.#o.partialDir, s.id), { recursive: true, force: true });
    this.#emit({ type: 'received', id: s.id, from: s.from, files: s.files.filter((f) => f.path).map((f) => f.path!), ...(s.text !== undefined ? { text: s.text } : {}) });
  }
}
