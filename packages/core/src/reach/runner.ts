// External programs for internet reach (tailscale, cloudflared): always execFile (no shell), and
// injectable so tests drive fakes. A missing program is code 127, like a shell would report.
import { execFile, spawn, type ChildProcess } from 'node:child_process';

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
export type Spawner = (cmd: string, args: string[]) => ChildProcess;

export const execRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    // SIGKILL: a CLI waiting on a prompt (tailscale funnel) ignores SIGTERM and would never end
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = !e ? 0 : e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (e && e.code === 'ENOENT' ? `${cmd}: not found` : '') });
    });
  });

export const execSpawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
