import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { opusBitrate, opusChannels, opusDecoder, opusEncoder, opusType } from '../src/main/opus.ts';

/**
 * Splits an RFC 4571 byte stream into RTP packets (the Android side has its own in Java).
 * Returns the packets and the bytes left over.
 */
function rfc4571Split(buf: Buffer): { packets: Buffer[]; rest: Buffer } {
  const packets: Buffer[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const len = buf.readUInt16BE(off);
    if (buf.length - off - 2 < len) break;
    packets.push(buf.subarray(off + 2, off + 2 + len));
    off += 2 + len;
  }
  return { packets, rest: buf.subarray(off) };
}

const hasGst = (() => {
  try {
    execFileSync('gst-inspect-1.0', ['opusenc'], { stdio: 'ignore' });
    execFileSync('gst-inspect-1.0', ['rtpstreampay'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** One second of a 440 Hz tone, s16le 48 kHz. */
function tone(channels: 1 | 2): Buffer {
  const b = Buffer.alloc(48_000 * 2 * channels);
  for (let i = 0; i < 48_000; i++) {
    const v = Math.round(8000 * Math.sin((i * 2 * Math.PI * 440) / 48_000));
    for (let c = 0; c < channels; c++) b.writeInt16LE(v, (i * channels + c) * 2);
  }
  return b;
}

async function through(d: import('node:stream').Duplex, input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  d.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    d.on('end', resolve);
    d.on('error', reject);
  });
  d.end(input);
  await done;
  return Buffer.concat(chunks);
}

describe('opus content types', () => {
  it('names and reads the channel count', () => {
    expect(opusType(2)).toBe('audio/opus-rtp; channels=2');
    expect(opusChannels('audio/opus-rtp; channels=1')).toBe(1);
    expect(opusChannels('audio/opus-rtp')).toBe(2);
    expect(opusChannels('audio/L16; rate=48000; channels=2')).toBeNull();
    expect(opusChannels(undefined)).toBeNull();
    expect(opusBitrate(2)).toBe(96_000);
    expect(opusBitrate(1)).toBe(32_000);
  });

  it('splits RFC 4571 frames and keeps a partial one', () => {
    const b = Buffer.from([0, 2, 0xaa, 0xbb, 0, 3, 1, 2, 3, 0, 5, 9]);
    const { packets, rest } = rfc4571Split(b);
    expect(packets.map((p) => [...p])).toEqual([[0xaa, 0xbb], [1, 2, 3]]);
    expect([...rest]).toEqual([0, 5, 9]);
  });
});

describe.skipIf(!hasGst)('opus over GStreamer', () => {
  it('encodes PCM to 20 ms RTP packets that fit a Bluetooth link, and decodes them back', async () => {
    for (const ch of [2, 1] as const) {
      const rtp = await through(opusEncoder(ch), tone(ch));
      const { packets, rest } = rfc4571Split(rtp);
      expect(rest.length).toBe(0);
      expect(packets.length).toBeGreaterThanOrEqual(49);
      for (const p of packets) {
        expect(p[0]! >> 6).toBe(2); // RTP version 2
        expect(p[1]! & 0x7f).toBe(96);
      }
      // consecutive packets: sequence +1, timestamp +960 (20 ms at 48 kHz; the first is shorter by the
      // encoder's look-ahead)
      expect((packets[2]!.readUInt16BE(2) - packets[1]!.readUInt16BE(2) + 65536) % 65536).toBe(1);
      expect((packets[2]!.readUInt32BE(4) - packets[1]!.readUInt32BE(4) + 2 ** 32) % 2 ** 32).toBe(960);
      // well under the ~1 Mbit/s of an RFCOMM link
      expect(rtp.length * 8).toBeLessThan(ch === 2 ? 130_000 : 50_000);
      const pcm = await through(opusDecoder(ch), rtp);
      const seconds = pcm.length / (48_000 * 2 * ch);
      expect(seconds).toBeGreaterThan(0.9);
      expect(seconds).toBeLessThan(1.1);
    }
  }, 20_000);

  it('fails the stream when GStreamer is missing', async () => {
    const d = opusEncoder(2, 'meshdrop-no-such-gst');
    await expect(through(d, tone(2))).rejects.toThrow(/GStreamer/);
  });
});
