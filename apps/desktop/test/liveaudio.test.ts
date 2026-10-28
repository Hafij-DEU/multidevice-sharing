import { describe, expect, it } from 'vitest';
import { liveAudio } from '../src/main/liveaudio.ts';

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
