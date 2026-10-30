// Bluetooth link multiplexer ("btmux v1", docs/protocol.md): many TCP-like streams over one RFCOMM
// byte stream. A link only carries bytes: every stream it opens on the far side goes to that device's
// mTLS mesh port, so identity and trust are still proven by the pinned TLS inside the stream. The
// HELLO id is an unauthenticated claim, used only to tell which device a Bluetooth address belongs to.
import { EventEmitter } from 'node:events';
import { createServer, connect, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export const FT = { HELLO: 0, OPEN: 1, DATA: 2, END: 3, CREDIT: 4, PING: 5, PONG: 6, RESET: 7 } as const;

const MAX_PAYLOAD = 16 * 1024;
/** DATA frames carry at most this much, so live sound interleaves with a running file transfer. */
const DATA_SLICE = 4 * 1024;
/** Unacknowledged bytes a stream may have in flight before its sender pauses. */
const STREAM_WINDOW = 256 * 1024;
const HEADER = 9;

export interface Frame { type: number; stream: number; payload: Buffer }

export function encodeFrame(type: number, stream: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error('btmux: payload too large');
  const b = Buffer.allocUnsafe(HEADER + payload.length);
  b.writeUInt8(type, 0);
  b.writeUInt32BE(stream >>> 0, 1);
  b.writeUInt32BE(payload.length, 5);
  payload.copy(b, HEADER);
  return b;
}

/** Splits a byte stream into frames. Throws on an unknown type or an oversized payload. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: Frame[] = [];
    while (this.#buf.length >= HEADER) {
      const type = this.#buf.readUInt8(0);
      const len = this.#buf.readUInt32BE(5);
      if (type > FT.RESET) throw new Error(`btmux: unknown frame type ${type}`);
      if (len > MAX_PAYLOAD) throw new Error('btmux: frame too large');
      if (this.#buf.length < HEADER + len) break;
      out.push({ type, stream: this.#buf.readUInt32BE(1), payload: Buffer.from(this.#buf.subarray(HEADER, HEADER + len)) });
      this.#buf = this.#buf.subarray(HEADER + len);
    }
    return out;
  }
}

interface OutStream { id: number; priority: boolean; queue: (Buffer | 'end')[]; forget?: boolean }

export interface MuxOptions {
  /** This side dialled the RFCOMM link (it then uses odd stream ids, the other side even ones). */
  dialer: boolean;
  selfId: string;
  /** Keepalive period (default 15 s); the link closes after 3 periods of silence. */
  pingMs?: number;
}

/**
 * The frame layer: HELLO, stream ids, a fair writer (control frames first, then priority streams, then
 * the rest round-robin in DATA_SLICE pieces) and keepalive. Flow control (credits) is the caller's.
 * Events: 'hello' (peerId), 'open' (id, priority), 'data' (id, buf), 'end' (id), 'reset' (id),
 * 'credit' (id, n), 'close' (err?).
 */
export class Mux extends EventEmitter {
  readonly dialer: boolean;
  peerId: string | null = null;
  readonly #link: Duplex;
  readonly #reader = new FrameReader();
  #nextId: number;
  #control: Buffer[] = [];
  readonly #streams = new Map<number, OutStream>();
  readonly #ring: number[] = [];
  #writing = false;
  #closed = false;
  #lastRx = Date.now();
  readonly #timer: NodeJS.Timeout;

  constructor(link: Duplex, opts: MuxOptions) {
    super();
    this.dialer = opts.dialer;
    this.#link = link;
    this.#nextId = opts.dialer ? 1 : 2;
    const pingMs = opts.pingMs ?? 15_000;
    link.on('data', (c: Buffer) => this.#onData(c));
    link.on('error', (e: Error) => this.close(e));
    link.on('close', () => this.close());
    link.on('end', () => this.close());
    link.on('drain', () => this.#pump());
    this.#timer = setInterval(() => {
      if (Date.now() - this.#lastRx > pingMs * 3) this.close(new Error('btmux: link silent'));
      else this.#sendControl(FT.PING, 0);
    }, pingMs);
    this.#timer.unref();
    this.#sendControl(FT.HELLO, 0, Buffer.from(JSON.stringify({ v: 1, id: opts.selfId })));
  }

  get closed(): boolean {
    return this.#closed;
  }

  open(priority: boolean): number {
    const id = this.#nextId;
    this.#nextId += 2;
    this.#streams.set(id, { id, priority, queue: [] });
    this.#sendControl(FT.OPEN, id, Buffer.from([priority ? 1 : 0]));
    return id;
  }

  /** Registers a stream the far side opened (called by the 'open' listener's owner implicitly). */
  #accept(id: number, priority: boolean): void {
    this.#streams.set(id, { id, priority, queue: [] });
  }

