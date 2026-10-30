import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }));
const { mediaPipe } = await import('../src/main/remote.ts');

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A shell helper that writes its pid to a file first (exec keeps the pid). */
function helper(body: string): { args: string[]; pid: () => number } {
  const d = mkdtempSync(join(tmpdir(), 'md-pipe-'));
  tmps.push(d);
  const f = join(d, 'pid');
  return { args: ['-c', `echo $$ > ${f}; ${body}`], pid: () => Number(readFileSync(f, 'utf8')) };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('mediaPipe', () => {
  it('kills a helper that ignores SIGTERM', async () => {
    // a stuck pw-cat blocks SIGTERM while its PipeWire loop hangs
    const h = helper('trap "" TERM; exec sleep 30');
    const p = mediaPipe('sh', h.args, 'in', { killAfterMs: 200 });
    await expect.poll(() => h.pid()).toBeGreaterThan(0);
    const pid = h.pid();
    p.stop();
    await expect.poll(() => alive(pid), { timeout: 3000 }).toBe(false);
  });

  it('stops a helper that stops reading its input', async () => {
    const h = helper('exec sleep 30');
    const p = mediaPipe('sh', h.args, 'in', { stallMs: 300 });
    const exited = vi.fn();
    p.onExit(exited);
    await expect.poll(() => h.pid()).toBeGreaterThan(0);
    const chunk = Buffer.alloc(64 * 1024);
    while (p.in!.write(chunk));
    await expect.poll(() => exited.mock.calls.length, { timeout: 3000 }).toBe(1);
    await expect.poll(() => alive(h.pid()), { timeout: 3000 }).toBe(false);
  });

  it('keeps a helper that reads', async () => {
    const p = mediaPipe('sh', ['-c', 'exec cat > /dev/null'], 'in', { stallMs: 300 });
    const exited = vi.fn();
    p.onExit(exited);
    const chunk = Buffer.alloc(64 * 1024);
    for (let i = 0; i < 20; i++) {
      p.in!.write(chunk);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(exited).not.toHaveBeenCalled();
    p.stop();
  });
});
