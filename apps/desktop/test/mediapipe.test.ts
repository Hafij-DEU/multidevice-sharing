import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }));
const { cameraArgs, mediaPipe } = await import('../src/main/remote.ts');

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

  // the webcam froze: with no app showing the camera, pipewiresink stopped taking frames, the phone's
  // upload backed up and its end never arrived, so the stale camera stayed and apps kept showing it
  const gst = spawnSync('gst-launch-1.0', ['--version']).status === 0 && spawnSync('pw-cli', ['info', '0']).status === 0;
  it.skipIf(!gst)('keeps taking webcam frames while no app shows the camera', async () => {
    const frame = spawnSync('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=1', '!', 'video/x-raw,width=640,height=480', '!', 'jpegenc', '!', 'fdsink', 'fd=1']).stdout;
    expect(frame.length).toBeGreaterThan(1000);
    const p = mediaPipe('gst-launch-1.0', cameraArgs('Test', 'meshdrop-test-camera'), 'in');
    let frames = 0;
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (p.in!.write(frame)) frames++;
      else {
        await new Promise<void>((r) => {
          const done = () => {
            clearTimeout(t);
            p.in!.off('drain', done);
            r();
          };
          const t = setTimeout(done, 200);
          p.in!.once('drain', done);
        });
      }
    }
    p.stop();
    // the phone sends 30 a second: all of them must go through
    expect(frames).toBeGreaterThan(90);
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
