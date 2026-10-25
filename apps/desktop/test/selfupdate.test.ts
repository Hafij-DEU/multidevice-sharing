import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { onReplaced } from '../src/main/selfupdate.ts';

describe('restart after an update', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('fires once when the file is replaced (as dpkg does), after it settles', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-upd-'));
    dirs.push(d);
    const f = join(d, 'app.asar');
    writeFileSync(f, 'old');
    let fired = 0;
    const stop = onReplaced(f, () => fired++, { interval: 20, settle: 60 });
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(0);
    writeFileSync(join(d, 'new'), 'new contents');
    renameSync(join(d, 'new'), f);
    await new Promise((r) => setTimeout(r, 300));
    expect(fired).toBe(1);
    stop();
  });

  it('stays quiet while the file is missing (mid-install)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-upd-'));
    dirs.push(d);
    const f = join(d, 'app.asar');
    writeFileSync(f, 'old');
    let fired = 0;
    const stop = onReplaced(f, () => fired++, { interval: 20, settle: 60 });
    rmSync(f);
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(0);
    stop();
  });
});
