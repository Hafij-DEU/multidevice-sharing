// Windows desktop integration: what remote.ts and desktop.ts do on Linux, with Windows' own tools.
// Remote input (a PowerShell SendInput helper), PC actions, Start menu apps, ringing, battery, copied
// files on the clipboard, printing and the clipboard keyboard shortcut. Electron-free except where noted.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import type { DeviceStatus } from '../shared/api.ts';
import type { InputPrim, Platform } from './controller.ts';

const run = promisify(execFile);
const READY_TIMEOUT_MS = 30_000; // PowerShell compiles the helper the first time
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RING_SOUND = join(SYSTEM_ROOT, 'Media', 'Alarm01.wav');

/** powershell.exe running `command`; values go in through `env` (never spliced into the command). */
function powershell(command: string, env: Record<string, string> = {}, timeout = 30_000): Promise<string> {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    timeout,
    windowsHide: true,
    env: { ...process.env, ...env },
  }).then((r) => r.stdout);
}

/** The input helper (build/meshdrop-input.ps1): started on first use, kept running; reset after a failure. */
class WinInputHelper {
  #proc: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  readonly script: string;

  constructor(script: string) {
    this.script = script;
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      if (!existsSync(this.script)) return reject(new Error('Remote control is not installed in this build.'));
      const p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
      const timer = setTimeout(() => done(new Error('Remote control did not start on the PC.')), READY_TIMEOUT_MS);
      p.stdout!.setEncoding('utf8');
      p.stdout!.on('data', (c: string) => {
        buf += c;
        if (/"ready":\s*true/.test(buf)) done();
      });
      p.on('error', () => done(new Error('Remote control needs Windows PowerShell.')));
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
}

/** The Start menu folders (all users, then this user). */
function startMenuDirs(): string[] {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return [join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
}

/** Start menu shortcuts by id (`<folder index>/<path inside it>`), without uninstallers and help links. */
export function listStartMenuApps(dirs = startMenuDirs()): { id: string; name: string; path: string }[] {
  const out = new Map<string, { id: string; name: string; path: string }>();
  dirs.forEach((root, i) => {
    const walk = (dir: string, depth: number) => {
      let ents;
      try {
        ents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && /\.(lnk|url)$/i.test(e.name)) {
          const name = e.name.replace(/\.(lnk|url)$/i, '');
          if (/uninstall|readme|help|documentation|website/i.test(name) || out.has(name.toLowerCase())) continue;
          out.set(name.toLowerCase(), { id: `${i}/${relative(root, p).replace(/\\/g, '/')}`, name, path: p });
        }
      }
    };
    walk(root, 0);
  });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400);
}

/** Battery (Win32_Battery's status: 1 discharging, 4/5 low/critical, the rest on power). */
export function parseBattery(out: string): DeviceStatus['battery'] | undefined {
  const [level, status] = out.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(level) || !Number.isFinite(status)) return undefined;
  return { level: level!, charging: ![1, 4, 5].includes(status!) };
}

async function winStatus(inboxDir: string): Promise<Omit<DeviceStatus, 'at'>> {
  const s: Omit<DeviceStatus, 'at'> = {};
  try {
    const out = await powershell('$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { "$($b.EstimatedChargeRemaining) $($b.BatteryStatus)" }', {}, 15_000);
    const bat = parseBattery(out);
    if (bat) s.battery = bat;
  } catch {
    /* no battery, or no answer */
  }
  try {
    const f = statfsSync(existsSync(inboxDir) ? inboxDir : homedir());
    s.storage = { free: f.bavail * f.bsize, total: f.blocks * f.bsize };
  } catch {
    /* unknown */
  }
  return s;
}

