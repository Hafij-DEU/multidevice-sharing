// A TCP connection carrying 4-byte big-endian length-prefixed frames, read one at a time.
import type { Socket } from 'node:net';

export const MAX_FRAME = 16 * 1024 * 1024;
/** Frames buffered before reading from the socket pauses. */
const HIGH_WATER = 32;

export class ConnError extends Error {}

export class Framed {
  readonly #sock: Socket;
  readonly #chunks: Buffer[] = [];
  #have = 0;
  #need = -1;
  readonly #frames: Buffer[] = [];
  readonly #waiters: { resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  #error: Error | null = null;
  readonly closed: Promise<void>;

  constructor(sock: Socket) {
    this.#sock = sock;
    sock.setNoDelay(true);
    sock.on('data', (d: Buffer) => {
      this.#chunks.push(d);
      this.#have += d.length;
      this.#drain();
    });
    this.closed = new Promise((resolve) => {
      sock.once('close', () => {
        this.#fail(new ConnError('connection closed'));
        resolve();
      });
    });
    sock.on('error', (e) => this.#fail(new ConnError(e.message)));
  }

  get remoteAddress(): string | undefined {
    return this.#sock.remoteAddress;
  }

  #take(n: number): Buffer {
    const first = this.#chunks[0]!;
    let out: Buffer;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
    } else {
      out = Buffer.allocUnsafe(n);
      let off = 0;
      while (off < n) {
        const c = this.#chunks[0]!;
        const k = Math.min(c.length, n - off);
        c.copy(out, off, 0, k);
        off += k;
        if (k === c.length) this.#chunks.shift();
        else this.#chunks[0] = c.subarray(k);
      }
    }
    this.#have -= n;
    return out;
  }

  #drain(): void {
    while (this.#error === null) {
      if (this.#need < 0) {
        if (this.#have < 4) return;
        const len = this.#take(4).readUInt32BE(0);
        if (len > MAX_FRAME) {
          this.#fail(new ConnError('frame too large'));
          this.#sock.destroy();
          return;
        }
        this.#need = len;
      }
      if (this.#have < this.#need) return;
      const f = this.#take(this.#need);
      this.#need = -1;
      const w = this.#waiters.shift();
      if (w) w.resolve(f);
      else {
        this.#frames.push(f);
        if (this.#frames.length >= HIGH_WATER) this.#sock.pause();
      }
    }
  }

  #fail(e: Error): void {
    if (this.#error) return;
    this.#error = e;
    for (const w of this.#waiters.splice(0)) w.reject(e);
  }

  /** The next frame; rejects when the connection ends or nothing arrives within `timeoutMs`. */
  next(timeoutMs: number): Promise<Buffer> {
    const f = this.#frames.shift();
    if (f) {
      if (this.#frames.length < HIGH_WATER / 2) this.#sock.resume();
      return Promise.resolve(f);
    }
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.#waiters.indexOf(w);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new ConnError('timed out'));
      }, timeoutMs);
      const w = {
        resolve: (b: Buffer) => {
          clearTimeout(t);
          resolve(b);
        },
        reject: (e: Error) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.#waiters.push(w);
      this.#sock.resume();
    });
  }

  /** Queues one frame; resolves once the socket can take more. */
  write(b: Buffer): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(b.length, 0);
    if (this.#sock.write(Buffer.concat([head, b]))) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (): void => {
        this.#sock.off('drain', done);
        this.#sock.off('close', done);
        if (this.#sock.destroyed) reject(this.#error ?? new ConnError('connection closed'));
        else resolve();
      };
      this.#sock.on('drain', done);
      this.#sock.on('close', done);
    });
  }

  /** Ends the connection after what is queued, and gives up on it after `graceMs`. */
  async end(graceMs = 5000): Promise<void> {
    this.#sock.end();
    const t = setTimeout(() => this.#sock.destroy(), graceMs);
    await this.closed;
    clearTimeout(t);
  }

  destroy(): void {
    this.#sock.destroy();
  }
}
