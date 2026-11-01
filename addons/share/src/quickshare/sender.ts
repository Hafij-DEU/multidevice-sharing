// The sending side of one Quick Share connection.
import { randomInt } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename } from 'node:path';
import { Channel, ChannelError } from './channel.ts';
import { Framed } from './conn.ts';
import {
  F_CONNECTION_RESPONSE, R_ACCEPT, R_NOT_ENOUGH_SPACE, R_REJECT, R_TIMED_OUT, R_UNSUPPORTED, S_PAIRED_KEY_ENCRYPTION,
  S_PAIRED_KEY_RESULT, S_RESPONSE, connectionRequest, connectionResponse, endpointInfo, introduction, mimeOf,
  pairedKeyEncryption, pairedKeyResult, parseOffline, randomId, type FileMeta, type TextMeta,
} from './frames.ts';
import { HANDSHAKE_MS } from './receiver.ts';
import { SecureChannel } from './secure.ts';
import { clientHandshake } from './ukey2.ts';

const CONNECT_MS = 10_000;
const FRAME_MS = 30_000;
/** How long the other device's user has to accept. */
const ANSWER_MS = 3 * 60_000;
const MAX_FILES = 1000;

export interface SendOptions {
  alias: string;
  deviceType: number;
  onProgress?: (sent: number, total: number) => void;
  /** The code to show while the other device asks its user. */
  onPin?: (pin: string) => void;
}

function endpointId(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 4 }, () => abc[randomInt(abc.length)]).join('');
}

const DECLINED: Record<number, string> = {
  [R_REJECT]: 'The other device declined.',
  [R_NOT_ENOUGH_SPACE]: 'The other device does not have enough space.',
  [R_UNSUPPORTED]: 'The other device cannot take these files.',
  [R_TIMED_OUT]: 'The other device did not answer in time.',
};

/** Sends files and/or text to a Quick Share receiver at host:port; resolves once everything is out. */
export async function sendTo(host: string, port: number, items: { paths: string[]; text?: string }, opts: SendOptions): Promise<void> {
  if (items.paths.length > MAX_FILES) throw new Error(`Quick Share takes at most ${MAX_FILES} files at a time.`);
  const files: (FileMeta & { path: string })[] = [];
  for (const path of items.paths) {
    const st = await stat(path);
    if (!st.isFile()) throw new Error(`${basename(path)} is not a file.`);
    files.push({ path, name: basename(path), size: st.size, payloadId: randomId(), ...mimeOf(basename(path)) });
  }
  const text = items.text ? Buffer.from(items.text, 'utf8') : null;
  const texts: TextMeta[] = text && items.text
    ? [{ title: items.text.slice(0, 64), size: text.length, payloadId: randomId(), kind: /^https?:\/\/\S+$/i.test(items.text.trim()) ? 2 : 1 }]
    : [];
  if (files.length === 0 && texts.length === 0) throw new Error('Nothing to send.');
  const total = files.reduce((n, f) => n + f.size, 0) + (text?.length ?? 0);

  const sock = connect({ host, port });
  const framed = new Framed(sock);
  let channel: Channel | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Could not reach the device.')), CONNECT_MS);
      sock.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      sock.once('error', (e) => {
        clearTimeout(t);
        reject(new Error(`Could not reach the device: ${e.message}`));
      });
    });
    await framed.write(connectionRequest(endpointId(), opts.alias, endpointInfo(opts.alias, opts.deviceType)));
    const keys = await clientHandshake(framed, HANDSHAKE_MS);
    await framed.write(connectionResponse());
    const resp = parseOffline(await framed.next(HANDSHAKE_MS));
    if (resp.type !== F_CONNECTION_RESPONSE) throw new ChannelError('expected a connection response');
    const r = resp.v1.msg(3);
    if (r?.int(3) !== 1 && !(r?.int(3) === undefined && r?.int(1) === 0)) throw new Error('The other device refused the connection.');

    const ch = new Channel(framed, new SecureChannel(keys));
    channel = ch;
    opts.onPin?.(keys.pin);
    await ch.sendSharing(pairedKeyEncryption());
    await waitFor(ch, S_PAIRED_KEY_ENCRYPTION, FRAME_MS);
    await ch.sendSharing(pairedKeyResult());
    await waitFor(ch, S_PAIRED_KEY_RESULT, FRAME_MS);
    await ch.sendSharing(introduction(files, texts));
    const answer = await waitFor(ch, S_RESPONSE, ANSWER_MS);
    if (answer !== R_ACCEPT) throw new Error(DECLINED[answer ?? -1] ?? 'The other device did not take the files.');

    let sent = 0;
    opts.onProgress?.(0, total);
    for (const f of files) {
      await ch.sendFile(f.payloadId, f.path, f.size, (n) => {
        sent += n;
        opts.onProgress?.(sent, total);
      });
    }
    if (text && texts[0]) {
      await ch.sendBytes(texts[0].payloadId, text);
      opts.onProgress?.(total, total);
    }
    await ch.close();
    channel = null;
  } finally {
    channel?.destroy();
    framed.destroy();
  }
}

async function waitFor(ch: Channel, type: number, timeoutMs: number): Promise<number | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await ch.nextSharing(Math.max(1, until - Date.now())).catch((e: unknown) => {
      throw e instanceof ChannelError && e.message === 'timed out' ? new Error('The other device did not answer.') : e;
    });
    if (s.type === 6) throw new Error('The other device cancelled.');
    if (s.type === type) return s.status;
  }
}