/** The M10 part of the Electron platform on Windows. */
export function winRemotePlatform(opts: {
  script: string;
  inbox: () => string;
  openUrl: (u: string) => Promise<void>;
  openPath: (p: string) => Promise<void>;
  laser: (x: number, y: number, on: boolean) => void;
}): Required<Pick<Platform, 'input' | 'laser' | 'pcAction' | 'apps' | 'openApp' | 'ring' | 'openUrl' | 'status'>> {
  const input = new WinInputHelper(opts.script);
  let ringing: ChildProcess | null = null;
  return {
    // Tests (MESHDROP_TEST_INPUT_LOG): input is written to a file instead of reaching the desktop.
    input: process.env.MESHDROP_TEST_INPUT_LOG
      ? async (prims) => appendFileSync(process.env.MESHDROP_TEST_INPUT_LOG!, prims.map((x) => JSON.stringify(x) + '\n').join(''))
      : (prims) => input.send(prims),
    laser: opts.laser,
    pcAction: async (a) => {
      const rundll = join(SYSTEM_ROOT, 'System32', 'rundll32.exe');
      const shutdown = join(SYSTEM_ROOT, 'System32', 'shutdown.exe');
      if (a === 'lock') await run(rundll, ['user32.dll,LockWorkStation'], { timeout: 15_000, windowsHide: true });
      else if (a === 'sleep') await powershell("Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)", {}, 15_000);
      else await run(shutdown, [a === 'restart' ? '/r' : '/s', '/t', '0'], { timeout: 15_000, windowsHide: true });
    },
    apps: async () => listStartMenuApps().map(({ id, name }) => ({ id, name })),
    openApp: async (id) => {
      const app = listStartMenuApps().find((a) => a.id === id);
      if (!app) throw new Error('no such app');
      await opts.openPath(app.path);
    },
    ring: (on) => {
      if (!on) {
        ringing?.kill();
        ringing = null;
        return;
      }
      if (ringing) return;
      // loud and looping until stopped (the controller stops it after a minute at most)
      ringing = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '$p = New-Object Media.SoundPlayer $env:MESHDROP_RING; while ($true) { $p.PlaySync() }'], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, MESHDROP_RING: RING_SOUND },
      });
      const self = ringing;
      self.on('exit', () => {
        if (ringing === self) ringing = null;
      });
      self.on('error', () => {
        if (ringing === self) ringing = null;
      });
    },
    openUrl: opts.openUrl,
    status: () => winStatus(opts.inbox()),
  };
}

/** Files copied in Explorer: the first one (Explorer's FileNameW clipboard format, UTF-16 with a NUL). */
export function parseFileNameW(buf: Buffer): string[] {
  const p = buf.toString('utf16le').replace(/\0.*$/s, '');
  return p ? [p] : [];
}

/** Puts files on the clipboard the way Explorer's Copy does (Windows PowerShell's Set-Clipboard). */
export function writeClipboardFilesWin(paths: string[]): void {
  void powershell('Set-Clipboard -LiteralPath ($env:MESHDROP_PATHS -split "`n")', { MESHDROP_PATHS: paths.join('\n') }).catch(() => {});
}

/** Prints with the program Windows has for the file type (its "Print" verb). */
export async function printWin(p: string): Promise<void> {
  await powershell('Start-Process -FilePath $env:MESHDROP_PRINT -Verb Print', { MESHDROP_PRINT: p }, 30_000);
}

// ---- the "send clipboard" keyboard shortcut (Electron's globalShortcut, kept in a file) ----------

/** A GTK accelerator (`<Primary><Alt>c`, what Settings offers) as an Electron accelerator. */
export function gtkToAccelerator(binding: string): string {
  const mods: Record<string, string> = { primary: 'CommandOrControl', control: 'Control', ctrl: 'Control', alt: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super' };
  const parts: string[] = [];
  const re = /<([A-Za-z0-9]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(binding))) {
    const mod = mods[m[1]!.toLowerCase()];
    if (!mod) throw new Error(`unknown modifier ${m[1]}`);
    if (!parts.includes(mod)) parts.push(mod);
  }
  const key = binding.replace(re, '');
  if (!key) throw new Error('the shortcut needs a key');
  return [...parts, key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1)].join('+');
}

function shortcutFile(home: string): string {
  return join(home, 'clipboard-shortcut');
}

export function savedShortcut(home: string): string | null {
  try {
    return readFileSync(shortcutFile(home), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function saveShortcut(home: string, binding: string | null): void {
  if (binding === null) rmSync(shortcutFile(home), { force: true });
  else writeFileAtomic(shortcutFile(home), binding + '\n');
}
