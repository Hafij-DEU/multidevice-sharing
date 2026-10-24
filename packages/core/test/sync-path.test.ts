import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileState } from '../src/sync/server.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sync fileState (security review #12)', () => {
  it('never reaches a file through a linked folder outside the sync folder', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-syncpath-'));
    tmps.push(d);
    const folder = join(d, 'sync');
    const outside = join(d, 'private');
    mkdirSync(folder);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(folder, 'ok.txt'), 'ok');
    symlinkSync(outside, join(folder, 'docs'));
    expect(await fileState(folder, 'docs/secret.txt', new Map())).toBeNull();
    expect(await fileState(folder, 'ok.txt', new Map())).toMatchObject({ rel: 'ok.txt', size: 2 });
  });
});
