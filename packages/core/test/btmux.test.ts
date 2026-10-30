import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { duplexPair } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { BtLink, FrameReader, Mux, encodeFrame, FT, type Frame } from '../src/bt/mux.ts';

interface VecFrame { name: string; type: number; stream: number; payloadHex: string; frameHex: string }
const vectors = JSON.parse(
  readFileSync(new URL('../../../protocol/vectors/btmux-v1.json', import.meta.url), 'utf8'),
) as { maxPayload: number; frames: VecFrame[]; concatHex: string; invalid: { name: string; frameHex: string }[] };

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('btmux v1 wire vectors', () => {
  it('encodes every frame byte for byte', () => {
    for (const v of vectors.frames) {
      expect(encodeFrame(v.type, v.stream, Buffer.from(v.payloadHex, 'hex')).toString('hex'), v.name).toBe(v.frameHex);
    }
  });

  it('decodes the concatenation in any split', () => {
    const all = Buffer.from(vectors.concatHex, 'hex');
    for (const step of [1, 2, 7, 9, 64, all.length]) {
      const r = new FrameReader();
      const got: Frame[] = [];
      for (let o = 0; o < all.length; o += step) got.push(...r.push(all.subarray(o, o + step)));
      expect(got.map((f) => [f.type, f.stream, f.payload.toString('hex')])).toEqual(
        vectors.frames.map((v) => [v.type, v.stream, v.payloadHex]),
      );
    }
  });

  it('rejects invalid frames', () => {
    for (const v of vectors.invalid) expect(() => new FrameReader().push(Buffer.from(v.frameHex, 'hex')), v.name).toThrow();
    expect(() => encodeFrame(FT.DATA, 1, Buffer.alloc(vectors.maxPayload + 1))).toThrow();
  });
});

const open: { close(): void }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) o.close();
});

/** A TCP server standing in for a mesh port: echoes, or hashes what it receives. */
async function meshStub(handler: (s: Socket) => void): Promise<Server> {
  const srv = createServer({ allowHalfOpen: true }, (s) => {
    s.on('error', () => {});
    handler(s);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  open.push(srv);
  return srv;
}
const portOf = (s: Server) => (s.address() as { port: number }).port;

async function linkPair(meshA: number, meshB: number, pingMs?: number) {
  const [x, y] = duplexPair();
  const a = new BtLink(x, { dialer: true, selfId: A, meshPort: () => meshA, ...(pingMs ? { pingMs } : {}) });
  const b = new BtLink(y, { dialer: false, selfId: B, meshPort: () => meshB, ...(pingMs ? { pingMs } : {}) });
  open.push(a, b);
  expect(await a.ready).toBe(B);
  expect(await b.ready).toBe(A);
  return { a, b };
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port, allowHalfOpen: true }, () => resolve(s));
    s.on('error', reject);
  });
}

