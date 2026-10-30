// M10 on the PC: remote input through the RemoteDesktop portal (a Python GI helper), the laser dot,
// PC actions, the app list, ringing (Find my device) and this PC's own status.
import { BrowserWindow, screen } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceStatus } from '../shared/api.ts';
import type { InputPrim, MediaPipe, Platform } from './controller.ts';

const run = promisify(execFile);
const READY_TIMEOUT_MS = 90_000; // the first time the user answers GNOME's dialog
const KILL_AFTER_MS = 2000;
// PipeWire's audio sinks take input in real time even when nobody listens: a longer stall means a stuck helper
const STALL_MS = 5000;
const RING_SOUND = '/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga';

/** The input helper: started on first use, kept running; null after it failed (retried next time). */
class InputHelper {
  #proc: ChildProcess | null = null;
  #ready: Promise<void> | null = null;

  readonly script: string;
  readonly tokenFile: string;

  constructor(script: string, tokenFile: string) {
    this.script = script;
    this.tokenFile = tokenFile;
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      if (!existsSync(this.script)) return reject(new Error('Remote control is not installed in this build.'));
      const p = spawn('python3', [this.script, this.tokenFile], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.#proc = p;
      let buf = '';
      let settled = false;
      const done = (e?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (e) {
          this.#reset();
          reject(e);
        } else resolve();
      };
      const timer = setTimeout(() => done(new Error('Allow remote interaction on the PC (GNOME asked for it) and try again.')), READY_TIMEOUT_MS);
      p.stdout!.setEncoding('utf8');
      p.stdout!.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line) as { ready?: boolean; error?: string };
            if (m.ready) done();
            else if (m.error) done(new Error(m.error === 'the remote control request was declined' ? 'Remote control was declined on the PC.' : m.error));
          } catch {
            /* not ours */
          }
        }
      });
      p.on('error', () => done(new Error('Remote control needs python3 with GObject (python3-gi).')));
      p.on('exit', () => {
        done(new Error('Remote control stopped on the PC.'));
        this.#reset();
      });
    });
    return this.#ready;
  }

  #reset(): void {
    this.#proc?.kill();
    this.#proc = null;
    this.#ready = null;
  }

  async send(prims: InputPrim[]): Promise<void> {
    await this.#start();
    const p = this.#proc;
    if (!p?.stdin?.writable) throw new Error('Remote control stopped on the PC.');
    p.stdin.write(prims.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }

  stop(): void {
    this.#reset();
  }
}

/** A transparent, click-through window over the whole screen that draws the laser dot. */
export class Laser {
  #win: BrowserWindow | null = null;
  #hide: NodeJS.Timeout | null = null;

  show(x: number, y: number, on: boolean): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!on) {
      this.#win?.hide();
      return;
    }
    const d = screen.getPrimaryDisplay().bounds;
    if (!this.#win || this.#win.isDestroyed()) {
      this.#win = new BrowserWindow({
        x: d.x, y: d.y, width: d.width, height: d.height, transparent: true, frame: false, alwaysOnTop: true, focusable: false,
        skipTaskbar: true, resizable: false, hasShadow: false, show: false, webPreferences: { sandbox: true, contextIsolation: true },
      });
      this.#win.setIgnoreMouseEvents(true);
      this.#win.setAlwaysOnTop(true, 'screen-saver');
      void this.#win.loadURL(
        'data:text/html,' +
          encodeURIComponent(
            '<html><body style="margin:0;background:transparent;overflow:hidden"><div id="d" style="position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:radial-gradient(#ff3b3b 30%,rgba(255,0,0,.35) 70%,transparent);box-shadow:0 0 18px 6px rgba(255,40,40,.6)"></div></body></html>',
          ),
      );
    }
    const px = Math.round(Math.max(0, Math.min(1, x)) * d.width);
    const py = Math.round(Math.max(0, Math.min(1, y)) * d.height);
    void this.#win.webContents.executeJavaScript(`(()=>{const s=document.getElementById('d').style;s.left='${px}px';s.top='${py}px'})()`).catch(() => {});
    if (!this.#win.isVisible()) this.#win.showInactive();
    if (this.#hide) clearTimeout(this.#hide);
    this.#hide = setTimeout(() => this.#win?.hide(), 3000); // no news from the phone: the dot goes
  }

  close(): void {
    if (this.#hide) clearTimeout(this.#hide);
    this.#hide = null;
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = null;
  }
}

/** Applications in the app grid (.desktop files that are shown), by id. */
export function listApps(dirs = appDirs()): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.desktop') || out.has(n.slice(0, -8))) continue;
      try {
        const t = readFileSync(join(dir, n), 'utf8');
        const main = t.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) ?? '';
        const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(main)?.[1]?.trim();
        if (get('Type') !== 'Application' || get('NoDisplay') === 'true' || get('Hidden') === 'true' || !get('Name')) continue;
        out.set(n.slice(0, -8), get('Name')!);
      } catch {
        /* unreadable */
      }
    }
  }
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400);
}

