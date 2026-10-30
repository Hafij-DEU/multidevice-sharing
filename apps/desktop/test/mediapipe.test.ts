import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }));
const { cameraArgs, loopbackDevice, mediaPipe } = await import('../src/main/remote.ts');

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

  // the webcam froze again: a video app that closed the camera (or reopened it to pick a format) made
  // pipewiresink fail with "all buffers have been removed", which ended the phone's stream
  it.skipIf(!gst)('keeps the webcam for the next app after one stops showing it', { timeout: 30_000 }, async () => {
    const frame = spawnSync('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=1', '!', 'video/x-raw,width=640,height=480', '!', 'jpegenc', '!', 'fdsink', 'fd=1']).stdout;
    const node = `meshdrop-test-camera-${process.pid}`;
    const p = mediaPipe('gst-launch-1.0', cameraArgs('Test', node), 'in');
    const exited = vi.fn();
    p.onExit(exited);
    let feeding = true;
    void (async () => {
      while (feeding) {
        p.in!.write(frame);
        await new Promise((r) => setTimeout(r, 33));
      }
    })();
    const id = async () => {
      for (let i = 0; i < 50; i++) {
        const dump = JSON.parse(spawnSync('pw-dump', { maxBuffer: 64 << 20 }).stdout.toString() || '[]') as { id: number; type: string; info?: { props?: Record<string, unknown>; 'n-output-ports'?: number } }[];
        // apps can open it once it offers its video port
        const n = dump.find((o) => o.type.endsWith('Node') && o.info?.props?.['node.name'] === node && (o.info['n-output-ports'] ?? 0) > 0);
        if (n) return n.id;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('no camera node');
    };
    const path = await id();
    // an app shows the camera for a second (30 frames), closes it, the next one opens it
    const view = () =>
      new Promise<number | null>((done) => {
        const v = spawn('gst-launch-1.0', ['-q', 'pipewiresrc', `path=${path}`, 'num-buffers=30', '!', 'videoconvert', '!', 'fakesink'], { stdio: 'ignore' });
        const t = setTimeout(() => v.kill('SIGKILL'), 5000);
        v.on('exit', (code) => {
          clearTimeout(t);
          done(code);
        });
      });
    const seen: (number | null)[] = [];
    for (let i = 0; i < 4; i++) seen.push(await view());
    feeding = false;
    const alive = exited.mock.calls.length === 0;
    p.stop();
    expect(seen).toEqual([0, 0, 0, 0]);
    expect(alive).toBe(true);
  });

  // browsers and call apps (Chrome, Zoom) only list V4L2 cameras: a v4l2loopback device carries the phone too
  it('finds the MeshDrop loopback camera device', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-v4l-'));
    tmps.push(d);
    const dev = (n: string, name: string) => {
      mkdirSync(join(d, n));
      writeFileSync(join(d, n, 'name'), `${name}\n`);
    };
    expect(loopbackDevice(d)).toBeNull();
    dev('video0', 'Integrated Camera: Integrated C');
    expect(loopbackDevice(d)).toBeNull();
    dev('video7', 'MeshDrop camera');
    expect(loopbackDevice(d)).toBe('/dev/video7');
    expect(loopbackDevice(join(d, 'missing'))).toBeNull();
  });

  it('sends the camera to the loopback device as well', () => {
    const args = cameraArgs('Test', 'meshdrop-camera', '/dev/video7');
    expect(args).toContain('pipewiresink');
    expect(args).toContain('v4l2sink');
    expect(args).toContain('device=/dev/video7');
    expect(cameraArgs('Test')).not.toContain('v4l2sink');
  });

  const loop = gst ? loopbackDevice() : null;
  it.skipIf(!loop)('shows the phone camera on the loopback device', { timeout: 20_000 }, async () => {
    const frame = spawnSync('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=1', '!', 'video/x-raw,width=640,height=480', '!', 'jpegenc', '!', 'fdsink', 'fd=1']).stdout;
    const p = mediaPipe('gst-launch-1.0', cameraArgs('Test', `meshdrop-test-camera-${process.pid}`, loop), 'in');
    let feeding = true;
    void (async () => {
      while (feeding) {
        p.in!.write(frame);
        await new Promise((r) => setTimeout(r, 33));
      }
    })();
    // a V4L2 app opens it once frames flow
    await new Promise((r) => setTimeout(r, 1000));
    const code = await new Promise<number | null>((done) => {
      const v = spawn('gst-launch-1.0', ['-q', 'v4l2src', `device=${loop}`, 'num-buffers=30', '!', 'fakesink'], { stdio: 'ignore' });
      const t = setTimeout(() => v.kill('SIGKILL'), 8000);
      v.on('exit', (c) => {
        clearTimeout(t);
        done(c);
      });
    });
    feeding = false;
    p.stop();
    expect(code).toBe(0);
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
