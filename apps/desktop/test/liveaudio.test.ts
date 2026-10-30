import { describe, expect, it } from 'vitest';
import { liveAudio, liveRtp } from '../src/main/liveaudio.ts';

// 1000 bytes/s with 4-byte frames: 1 ms of sound is 1 byte, so the numbers read as milliseconds
function run(steps: [atMs: number, bytes: number][], opts = { maxMs: 100, startMs: 0 }) {
  let t = 0;
  const live = liveAudio(1000, 4, { ...opts, now: () => t });
  const out: number[] = [];
  live.on('data', (c: Buffer) => out.push(c.length));
  let seq = 0;
  for (const [at, n] of steps) {
    t = at;
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = seq++ & 0xff;
    live.write(b);
  }
  return out;
}

describe('liveAudio', () => {
  it('passes a steady stream untouched', () => {
    expect(run([[0, 20], [20, 20], [40, 20], [60, 20]])).toEqual([20, 20, 20, 20]);
  });

  it('drops the backlog of a stall, keeping only the newest that fits', () => {
    // 20 ms queued, then a 500 ms burst at once: only 80 ms more fits under the 100 ms cap
    expect(run([[0, 20], [0, 500]])).toEqual([20, 80]);
  });

  it('keeps whole frames when chunks split them', () => {
    expect(run([[0, 6], [10, 6]])).toEqual([4, 8]);
  });

  it('does not drain before the player has started', () => {
    // 200 ms start-up: nothing plays yet, so 100 ms fills it and the rest is dropped
    expect(run([[0, 60], [100, 60], [150, 60]], { maxMs: 100, startMs: 200 })).toEqual([60, 40]);
  });

  it('passes the newest bytes of a trimmed chunk', async () => {
    let t = 0;
    const live = liveAudio(1000, 4, { maxMs: 8, startMs: 0, now: () => t });
    const got: Buffer[] = [];
    live.on('data', (c: Buffer) => got.push(c));
    live.write(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(Buffer.concat(got)).toEqual(Buffer.from([5, 6, 7, 8, 9, 10, 11, 12]));
  });
});

/** RFC 4571 frames: u16 length, then that many bytes (each filled with its index). */
function frames(...lens: number[]): Buffer[] {
  return lens.map((n, i) => Buffer.concat([Buffer.from([n >> 8, n & 0xff]), Buffer.alloc(n, i)]));
}

function runRtp(chunks: Buffer[], backlog: () => number, maxBytes: number): number[] {
  const live = liveRtp(backlog, maxBytes);
  const out: Buffer[] = [];
  live.on('data', (c: Buffer) => out.push(c));
  for (const c of chunks) live.write(c);
  // what came out, read back as the fill byte of each whole frame
  const all = Buffer.concat(out);
  const got: number[] = [];
  for (let at = 0; at < all.length; ) {
    const n = all.readUInt16BE(at);
    expect(at + 2 + n).toBeLessThanOrEqual(all.length);
    got.push(all[at + 2]!);
    at += 2 + n;
  }
  return got;
}

describe('liveRtp', () => {
  it('passes frames while the link keeps up', () => {
    expect(runRtp(frames(38, 38, 38), () => 0, 1000)).toEqual([0, 1, 2]);
  });

  it('drops whole frames while the link is backed up, and passes again once it drains', () => {
    let backlog = 5000;
    const f = frames(38, 38, 38, 38);
    const out: number[] = [];
    const l = liveRtp(() => backlog, 1000);
    l.on('data', (c: Buffer) => out.push(c[2]!));
    l.write(f[0]!);
    l.write(f[1]!);
    backlog = 100;
    l.write(f[2]!);
    l.write(f[3]!);
    expect(out).toEqual([2, 3]);
  });

  it('counts what it just passed when one chunk holds several frames', () => {
    // 40 bytes a frame on the wire, 100 allowed: two fit
    expect(runRtp([Buffer.concat(frames(38, 38, 38))], () => 0, 100)).toEqual([0, 1]);
  });

  it('keeps frames whole when chunks split them', () => {
    const all = Buffer.concat(frames(38, 38, 38));
    expect(runRtp([all.subarray(0, 1), all.subarray(1, 50), all.subarray(50)], () => 0, 1000)).toEqual([0, 1, 2]);
  });
});
