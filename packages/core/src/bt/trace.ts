// Diagnostics for live sound over Bluetooth: with MESHDROP_TRACE=<file> set, each stage appends one line
// per event ("<epoch ms> <stage> ..."), to find where a gap starts. Off (and free) unless it is set.
import { createWriteStream, type WriteStream } from 'node:fs';

let out: WriteStream | null | undefined;

export function tracing(): boolean {
  if (out === undefined) out = process.env.MESHDROP_TRACE ? createWriteStream(process.env.MESHDROP_TRACE, { flags: 'a' }) : null;
  return out !== null;
}

export function trace(line: string): void {
  if (tracing()) out!.write(`${(performance.timeOrigin + performance.now()).toFixed(3)} ${line}\n`);
}

/** Traces the RTP packets of an RFC 4571 stream (u16 length, then the packet) as they arrive. */
export function rtpTracer(stage: string): (chunk: Buffer) => void {
  let carry = Buffer.alloc(0);
  return (chunk) => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let at = 0;
    while (at + 2 <= buf.length) {
      const end = at + 2 + buf.readUInt16BE(at);
      if (end > buf.length) break;
      if (end - at >= 14) trace(`${stage} seq=${buf.readUInt16BE(at + 4)} ts=${buf.readUInt32BE(at + 6)} len=${end - at - 2}`);
      at = end;
    }
    carry = Buffer.from(buf.subarray(at));
  };
}
