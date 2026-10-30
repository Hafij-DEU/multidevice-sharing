// M14: live sound over Bluetooth. Raw PCM (192 kB/s stereo) does not fit an RFCOMM link, so sound
// there goes as Opus in RTP, framed per RFC 4571 (u16 length + RTP packet; payload type 96, 48 kHz
// clock, 20 ms frames). GStreamer does the codec; MeshDrop keeps its raw-PCM capture and sinks and
// puts these transforms between them and the link.
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';

/** The content type of an Opus stream. */
export const opusType = (channels: 1 | 2): string => `audio/opus-rtp; channels=${channels}`;

/** The channel count of an Opus content type, or null for anything else (raw PCM). */
export function opusChannels(contentType: string | undefined): 1 | 2 | null {
  const m = /^audio\/opus-rtp\s*(?:;\s*channels=([12]))?/i.exec(contentType ?? '');
  if (!m) return null;
  return m[1] === '1' ? 1 : 2;
}

/**
 * Stereo sound 48 kbit/s, a mono microphone 32 kbit/s. Stereo was 96 kbit/s, but a phone that is the
 * Bluetooth central lets this PC send only about that much, so the sound fell behind and stopped.
 */
export const opusBitrate = (channels: 1 | 2): number => (channels === 2 ? 48_000 : 32_000);

const RTP_CAPS = 'application/x-rtp-stream,media=audio,clock-rate=48000,encoding-name=OPUS,payload=96';

/** gst-launch arguments: s16le 48 kHz PCM in, RFC 4571 Opus RTP out. */
function encodeArgs(channels: 1 | 2, bitrate = opusBitrate(channels)): string[] {
  return [
    '-q', 'fdsrc', 'fd=0', '!',
    'rawaudioparse', 'format=pcm', 'pcm-format=s16le', 'sample-rate=48000', `num-channels=${channels}`, '!',
    'audioconvert', '!',
    'opusenc', `bitrate=${bitrate}`, 'frame-size=20', '!',
    'rtpopuspay', 'pt=96', '!',
    'rtpstreampay', '!',
    'fdsink', 'fd=1', 'sync=false',
  ];
}

/** gst-launch arguments: RFC 4571 Opus RTP in, s16le 48 kHz PCM out. */
function decodeArgs(channels: 1 | 2): string[] {
  return [
    '-q', 'fdsrc', 'fd=0', '!',
    RTP_CAPS, '!',
    'rtpstreamdepay', '!',
    'rtpopusdepay', '!',
    'opusdec', 'plc=true', '!',
    'audioconvert', '!', 'audioresample', '!',
    `audio/x-raw,format=S16LE,rate=48000,channels=${channels}`, '!',
    'fdsink', 'fd=1', 'sync=false',
  ];
}

/** A gst-launch process as a Duplex: write to its stdin, read its stdout; destroy() kills it. */
function gst(args: string[], cmd = 'gst-launch-1.0'): Duplex {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const out = new PassThrough();
  p.stdout.pipe(out);
  p.stdin.on('error', () => undefined);
  // Node accepts a {writable, readable} pair here; its typings only know web streams for that form
  const d = Duplex.from({ writable: p.stdin, readable: out } as unknown as Parameters<typeof Duplex.from>[0]);
  p.on('error', (e) => d.destroy(new Error(`Sound over Bluetooth needs GStreamer (gst-launch-1.0): ${e.message}`)));
  d.on('close', () => p.kill());
  return d;
}

/** PCM in, Opus RTP (RFC 4571) out. */
export function opusEncoder(channels: 1 | 2, cmd?: string): Duplex {
  return gst(encodeArgs(channels), cmd);
}

/** Opus RTP (RFC 4571) in, PCM out. */
export function opusDecoder(channels: 1 | 2, cmd?: string): Duplex {
  return gst(decodeArgs(channels), cmd);
}
