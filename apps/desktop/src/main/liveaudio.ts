import { Transform } from 'node:stream';

/**
 * Keeps live sound live: passes raw PCM through but drops what would queue more than `maxMs` ahead
 * of the player. Without it a Wi-Fi stall arrives as a burst the player plays in full, late, and the
 * sound stays that late for the rest of the stream. The player is assumed to drain in real time once
 * it has had `startMs` to start (pw-cat reads its stdin only as fast as it plays).
 */
export function liveAudio(bytesPerSecond: number, frameBytes: number, opts: { maxMs?: number; startMs?: number; now?: () => number } = {}): Transform {
  const now = opts.now ?? (() => performance.now());
  const max = Math.floor((bytesPerSecond * (opts.maxMs ?? 120)) / 1000 / frameBytes) * frameBytes;
  const drainFrom = now() + (opts.startMs ?? 200);
  let last = drainFrom;
  let queued = 0;
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const t = now();
      if (t > last) {
        queued = Math.max(0, queued - ((t - last) * bytesPerSecond) / 1000);
        last = t;
      }
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % frameBytes);
      carry = Buffer.from(buf.subarray(whole));
      // only the newest audio that fits; the rest is already too late to play
      const room = Math.max(0, Math.floor((max - queued) / frameBytes) * frameBytes);
      const keep = Math.min(whole, room);
      queued += keep;
      done(null, keep ? buf.subarray(whole - keep, whole) : undefined);
    },
  });
}

/**
 * Keeps live Opus sound live over a slow link: passes RFC 4571 frames (u16 length + RTP packet) whole,
 * but drops a frame while `backlog()` plus what this chunk already passed would go over `maxBytes`.
 * `backlog` is what is queued ahead of the player (unsent socket bytes plus bytes the link has not
 * delivered yet). The player decodes frames one by one, so a dropped frame is a short gap, not noise.
 */
export function liveRtp(backlog: () => number, maxBytes: number): Transform {
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const keep: Buffer[] = [];
      let passed = 0;
      let at = 0;
      while (at + 2 <= buf.length) {
        const end = at + 2 + buf.readUInt16BE(at);
        if (end > buf.length) break;
        const frame = buf.subarray(at, end);
        if (backlog() + passed + frame.length <= maxBytes) {
          keep.push(frame);
          passed += frame.length;
        }
        at = end;
      }
      carry = Buffer.from(buf.subarray(at));
      done(null, keep.length ? Buffer.concat(keep) : undefined);
    },
  });
}
