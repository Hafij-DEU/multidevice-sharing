// Linux clipboard reads in a helper process. Since Electron 42 every clipboard read spins a nested
// run loop until the selection owner answers, and Chromium (M148) gave up the request timeout:
// a slow or stuck owner froze MeshDrop's main thread, timers and sockets with it, for seconds.
// The helper is this same app started with MESHDROP_CLIP_HELPER=<its profile dir> and no windows; it answers one
// JSON line per request on stdout. A read it does not answer in time gets it killed, never waited on.
import { app, clipboard, type NativeImage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const CLIP_HELPER_ENV = 'MESHDROP_CLIP_HELPER';

export type ClipOp = { op: 'text' } | { op: 'buffer'; format: string } | { op: 'image' } | { op: 'png'; key: string };

/** Runs in the helper: answers clipboard reads until stdin closes. */
export function runClipHelper(profile: string): void {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile); // never the app's own Chromium profile
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  let last: { key: string; img: NativeImage } | null = null;
  const answer = (req: ClipOp): unknown => {
    switch (req.op) {
      case 'text':
        return clipboard.readText();
      case 'buffer':
        return clipboard.readBuffer(req.format).toString('base64');
      case 'image': {
        if (!clipboard.availableFormats().some((f) => f.startsWith('image/'))) return null;
        const img = clipboard.readImage();
        if (img.isEmpty()) return null;
        last = { key: createHash('sha1').update(img.toBitmap()).digest('hex'), img };
        return last.key;
      }
      case 'png':
        return last?.key === req.key ? last.img.toPNG().toString('base64') : null;
    }
  };
  void app.whenReady().then(() => {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let id: unknown = null;
      try {
        const req = JSON.parse(line) as ClipOp & { id: number };
        id = req.id;
        process.stdout.write(`${JSON.stringify({ id, ok: answer(req) })}\n`);
      } catch (x) {
        process.stdout.write(`${JSON.stringify({ id, err: x instanceof Error ? x.message : String(x) })}\n`);
      }
    });
    rl.on('close', () => app.exit(0));
  });
}

/** Chromium switches the helper must share with this process (display backend, sandbox). */
function passedSwitches(argv: string[]): string[] {
  return argv.filter((a) => /^--(ozone-platform|ozone-platform-hint|enable-features|disable-features|enable-wayland-ime|no-sandbox)(=|$)/.test(a));
}

/**
 * Main-process side: clipboard reads that never block this thread. Each read resolves within
 * `timeoutMs` or rejects; a helper that misses it is killed (it is stuck in the owner's wait)
 * and the next read after `backoffMs` starts a fresh one. A helper that never answers at all
 * (3 starts that died) makes the reader unusable: the caller then reads in-process as before.
 */
export class ClipReader {
  #child: ChildProcess | null = null;
  #next = 1;
  #pending = new Map<number, { ok: (v: unknown) => void; err: (x: Error) => void; timer: NodeJS.Timeout }>();
  #retryAt = 0;
  #closed = false;
  #answered = false;
  #deadStarts = 0;

  readonly #command: { exe: string; args: string[]; profile: string };
  readonly #timeoutMs: number;
  readonly #backoffMs: number;

  constructor(command: { exe: string; args: string[]; profile: string }, timeoutMs = 2000, backoffMs = 5000) {
    this.#command = command;
    this.#timeoutMs = timeoutMs;
    this.#backoffMs = backoffMs;
  }

  /** The command that starts this app as the helper, with its own Chromium profile in `profile`. */
  static self(profile: string): { exe: string; args: string[]; profile: string } {
    // Unpackaged (`electron <entry>`), the same entry: what Electron's docs pass for a relaunch.
    const entry = process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : [];
    // basic: the helper stores nothing, and the keyring would be D-Bus-activated on every start
    return { exe: process.execPath, args: [...entry, ...passedSwitches(process.argv), '--password-store=basic'], profile };
  }

  text(): Promise<string> {
    return this.#ask({ op: 'text' }) as Promise<string>;
  }

  async buffer(format: string): Promise<Buffer> {
    return Buffer.from((await this.#ask({ op: 'buffer', format })) as string, 'base64');
  }

  /** The image on the clipboard: a key that changes with its pixels (null: no image). */
  image(): Promise<string | null> {
    return this.#ask({ op: 'image' }) as Promise<string | null>;
  }

  /** The PNG of the image last returned by image(), if it still has that key. */
  async png(key: string): Promise<Buffer> {
    const b64 = (await this.#ask({ op: 'png', key })) as string | null;
    if (b64 === null) throw new Error('The copied image changed.');
    return Buffer.from(b64, 'base64');
  }

  close(): void {
    this.#closed = true;
    this.#kill(new Error('closed'));
  }

  /** False once the helper has died 3 times without ever answering a read. */
  get usable(): boolean {
    return this.#answered || this.#deadStarts < 3;
  }

  /** Test hook: the helper's process id (undefined when none runs). */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  #ask(req: ClipOp): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('closed'));
    if (!this.usable) return Promise.reject(new Error('clipboard helper unusable'));
    if (!this.#child && Date.now() < this.#retryAt) return Promise.reject(new Error('clipboard helper backing off'));
    const child = this.#child ?? this.#start();
    const id = this.#next++;
    return new Promise((ok, err) => {
      const timer = setTimeout(() => {
        this.#retryAt = Date.now() + this.#backoffMs;
        this.#kill(new Error(`clipboard read timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { ok, err, timer });
      child.stdin!.write(`${JSON.stringify({ ...req, id })}\n`);
    });
  }

  #start(): ChildProcess {
    const child = spawn(this.#command.exe, this.#command.args, {
      env: { ...process.env, [CLIP_HELPER_ENV]: this.#command.profile },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#child = child;
    child.stdin!.on('error', () => {}); // a dead helper: its reads fail through 'exit'
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: { id?: number; ok?: unknown; err?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return; // Chromium chatter on stdout
      }
      const p = typeof msg.id === 'number' ? this.#pending.get(msg.id) : undefined;
      if (!p) return;
      this.#pending.delete(msg.id!);
      this.#answered = true;
      clearTimeout(p.timer);
      if (msg.err !== undefined) p.err(new Error(msg.err));
      else p.ok(msg.ok);
    });
    child.on('exit', () => this.#died(child, 'clipboard helper exited'));
    child.on('error', () => this.#died(child, 'clipboard helper could not start'));
    return child;
  }

  /** The helper went away on its own (not killed by us): back off like after a stuck read. */
  #died(child: ChildProcess, why: string): void {
    if (this.#child !== child) return;
    this.#retryAt = Date.now() + this.#backoffMs;
    if (!this.#answered) this.#deadStarts++;
    this.#kill(new Error(why));
  }

  #kill(why: Error): void {
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.err(why);
    }
    this.#pending.clear();
  }
}