function appDirs(): string[] {
  const data = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  return [join(homedir(), '.local/share/applications'), ...data.map((d) => join(d, 'applications')), '/var/lib/snapd/desktop/applications', '/var/lib/flatpak/exports/share/applications'];
}

/** This PC's battery (if it has one) and the free space where received files go. */
function pcStatus(inboxDir: string): Omit<DeviceStatus, 'at'> {
  const s: Omit<DeviceStatus, 'at'> = {};
  try {
    const bat = readdirSync('/sys/class/power_supply').find((n) => n.startsWith('BAT'));
    if (bat) {
      const level = Number(readFileSync(`/sys/class/power_supply/${bat}/capacity`, 'utf8'));
      const st = readFileSync(`/sys/class/power_supply/${bat}/status`, 'utf8').trim();
      if (Number.isFinite(level)) s.battery = { level, charging: st === 'Charging' || st === 'Full' };
    }
  } catch {
    /* no battery */
  }
  try {
    const f = statfsSync(existsSync(inboxDir) ? inboxDir : homedir());
    s.storage = { free: f.bavail * f.bsize, total: f.blocks * f.bsize };
  } catch {
    /* unknown */
  }
  return s;
}

/** SIGTERM, then SIGKILL if it is still running: a stuck pw-cat blocks SIGTERM while its PipeWire loop hangs. */
function killHard(p: ChildProcess, afterMs = KILL_AFTER_MS): void {
  const running = () => p.exitCode === null && p.signalCode === null;
  if (!running()) return;
  p.kill();
  setTimeout(() => running() && p.kill('SIGKILL'), afterMs).unref();
}

/**
 * A helper process as a MediaPipe (its stdin or stdout carries the media). With `stallMs`, a helper
 * that takes no input for that long is stopped: a stuck one would otherwise hold the phone's upload open.
 */
export function mediaPipe(cmd: string, args: string[], dir: 'in' | 'out', opts: { stallMs?: number; killAfterMs?: number } = {}): MediaPipe {
  const p = spawn(cmd, args, { stdio: dir === 'in' ? ['pipe', 'ignore', 'ignore'] : ['ignore', 'pipe', 'ignore'] });
  const exits: (() => void)[] = [];
  let done = false;
  let watchdog: NodeJS.Timeout | undefined;
  const fire = () => {
    if (done) return;
    done = true;
    clearInterval(watchdog);
    for (const f of exits) f();
  };
  const stop = () => {
    killHard(p, opts.killAfterMs);
    fire();
  };
  p.on('exit', fire);
  p.on('error', fire);
  (dir === 'in' ? p.stdin! : p.stdout!).on('error', () => {});
  if (dir === 'in' && opts.stallMs) {
    const stallMs = opts.stallMs;
    let since = 0;
    watchdog = setInterval(() => {
      if (!p.stdin!.writableNeedDrain) since = 0;
      else if (!since) since = Date.now();
      else if (Date.now() - since >= stallMs) stop();
    }, Math.min(500, stallMs / 3));
    watchdog.unref();
  }
  return {
    ...(dir === 'in' ? { in: p.stdin! } : { out: p.stdout! }),
    stop,
    onExit: (cb) => exits.push(cb),
  };
}

/** A device name made safe for PipeWire properties. */
const label = (s: string) => s.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Phone';

/** The gst-launch arguments that turn back-to-back JPEG frames into the PipeWire camera `node`. */
export function cameraArgs(name: string, node = 'meshdrop-camera'): string[] {
  return [
    '-q', 'fdsrc', 'fd=0', 'do-timestamp=true', '!', 'jpegparse', '!',
    // pipewiresink takes no frames while no app shows the camera: drop the oldest instead of blocking, so the
    // phone's upload keeps flowing and its end arrives (a blocked one left a stale, frozen camera behind)
    'queue', 'leaky=downstream', 'max-size-buffers=2', 'max-size-bytes=0', 'max-size-time=0', '!', 'jpegdec', '!', 'videoconvert', '!', 'video/x-raw,format=YUY2', '!',
    // gst-launch re-parses its arguments: the description's quotes must be escaped inside the quoted value
    'pipewiresink', `stream-properties="props,media.class=Video/Source,media.role=Camera,node.name=${node},node.description=\\"${label(name)} camera (MeshDrop)\\""`,
  ];
}

