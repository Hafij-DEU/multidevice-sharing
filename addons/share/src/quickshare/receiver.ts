// The receiving side of one Quick Share connection: handshake, offer, then the files and text.
import { mkdir, open, rm, statfs, type FileHandle } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { Channel, ChannelError } from './channel.ts';
import { Framed } from './conn.ts';
import {
  F_CONNECTION_REQUEST, F_CONNECTION_RESPONSE, LAST_CHUNK, R_ACCEPT, R_NOT_ENOUGH_SPACE, R_REJECT, R_UNSUPPORTED,
  S_INTRODUCTION, S_PAIRED_KEY_ENCRYPTION, S_PAIRED_KEY_RESULT, connectionResponse, pairedKeyEncryption, pairedKeyResult,
  parseEndpointInfo, parseOffline, sharingResponse, type Chunk, type FileMeta, type Sharing, type TextMeta,
} from './frames.ts';
import { SecureChannel } from './secure.ts';
import { serverHandshake } from './ukey2.ts';

export const HANDSHAKE_MS = 30_000;
const FRAME_MS = 30_000;
const MAX_FILES = 1000;
const MAX_TEXT = 1024 * 1024;

export interface Incoming {
  alias: string;
  deviceType: number;
  pin: string;
  files: FileMeta[];
  texts: TextMeta[];
}

export interface ReceiveOptions {
  /** A folder for this connection's partial files; created here and removed afterwards. */
  partialDir: string;
  /** Asks the user; resolves true to take the offer. */
  decide(o: Incoming): Promise<boolean>;
  /** Moves a finished file into the inbox; returns where it landed. */
  land(part: string, name: string): Promise<string>;
}

export interface Received {
  alias: string;
  files: string[];
  text?: string;
}

async function expectSharing(ch: Channel, type: number): Promise<Sharing> {
  for (;;) {
    const s = await ch.nextSharing(FRAME_MS);
    if (s.type === type) return s;
  }
}

/** Runs one incoming connection to the end; null when the user (or MeshDrop) declined. */
export async function receive(sock: Socket, opts: ReceiveOptions): Promise<Received | null> {
  const framed = new Framed(sock);
  let channel: Channel | null = null;
  const sinks = new Map<bigint, { meta: FileMeta; part: string; fh: FileHandle | null; written: number; done: boolean }>();
  try {
    const req = parseOffline(await framed.next(HANDSHAKE_MS));
    if (req.type !== F_CONNECTION_REQUEST) throw new ChannelError('expected a connection request');
    const cr = req.v1.msg(2);
    const who = parseEndpointInfo(cr?.bytes(6));
    const alias = (who.name || cr?.str(2) || 'Quick Share device').slice(0, 64);

    const keys = await serverHandshake(framed, HANDSHAKE_MS);
    const resp = parseOffline(await framed.next(HANDSHAKE_MS));
    if (resp.type !== F_CONNECTION_RESPONSE) throw new ChannelError('expected a connection response');
    const r = resp.v1.msg(3);
    if (r?.int(3) !== 1 && !(r?.int(3) === undefined && r?.int(1) === 0)) throw new ChannelError('the other device dropped the connection');
    await framed.write(connectionResponse());

    const texts = new Map<bigint, string | null>();
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const complete = (): boolean => [...sinks.values()].every((s) => s.done) && [...texts.values()].every((t) => t !== null);

    const ch = new Channel(framed, new SecureChannel(keys), {
      onFile: async (c: Chunk) => {
        const s = sinks.get(c.id);
        if (!s || s.done) throw new ChannelError('unexpected file data');
        if (c.offset !== s.written || s.written + c.body.length > s.meta.size) throw new ChannelError('bad file chunk');
        s.fh ??= await open(s.part, 'w');
        if (c.body.length > 0) await s.fh.write(c.body, 0, c.body.length, s.written);
        s.written += c.body.length;
        if ((c.flags & LAST_CHUNK) !== 0) {
          if (s.written !== s.meta.size) throw new ChannelError('file ended early');
          await s.fh.close();
          s.fh = null;
          s.done = true;
          if (complete()) finish();
        }
      },
      onText: (id, data) => {
        if (!texts.has(id)) return false;
        texts.set(id, data.subarray(0, MAX_TEXT).toString('utf8'));
        if (complete()) finish();
        return true;
      },
    });
    channel = ch;

    await ch.sendSharing(pairedKeyEncryption());
    await expectSharing(ch, S_PAIRED_KEY_ENCRYPTION);
    await ch.sendSharing(pairedKeyResult());
    await expectSharing(ch, S_PAIRED_KEY_RESULT);
    const intro = await expectSharing(ch, S_INTRODUCTION);

    const ids = new Set<bigint>();
    const sane = intro.files.length + intro.texts.length > 0 && intro.files.length <= MAX_FILES && intro.texts.length <= 16
      && [...intro.files, ...intro.texts].every((m) => Number.isSafeInteger(m.size) && m.size >= 0 && !ids.has(m.payloadId) && ids.add(m.payloadId));
    if (!sane) {
      await ch.sendSharing(sharingResponse(R_UNSUPPORTED));
      await ch.close();
      return null;
    }

    const ok = await Promise.race([
      opts.decide({ alias, deviceType: who.deviceType, pin: keys.pin, files: intro.files, texts: intro.texts }),
      ch.done.then(() => {
        throw new ChannelError('the other device cancelled');
      }),
    ]);
    if (!ok) {
      await ch.sendSharing(sharingResponse(R_REJECT));
      await ch.close();
      return null;
    }

    await mkdir(opts.partialDir, { recursive: true });
    const total = intro.files.reduce((n, f) => n + f.size, 0);
    const fs = await statfs(opts.partialDir).catch(() => null);
    if (fs && fs.bavail * fs.bsize < total) {
      await ch.sendSharing(sharingResponse(R_NOT_ENOUGH_SPACE));
      await ch.close();
      return null;
    }
    intro.files.forEach((meta, i) => sinks.set(meta.payloadId, { meta, part: join(opts.partialDir, `${i}.part`), fh: null, written: 0, done: false }));
    for (const t of intro.texts) texts.set(t.payloadId, null);
    await ch.sendSharing(sharingResponse(R_ACCEPT));

    await Promise.race([
      finished,
      ch.done.then(() => {
        if (!complete()) throw new ChannelError('the other device stopped before the end');
      }),
    ]);

    const files: string[] = [];
    for (const s of sinks.values()) files.push(await opts.land(s.part, s.meta.name));
    const text = [...texts.values()].filter((t): t is string => t !== null).join('\n');
    await ch.close();
    return { alias, files, ...(texts.size > 0 ? { text } : {}) };
  } finally {
    channel?.destroy();
    framed.destroy();
    for (const s of sinks.values()) await s.fh?.close().catch(() => {});
    await rm(opts.partialDir, { recursive: true, force: true }).catch(() => {});
  }
}
