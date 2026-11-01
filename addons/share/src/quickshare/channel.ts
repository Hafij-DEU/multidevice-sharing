// The encrypted part of a Quick Share connection: keep-alives, payload reassembly, and the Nearby
// Sharing frames that travel as small BYTES payloads.
import { open } from 'node:fs/promises';
import type { Framed } from './conn.ts';
import {
  F_DISCONNECTION, F_KEEP_ALIVE, F_PAYLOAD_TRANSFER, LAST_CHUNK, P_BYTES, P_FILE, disconnection, isControl, keepAlive,
  parseChunk, parseOffline, parseSharing, payloadTransfer, randomId, type Chunk, type Sharing,
} from './frames.ts';
import type { SecureChannel } from './secure.ts';

/** Largest BYTES payload taken in (sharing frames and shared text). */
export const MAX_BYTES = 4 * 1024 * 1024;
export const FILE_CHUNK = 512 * 1024;
const KEEP_ALIVE_MS = 10_000;
const IDLE_MS = 60_000;

export class ChannelError extends Error {}

export interface ChannelHooks {
  /** A FILE payload chunk; throw to drop the connection. */
  onFile?: (c: Chunk) => Promise<void>;
  /** A finished BYTES payload; return true when it was shared text, not a sharing frame. */
  onText?: (id: bigint, data: Buffer) => boolean;
}

export class Channel {
  readonly #framed: Framed;
  readonly #secure: SecureChannel;
  readonly #hooks: ChannelHooks;
  readonly #bytes = new Map<bigint, { parts: Buffer[]; got: number; total: number }>();
  readonly #sharing: Sharing[] = [];
  readonly #waiters: { resolve: (s: Sharing) => void; reject: (e: Error) => void }[] = [];
  #error: Error | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** Settles when the read loop ends: resolves on a clean disconnection, rejects on any failure. */
  readonly done: Promise<void>;

  constructor(framed: Framed, secure: SecureChannel, hooks: ChannelHooks = {}) {
    this.#framed = framed;
    this.#secure = secure;
    this.#hooks = hooks;
    this.done = this.#loop();
    this.done.catch(() => {});
    this.#timer = setInterval(() => void this.send(keepAlive(false)).catch(() => {}), KEEP_ALIVE_MS);
  }

  /** Encrypts and queues one offline frame. Sealing and queueing happen together, so sequence numbers stay in order. */
  send(frame: Buffer): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    return this.#framed.write(this.#secure.seal(frame));
  }

  /** One BYTES payload: the data, then an empty last chunk. */
  async sendBytes(id: bigint, data: Buffer): Promise<void> {
    await this.send(payloadTransfer({ id, type: P_BYTES, totalSize: data.length, flags: 0, offset: 0, body: data }));
    await this.send(payloadTransfer({ id, type: P_BYTES, totalSize: data.length, flags: LAST_CHUNK, offset: data.length }));
  }

  sendSharing(frame: Buffer): Promise<void> {
    return this.sendBytes(randomId(), frame);
  }

  async sendFile(id: bigint, path: string, size: number, onChunk: (n: number) => void): Promise<void> {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(FILE_CHUNK);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(FILE_CHUNK, size - off), off);
        if (bytesRead === 0) throw new ChannelError('the file got shorter while sending');
        await this.send(payloadTransfer({ id, type: P_FILE, totalSize: size, flags: 0, offset: off, body: buf.subarray(0, bytesRead) }));
        off += bytesRead;
        onChunk(bytesRead);
      }
      await this.send(payloadTransfer({ id, type: P_FILE, totalSize: size, flags: LAST_CHUNK, offset: size }));
    } finally {
      await fh.close();
    }
  }

  /** The next sharing frame from the peer. */
  nextSharing(timeoutMs: number): Promise<Sharing> {
    const s = this.#sharing.shift();
    if (s) return Promise.resolve(s);
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.#waiters.indexOf(w);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new ChannelError('timed out'));
      }, timeoutMs);
      const w = {
        resolve: (v: Sharing) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.#waiters.push(w);
    });
  }

  /** Says goodbye and closes the connection. */
  async close(): Promise<void> {
    await this.send(disconnection()).catch(() => {});
    this.#stop(new ChannelError('closed'));
    await this.#framed.end();
  }

  destroy(): void {
    this.#stop(new ChannelError('closed'));
    this.#framed.destroy();
  }

  #stop(e: Error): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#error) return;
    this.#error = e;
    for (const w of this.#waiters.splice(0)) w.reject(e);
  }

  async #loop(): Promise<void> {
    try {
      for (;;) {
        const raw = await this.#framed.next(IDLE_MS);
        const { type, v1 } = parseOffline(this.#secure.open(raw));
        if (type === F_KEEP_ALIVE) {
          if (!v1.msg(6)?.int(1)) await this.send(keepAlive(true));
        } else if (type === F_DISCONNECTION) {
          this.#stop(new ChannelError('the other device disconnected'));
          this.#framed.destroy();
          return;
        } else if (type === F_PAYLOAD_TRANSFER) {
          if (isControl(v1)) throw new ChannelError('the other device cancelled');
          const c = parseChunk(v1);
          if (c) await this.#chunk(c);
        }
        // bandwidth upgrades and anything else: stay on this connection
      }
    } catch (e) {
      const err = this.#error ?? (e instanceof Error ? e : new ChannelError(String(e)));
      this.#stop(err);
      this.#framed.destroy();
      if (err.message !== 'closed') throw err;
    }
  }

  async #chunk(c: Chunk): Promise<void> {
    if (c.type === P_FILE) {
      if (!this.#hooks.onFile) throw new ChannelError('unexpected file');
      await this.#hooks.onFile(c);
      return;
    }
    if (c.type !== P_BYTES) throw new ChannelError(`unsupported payload type ${c.type}`);
    if (c.totalSize < 0 || c.totalSize > MAX_BYTES) throw new ChannelError('payload too large');
    let p = this.#bytes.get(c.id);
    if (!p) {
      if (this.#bytes.size >= 64) throw new ChannelError('too many payloads');
      p = { parts: [], got: 0, total: c.totalSize };
      this.#bytes.set(c.id, p);
    }
    if (c.offset !== p.got || p.got + c.body.length > p.total) throw new ChannelError('bad payload chunk');
    if (c.body.length > 0) p.parts.push(Buffer.from(c.body));
    p.got += c.body.length;
    if ((c.flags & LAST_CHUNK) === 0) return;
    this.#bytes.delete(c.id);
    if (p.got !== p.total) throw new ChannelError('short payload');
    const data = Buffer.concat(p.parts);
    if (this.#hooks.onText?.(c.id, data)) return;
    const s = parseSharing(data);
    const w = this.#waiters.shift();
    if (w) w.resolve(s);
    else if (this.#sharing.length < 64) this.#sharing.push(s);
    else throw new ChannelError('too many unread frames');
  }
}