describe('BtLink', () => {
  it('tunnels a stream to the far side mesh port and back', async () => {
    const echo = await meshStub((s) => s.pipe(s));
    const { a } = await linkPair(1, portOf(echo));
    const s = await dial(a.ports!.normal);
    const got: Buffer[] = [];
    s.on('data', (b: Buffer) => got.push(b));
    s.end('hello over bluetooth');
    await new Promise((r) => s.on('close', r));
    expect(Buffer.concat(got).toString()).toBe('hello over bluetooth');
    await sleep(20);
    expect(a.streams).toBe(0);
  });

  it('streams opened by the non-dialer use even ids and reach the dialer mesh port', async () => {
    const echo = await meshStub((s) => s.pipe(s));
    const { b } = await linkPair(portOf(echo), 1);
    const s = await dial(b.ports!.normal);
    s.end('back');
    const got = await new Promise<string>((r) => {
      let t = '';
      s.on('data', (d: Buffer) => (t += d.toString()));
      s.on('end', () => r(t));
    });
    expect(got).toBe('back');
  });

  it('moves 4 MiB both ways intact under flow control', async () => {
    const size = 4 * 1024 * 1024;
    const data = randomBytes(size);
    const hash = createHash('sha256').update(data).digest('hex');
    const seen = new Promise<string>((resolve) => {
      void meshStub((s) => {
        const h = createHash('sha256');
        s.on('data', (d: Buffer) => h.update(d));
        s.on('end', () => {
          resolve(h.digest('hex'));
          s.end(data);
        });
      }).then((srv) => linkPair(1, portOf(srv)).then(({ a }) => run(a)));
    });
    let back = '';
    const run = async (a: BtLink) => {
      const s = await dial(a.ports!.normal);
      const h = createHash('sha256');
      s.on('data', (d: Buffer) => h.update(d));
      s.on('end', () => (back = h.digest('hex')));
      s.end(data);
    };
    expect(await seen).toBe(hash);
    for (let i = 0; i < 100 && !back; i++) await sleep(20);
    expect(back).toBe(hash);
  });

  it('a priority stream is served ahead of a bulk stream', async () => {
    const order: string[] = [];
    const sink = await meshStub((s) => {
      let first = true;
      s.on('data', (d: Buffer) => {
        if (first) order.push(d.subarray(0, 4).toString());
        first = false;
      });
      s.resume();
    });
    const { a } = await linkPair(1, portOf(sink));
    const bulk = await dial(a.ports!.normal);
    bulk.write(Buffer.concat([Buffer.from('BULK'), Buffer.alloc(200_000)]));
    const live = await dial(a.ports!.priority);
    live.write('LIVE');
    for (let i = 0; i < 100 && order.length < 2; i++) await sleep(10);
    // The live frame does not wait for 200 KB of bulk data to drain.
    expect(order).toContain('LIVE');
    bulk.destroy();
    live.destroy();
  });

  it('a local abort resets only that stream', async () => {
    let closed = 0;
    const stub = await meshStub((s) => {
      s.on('close', () => closed++);
      s.on('error', () => {});
      s.resume();
    });
    const { a } = await linkPair(1, portOf(stub));
    const s1 = await dial(a.ports!.normal);
    const s2 = await dial(a.ports!.normal);
    s1.write('x');
    s2.write('y');
    await sleep(50);
    s1.resetAndDestroy();
    for (let i = 0; i < 50 && closed < 1; i++) await sleep(10);
    expect(closed).toBe(1);
    expect(a.streams).toBe(1);
    s2.destroy();
  });

  it('reports the bytes of a stream the far side has not credited yet', async () => {
    let served: Socket | undefined;
    const stub = await meshStub((s) => {
      served = s;
      s.write(Buffer.alloc(5000));
    });
    const [x, y] = duplexPair();
    const far = new Mux(x, { dialer: true, selfId: A });
    const b = new BtLink(y, { dialer: false, selfId: B, meshPort: () => portOf(stub) });
    open.push(far, b);
    await b.ready;
    // the far side opens a stream (as a phone asking for this PC's sound) and never credits
    const id = far.open(false);
    for (let i = 0; i < 100 && b.backlog(served?.remotePort ?? 0) !== 5000; i++) await sleep(10);
    expect(b.backlog(served!.remotePort!)).toBe(5000);
    far.credit(id, 2000);
    for (let i = 0; i < 100 && b.backlog(served!.remotePort!) !== 3000; i++) await sleep(10);
    expect(b.backlog(served!.remotePort!)).toBe(3000);
    expect(b.backlog(1)).toBeUndefined();
  });

  it('closes a link that falls silent', async () => {
    const [x] = duplexPair();
    const m = new Mux(x, { dialer: true, selfId: A, pingMs: 20 });
    const err = await new Promise<Error | undefined>((r) => m.on('close', r));
    expect(err?.message).toMatch(/silent/);
  });

  it('closes on a bad HELLO or a frame before HELLO', async () => {
    for (const first of [
      encodeFrame(FT.HELLO, 0, Buffer.from('{"v":1,"id":"nope"}')),
      encodeFrame(FT.OPEN, 2, Buffer.from([0])),
    ]) {
      const [x, y] = duplexPair();
      const m = new Mux(x, { dialer: true, selfId: A });
      const closed = new Promise<Error | undefined>((r) => m.on('close', r));
      y.write(first);
      expect((await closed)?.message).toMatch(/HELLO/);
    }
  });

  it('rejects an OPEN with the wrong id parity', async () => {
    const [x, y] = duplexPair();
    const m = new Mux(x, { dialer: true, selfId: A });
    const closed = new Promise<Error | undefined>((r) => m.on('close', r));
    y.write(encodeFrame(FT.HELLO, 0, Buffer.from(JSON.stringify({ v: 1, id: B }))));
    y.write(encodeFrame(FT.OPEN, 3, Buffer.from([0])));
    expect((await closed)?.message).toMatch(/bad OPEN/);
  });
});