/** Media for M10b: this PC's sound out, a phone's camera and microphone in (PipeWire, no root). */
export function mediaPlatform(): Required<Pick<Platform, 'captureAudio' | 'cameraSink' | 'micSink' | 'speakerSink'>> {
  return {
    // what the speakers play (the default sink's monitor)
    captureAudio: () => mediaPipe('pw-record', ['--raw', '--latency', '20ms', '-P', '{ stream.capture.sink=true node.name=meshdrop-cast }', '--format', 's16', '--rate', '48000', '--channels', '2', '-'], 'out'),
    // another device's sound (s16le 48 kHz stereo) -> this PC's speakers
    speakerSink: (name) =>
      mediaPipe('pw-cat', ['--playback', '--raw', '--latency', '20ms', '--format', 's16', '--rate', '48000', '--channels', '2', '-P', `{ node.name=meshdrop-sound media.name="Sound from ${label(name)}" }`, '-'], 'in', { stallMs: STALL_MS }),
    // back-to-back JPEG frames -> a PipeWire video source that browsers and call apps can pick
    cameraSink: (name) => mediaPipe('gst-launch-1.0', cameraArgs(name), 'in'),
    // s16le 48 kHz mono -> a virtual microphone (a null-sink loopback whose source side apps record from)
    micSink: (name) => {
      const loop = spawn('pw-loopback', [
        '--capture-props', 'media.class=Audio/Sink node.name=meshdrop-mic-in node.description="MeshDrop mic input" audio.position=[MONO]',
        '--playback-props', `media.class=Audio/Source node.name=meshdrop-mic node.description="${label(name)} microphone (MeshDrop)" audio.position=[MONO]`,
      ], { stdio: 'ignore' });
      const cat = mediaPipe('pw-cat', ['--playback', '--raw', '--latency', '20ms', '--target', 'meshdrop-mic-in', '--format', 's16', '--rate', '48000', '--channels', '1', '-'], 'in', { stallMs: STALL_MS });
      return {
        in: cat.in!,
        stop: () => {
          cat.stop();
          killHard(loop);
        },
        onExit: (cb) => cat.onExit(() => {
          killHard(loop);
          cb();
        }),
      };
    },
  };
}

/** The M10 part of the Electron platform. */
export function remotePlatform(opts: { home: string; script: string; inbox: () => string; openUrl: (u: string) => Promise<void> }): Required<Pick<Platform, 'input' | 'laser' | 'pcAction' | 'apps' | 'openApp' | 'ring' | 'openUrl' | 'status' | 'dispose'>> {
  const input = new InputHelper(opts.script, join(opts.home, 'input-token'));
  const laser = new Laser();
  let ringing: ChildProcess | null = null;
  let ringLoop = false;
  const ringOnce = () => {
    if (!ringLoop) return;
    ringing = spawn('pw-play', ['--volume', '1.0', RING_SOUND], { stdio: 'ignore' });
    ringing.on('error', () => (ringLoop = false));
    ringing.on('exit', () => setTimeout(ringOnce, 200));
  };
  return {
    // Tests (MESHDROP_TEST_INPUT_LOG): input is written to a file instead of reaching the desktop.
    input: process.env.MESHDROP_TEST_INPUT_LOG
      ? async (prims) => appendFileSync(process.env.MESHDROP_TEST_INPUT_LOG!, prims.map((x) => JSON.stringify(x) + '\n').join(''))
      : (prims) => input.send(prims),
    laser: (x, y, on) => laser.show(x, y, on),
    pcAction: async (a) => {
      const cmd: Record<typeof a, [string, string[]]> = {
        lock: ['loginctl', ['lock-session']],
        sleep: ['systemctl', ['suspend']],
        shutdown: ['systemctl', ['poweroff']],
        restart: ['systemctl', ['reboot']],
      };
      const [c, args] = cmd[a];
      await run(c, args, { timeout: 15_000 });
    },
    apps: async () => listApps(),
    openApp: async (id) => {
      if (!listApps().some((a) => a.id === id)) throw new Error('no such app');
      await run('gtk-launch', [id], { timeout: 15_000 });
    },
    ring: (on) => {
      ringLoop = on;
      if (on && !ringing) ringOnce();
      if (!on) {
        ringing?.kill();
        ringing = null;
      }
    },
    openUrl: opts.openUrl,
    status: async () => pcStatus(opts.inbox()),
    dispose: () => {
      input.stop();
      laser.close();
      ringLoop = false;
      ringing?.kill();
      ringing = null;
    },
  };
}