  write(id: number, data: Buffer): void {
    const s = this.#streams.get(id);
    if (!s || this.#closed) return;
    for (let o = 0; o < data.length; o += DATA_SLICE) s.queue.push(data.subarray(o, o + DATA_SLICE));
    this.#ready(s);
  }

  /** Half-close: no more data from this side on the stream (sent after its queued data). */
  end(id: number): void {
    const s = this.#streams.get(id);
    if (!s || this.#closed) return;
    s.queue.push('end');
    this.#ready(s);
  }

  reset(id: number): void {
    if (!this.#streams.delete(id)) return;
    this.#sendControl(FT.RESET, id);
  }

  credit(id: number, n: number): void {
    if (n <= 0 || !this.#streams.has(id)) return;
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(n >>> 0, 0);
    this.#sendControl(FT.CREDIT, id, b);
  }

  /** Forgets a stream both sides have ended, once its queued frames (the END) have gone out. */
  forget(id: number): void {
    const s = this.#streams.get(id);
    if (!s) return;
    if (s.queue.length) s.forget = true;
    else this.#streams.delete(id);
  }

  close(err?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#streams.clear();
    this.#link.destroy();
    this.emit('close', err);
  }

  #ready(s: OutStream): void {
    if (!this.#ring.includes(s.id)) this.#ring.push(s.id);
    this.#pump();
  }

  #sendControl(type: number, stream: number, payload?: Buffer): void {
    if (this.#closed) return;
    this.#control.push(encodeFrame(type, stream, payload));
    this.#pump();
  }

  #next(): Buffer | null {
    const c = this.#control.shift();
    if (c) return c;
    if (!this.#ring.length) return null;
    let at = this.#ring.findIndex((id) => this.#streams.get(id)?.priority === true);
    if (at < 0) at = 0;
    const id = this.#ring.splice(at, 1)[0]!;
    const s = this.#streams.get(id);
    if (!s) return this.#next();
    const head = s.queue.shift();
    if (s.queue.length) this.#ring.push(id);
    else if (s.forget) this.#streams.delete(id);
    if (head === undefined) return this.#next();
    return head === 'end' ? encodeFrame(FT.END, id) : encodeFrame(FT.DATA, id, head);
  }

  #pump(): void {
    if (this.#writing || this.#closed) return;
    this.#writing = true;
    try {
      for (;;) {
        const f = this.#next();
        if (!f) break;
        if (!this.#link.write(f)) break; // 'drain' pumps again
      }
    } finally {
      this.#writing = false;
    }
  }

  #onData(chunk: Buffer): void {
    this.#lastRx = Date.now();
    let frames: Frame[];
    try {
      frames = this.#reader.push(chunk);
    } catch (e) {
      this.close(e as Error);
      return;
    }
    for (const f of frames) {
      if (this.#closed) return;
      if (this.peerId === null && f.type !== FT.HELLO) {
        this.close(new Error('btmux: frame before HELLO'));
        return;
      }
      switch (f.type) {
        case FT.HELLO: {
          let id: unknown;
          try {
            const h = JSON.parse(f.payload.toString('utf8')) as { v?: unknown; id?: unknown };
            id = h.v === 1 ? h.id : undefined;
          } catch {
            id = undefined;
          }
          if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id) || this.peerId !== null) {
            this.close(new Error('btmux: bad HELLO'));
            return;
          }
          this.peerId = id;
          this.emit('hello', id);
          break;
        }
        case FT.OPEN:
          // The far side's ids have the other parity; anything else is a protocol error.
          if ((f.stream % 2 === 1) === this.dialer || f.stream === 0 || this.#streams.has(f.stream)) {
            this.close(new Error('btmux: bad OPEN'));
            return;
          }
          this.#accept(f.stream, (f.payload[0] ?? 0) & 1 ? true : false);
          this.emit('open', f.stream, ((f.payload[0] ?? 0) & 1) === 1);
          break;
        case FT.DATA:
          if (this.#streams.has(f.stream)) this.emit('data', f.stream, f.payload);
          break;
        case FT.END:
          if (this.#streams.has(f.stream)) this.emit('end', f.stream);
          break;
        case FT.RESET:
          if (this.#streams.delete(f.stream)) this.emit('reset', f.stream);
          break;
        case FT.CREDIT:
          if (f.payload.length === 4 && this.#streams.has(f.stream)) this.emit('credit', f.stream, f.payload.readUInt32BE(0));
          break;
        case FT.PING:
          this.#sendControl(FT.PONG, 0);
          break;
        case FT.PONG:
          break;
      }
    }
  }
}

export interface BtLinkOptions extends MuxOptions {
  /** This device's mTLS mesh port: the only place a stream from the far side is connected to. */
  meshPort: () => number;
  /** Local host to forward to (default 127.0.0.1). */
  meshHost?: string;
}

/** One local TCP connection bridged to one mux stream, with credit-based flow control. */
class Pipe {
  inFlight = 0;
  localEnded = false;
  remoteEnded = false;
  readonly id: number;
  readonly sock: Socket;
  constructor(id: number, sock: Socket) {
    this.id = id;
    this.sock = sock;
  }
}

/**
 * A Bluetooth link to one device: a Mux plus two local listeners on 127.0.0.1 (normal and priority).
 * A connection to either becomes a stream to the far side's mesh port; a stream the far side opens is
 * connected to this device's mesh port. Events: 'ready' (peerId), 'close'.
 */
export class BtLink extends EventEmitter {
  readonly mux: Mux;
  readonly createdAt = Date.now();
  lastActive = Date.now();
  ports: { normal: number; priority: number } | null = null;
  readonly #opts: BtLinkOptions;
  readonly #pipes = new Map<number, Pipe>();
  readonly #servers: Server[] = [];
  readonly ready: Promise<string>;

  constructor(link: Duplex, opts: BtLinkOptions) {
    super();
    this.#opts = opts;
    this.mux = new Mux(link, opts);
    this.ready = new Promise<string>((resolve, reject) => {
      this.mux.once('hello', (id: string) => {
        this.#listen()
          .then(() => {
            resolve(id);
            this.emit('ready', id);
          })
          .catch((e: Error) => {
            this.close();
            reject(e);
          });
      });
      this.mux.once('close', (e?: Error) => reject(e ?? new Error('btmux: link closed')));
    });
    this.ready.catch(() => {});
    this.mux.on('open', (id: number) => this.#onOpen(id));
    this.mux.on('data', (id: number, b: Buffer) => this.#onData(id, b));
    this.mux.on('end', (id: number) => this.#onEnd(id));
    this.mux.on('reset', (id: number) => this.#drop(id, true));
    this.mux.on('credit', (id: number, n: number) => this.#onCredit(id, n));
    this.mux.on('close', () => this.#onClose());
  }

  get peerId(): string | null {
    return this.mux.peerId;
  }

  get closed(): boolean {
    return this.mux.closed;
  }

  /** Streams currently open (a link with none is idle). */
  get streams(): number {
    return this.#pipes.size;
  }

  /** Bytes sent on the stream whose local socket uses `port` that the far side has not credited yet. */
  backlog(port: number): number | undefined {
    for (const p of this.#pipes.values()) if (p.sock.localPort === port) return p.inFlight;
    return undefined;
  }

  close(): void {
    this.mux.close();
  }

  async #listen(): Promise<void> {
    const listen = (priority: boolean): Promise<number> =>
      new Promise((resolve, reject) => {
        const s = createServer({ allowHalfOpen: true }, (sock) => this.#local(sock, priority));
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
        this.#servers.push(s);
      });
    const normal = await listen(false);
    const priority = await listen(true);
    this.ports = { normal, priority };
  }

  #local(sock: Socket, priority: boolean): void {
    if (this.mux.closed) {
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    const id = this.mux.open(priority);
    this.#attach(new Pipe(id, sock));
  }

  #onOpen(id: number): void {
    const sock = connect({ host: this.#opts.meshHost ?? '127.0.0.1', port: this.#opts.meshPort(), allowHalfOpen: true });
    sock.setNoDelay(true);
    this.#attach(new Pipe(id, sock));
  }

  #attach(p: Pipe): void {
    this.#pipes.set(p.id, p);
    this.lastActive = Date.now();
    p.sock.on('data', (b: Buffer) => {
      this.lastActive = Date.now();
      p.inFlight += b.length;
      this.mux.write(p.id, b);
      if (p.inFlight >= STREAM_WINDOW) p.sock.pause();
    });
    p.sock.on('end', () => {
      p.localEnded = true;
      this.mux.end(p.id);
      this.#maybeDone(p);
    });
    p.sock.on('error', () => this.#drop(p.id, false));
    p.sock.on('close', () => {
      if (this.#pipes.has(p.id) && !(p.localEnded && p.remoteEnded)) this.#drop(p.id, false);
    });
  }

  #onData(id: number, b: Buffer): void {
    const p = this.#pipes.get(id);
    if (!p) return;
    this.lastActive = Date.now();
    p.sock.write(b, (err) => {
      if (!err) this.mux.credit(id, b.length);
    });
  }

  #onCredit(id: number, n: number): void {
    const p = this.#pipes.get(id);
    if (!p) return;
    p.inFlight = Math.max(0, p.inFlight - n);
    if (p.inFlight < STREAM_WINDOW && p.sock.isPaused()) p.sock.resume();
  }

  #onEnd(id: number): void {
    const p = this.#pipes.get(id);
    if (!p) return;
    p.remoteEnded = true;
    p.sock.end();
    this.#maybeDone(p);
  }

  #maybeDone(p: Pipe): void {
    if (p.localEnded && p.remoteEnded) {
      this.#pipes.delete(p.id);
      this.mux.forget(p.id);
    }
  }

  /** Abort a stream: `remote` when the far side reset it (no RESET goes back). */
  #drop(id: number, remote: boolean): void {
    const p = this.#pipes.get(id);
    if (!p) return;
    this.#pipes.delete(id);
    if (!remote) this.mux.reset(id);
    // An abort, not a half-close: the local end sees a reset, as it would on a dropped TCP connection.
    if (!p.sock.destroyed) p.sock.resetAndDestroy();
  }

  #onClose(): void {
    for (const p of this.#pipes.values()) if (!p.sock.destroyed) p.sock.resetAndDestroy();
    this.#pipes.clear();
    for (const s of this.#servers) s.close();
    this.emit('close');
  }
}
