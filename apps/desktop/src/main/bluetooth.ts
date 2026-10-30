// M14 on the PC: Bluetooth links through BlueZ. A Python GI helper (build/meshdrop-bt.py) registers
// the MeshDrop RFCOMM profile and hands each connection over a private unix socket; the link
// manager in @meshdrop/core does the rest (HELLO, trust, mux). It also reports phones that play their
// sound here as Bluetooth audio (A2DP, like earbuds): PipeWire plays that by itself.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { BtBonded, BtPlatform } from '@meshdrop/core/src/bt/links.ts';
import type { StreamKind } from '../shared/api.ts';

const DIAL_TIMEOUT_MS = 25_000;
const REPLY_TIMEOUT_MS = 15_000;
/** The first line of a bridged connection: who it is, and which dial it answers. */
const MAX_HEAD = 512;

export interface BluezOptions {
  script: string;
  /** Tests: another interpreter or fake helper. */
  python?: string;
}

/** A device playing its sound on this PC as Bluetooth audio. */
export interface BtAudioSource { address: string; name: string }

export interface BluezPlatform extends BtPlatform {
  /** `cb` gets the devices playing their sound here as Bluetooth audio, at start and on every change. */
  onAudio(cb: (sources: BtAudioSource[]) => void): void;
  /** Ends a device's Bluetooth audio to this PC. */
  audioStop(address: string): Promise<void>;
}

/** The Live now entries for Bluetooth audio: the MeshDrop device behind each address, else its Bluetooth name. */
export function a2dpStreams(
  sources: BtAudioSource[],
  deviceOf: (address: string) => string | undefined,
  aliasOf: (deviceId: string) => string | undefined,
): { id: string; kind: StreamKind; peer: string; alias: string }[] {
  return sources.map((s) => {
    const peer = deviceOf(s.address) ?? '';
    return { id: `bt-audio:${s.address}`, kind: 'bt-audio', peer, alias: (peer && aliasOf(peer)) || s.name };
  });
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The PC's Bluetooth: starts the helper on listen(), stops it on stop(). */
export function bluezPlatform(opts: BluezOptions): BluezPlatform {
  let proc: ChildProcess | null = null;
  let server: Server | null = null;
  let dir: string | null = null;
  let onConn: ((c: Duplex, address: string) => void) | null = null;
  let seq = 0;
  let onAudio: ((s: BtAudioSource[]) => void) | null = null;
  let audio: BtAudioSource[] = [];
  const setAudio = (s: BtAudioSource[]) => {
    if (JSON.stringify(s) === JSON.stringify(audio)) return;
    audio = s;
    onAudio?.(s);
  };
  const pending = new Map<number, Pending>();

  const fail = (e: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  };

  const ask = <T>(msg: Record<string, unknown>, ms: number): Promise<T> => {
    const p = proc;
    if (!p?.stdin?.writable) return Promise.reject(new Error('Bluetooth is not running.'));
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Bluetooth did not answer.'));
      }, ms);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin!.write(JSON.stringify({ ...msg, id }) + '\n');
    });
  };

  const onLine = (line: string, ready: (e?: Error) => void) => {
    let m: { ready?: boolean; error?: string; id?: number; bonded?: BtBonded[]; ok?: boolean; audio?: BtAudioSource[] };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (m.id === undefined) {
      if (m.ready) ready();
      else if (m.error) ready(new Error(m.error));
      else if (Array.isArray(m.audio)) setAudio(m.audio.filter((a) => typeof a?.address === 'string').map((a) => ({ address: a.address.toUpperCase(), name: typeof a.name === 'string' ? a.name : a.address })));
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    // a dial's success is its connection arriving on the bridge; only its failure comes here
    if (m.error === undefined && m.bonded === undefined && m.ok === undefined) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.bonded);
  };

  /** A bridged connection: one JSON line naming the device, then the RFCOMM bytes. */
  const onBridge = (s: Socket) => {
    let head = Buffer.alloc(0);
    // 'readable' mode for the header: once its listener is gone the socket is neither flowing nor
    // paused, so the link's own 'data' listener starts it with nothing lost.
    const onReadable = () => {
      let c: Buffer | null;
      while ((c = s.read() as Buffer | null) !== null) {
        head = Buffer.concat([head, c]);
        const i = head.indexOf(10);
        if (i < 0) {
          if (head.length > MAX_HEAD) s.destroy();
          continue;
        }
        s.off('readable', onReadable);
        const rest = head.subarray(i + 1);
        if (rest.length) s.unshift(rest);
        handOver(s, head.subarray(0, i));
        return;
      }
    };
    s.on('readable', onReadable);
    s.on('error', () => s.destroy());
  };

  const handOver = (s: Socket, line: Buffer) => {
    let h: { address?: unknown; dial?: unknown };
    try {
      h = JSON.parse(line.toString('utf8')) as typeof h;
    } catch {
      return void s.destroy();
    }
    if (typeof h.address !== 'string') return void s.destroy();
    const d = typeof h.dial === 'number' ? pending.get(h.dial) : undefined;
    if (d) {
      pending.delete(h.dial as number);
      clearTimeout(d.timer);
      d.resolve(s);
    } else if (onConn) onConn(s, h.address);
    else s.destroy();
  };

  const stop = () => {
    onConn = null;
    fail(new Error('Bluetooth stopped.'));
    proc?.kill();
    proc = null;
    setAudio([]);
    server?.close();
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  };

  return {
    async listen(cb) {
      if (!existsSync(opts.script)) throw new Error('Bluetooth is not installed in this build.');
      stop();
      dir = mkdtempSync(join(tmpdir(), 'meshdrop-bt-')); // 0700: only this user reaches the bridge
      const sock = join(dir, 'bridge');
      const srv = createServer(onBridge);
      server = srv;
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(sock, () => resolve());
      });
      const p = spawn(opts.python ?? 'python3', [opts.script, sock], { stdio: ['pipe', 'pipe', 'ignore'] });
      proc = p;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const ready = (e?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (e) {
            stop();
            reject(e);
          } else resolve();
        };
        const timer = setTimeout(() => ready(new Error('Bluetooth did not start.')), REPLY_TIMEOUT_MS);
        let buf = '';
        p.stdout!.setEncoding('utf8');
        p.stdout!.on('data', (c: string) => {
          buf += c;
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            onLine(line, ready);
          }
        });
        p.stdin!.on('error', () => undefined);
        p.on('error', () => ready(new Error('Bluetooth needs python3 with GObject (python3-gi).')));
        p.on('exit', () => {
          ready(new Error('Bluetooth stopped.'));
          if (proc === p) {
            proc = null;
            fail(new Error('Bluetooth stopped.'));
          }
        });
      });
      onConn = cb;
    },
    async bonded() {
      return proc ? ask<BtBonded[]>({ t: 'bonded' }, REPLY_TIMEOUT_MS) : [];
    },
    dial(address) {
      return ask<Duplex>({ t: 'dial', address }, DIAL_TIMEOUT_MS);
    },
    onAudio(cb) {
      onAudio = cb;
    },
    async audioStop(address) {
      await ask<unknown>({ t: 'audio-stop', address }, REPLY_TIMEOUT_MS);
    },
    stop,
  };
}
