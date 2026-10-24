// Folder sync (M8a) between two in-process engines on 127.0.0.1, each with its own folder.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent } from '../src/engine.ts';
import { ignored } from '../src/sync/ignore.ts';

const tmps: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'md-sync-'));
  tmps.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}

async function mk(alias: string) {
  const home = tmp();
  const e = await Engine.create({ home, inbox: join(home, 'inbox'), backupDir: join(home, 'Backup'), port: 0, alias, discovery: false, hub: { ingressPort: 0 }, guest: { port: 0 } });
  engines.push(e);
  const events: EngineEvent[] = [];
  e.on('event', (x: EngineEvent) => events.push(x));
  await e.start();
  const folder = join(home, 'Sync');
  return { e, events, folder };
}

/** Every synced file (relative path → content), ignoring our work areas. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (ignored(n.name)) continue;
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

async function pairSync() {
  const A = await mk('alpha');
  const B = await mk('beta');
  await A.e.pairManual('127.0.0.1', B.e.port, 'beta');
  await B.e.pairManual('127.0.0.1', A.e.port, 'alpha');
  A.e.syncPut({ name: 'Shared', folder: A.folder, partners: [B.e.identity.deviceId] });
  B.e.syncPut({ name: 'Shared', folder: B.folder, partners: [A.e.identity.deviceId] });
  await A.e.syncNow();
  await B.e.syncNow();
  return { A, B };
}

describe('folder sync', () => {
  it('adds, edits and deletes travel both ways; replaced and deleted files go to the trash', async () => {
    const { A, B } = await pairSync();
    mkdirSync(join(A.folder, 'docs', 'deep'), { recursive: true });
    writeFileSync(join(A.folder, 'docs', 'deep', 'a.txt'), 'one');
    writeFileSync(join(A.folder, 'top.txt'), 'top');
    writeFileSync(join(A.folder, 'skip.part'), 'temp');
    await B.e.syncNow();
    expect(tree(B.folder)).toEqual({ 'docs/deep/a.txt': 'one', 'top.txt': 'top' });
    await A.e.syncNow(); // A learns that B has them (the poke after B's pull does this by itself)

    writeFileSync(join(B.folder, 'docs', 'deep', 'a.txt'), 'two');
    await A.e.syncNow();
    expect(readFileSync(join(A.folder, 'docs', 'deep', 'a.txt'), 'utf8')).toBe('two');
    expect(JSON.stringify(readdirSync(join(A.folder, '.meshdrop-trash'), { recursive: true }))).toContain('a.txt');

    rmSync(join(A.folder, 'top.txt'));
    await B.e.syncNow();
    expect(existsSync(join(B.folder, 'top.txt'))).toBe(false);
    expect(JSON.stringify(readdirSync(join(B.folder, '.meshdrop-trash'), { recursive: true }))).toContain('top.txt');
    await A.e.syncNow(); // nothing comes back
    expect(tree(A.folder)).toEqual(tree(B.folder));
  }, 30_000);

  it('a conflict keeps both versions: the newer wins, the other becomes a conflict copy on both sides', async () => {
    const { A, B } = await pairSync();
    writeFileSync(join(A.folder, 'n.txt'), 'base');
    await B.e.syncNow();
    await A.e.syncNow();
    writeFileSync(join(A.folder, 'n.txt'), 'from A');
    writeFileSync(join(B.folder, 'n.txt'), 'from B');
    const t = Date.now() / 1000;
    utimesSync(join(A.folder, 'n.txt'), t, t + 60); // A's edit is newer
    utimesSync(join(B.folder, 'n.txt'), t, t);
    await B.e.syncNow(); // B loses: keeps its own as a copy, takes A's
    await A.e.syncNow(); // A pulls the copy
    await B.e.syncNow();
    const a = tree(A.folder);
    expect(a).toEqual(tree(B.folder));
    expect(a['n.txt']).toBe('from A');
    const copies = Object.entries(a).filter(([k]) => k.startsWith('n (conflict from alpha'));
    expect(copies.map(([, v]) => v)).toEqual(['from B']);
    expect(B.events.some((x) => x.source === 'sync' && x.type === 'round' && x.conflicts === 1)).toBe(true);
  }, 30_000);

  it('a change on one side beats a delete on the other', async () => {
    const { A, B } = await pairSync();
    writeFileSync(join(A.folder, 'k.txt'), 'v1');
    await B.e.syncNow();
    await A.e.syncNow();
    rmSync(join(A.folder, 'k.txt'));
    writeFileSync(join(B.folder, 'k.txt'), 'v2');
    await A.e.syncNow();
    await B.e.syncNow();
    expect(readFileSync(join(A.folder, 'k.txt'), 'utf8')).toBe('v2');
    expect(tree(A.folder)).toEqual(tree(B.folder));
  }, 30_000);

  it('a change is picked up by itself (the watcher pokes the partner)', async () => {
    const { A, B } = await pairSync();
    writeFileSync(join(A.folder, 'auto.txt'), 'hello');
    await until(() => existsSync(join(B.folder, 'auto.txt')), 15_000);
    expect(readFileSync(join(B.folder, 'auto.txt'), 'utf8')).toBe('hello');
    expect(statSync(join(B.folder, 'auto.txt')).mtimeMs).toBeCloseTo(statSync(join(A.folder, 'auto.txt')).mtimeMs, -1);
  }, 30_000);

  it('only ticked partners may read the folder, and the folder must stand apart', async () => {
    const A = await mk('alpha');
    const C = await mk('gamma');
    await A.e.pairManual('127.0.0.1', C.e.port, 'gamma');
    await C.e.pairManual('127.0.0.1', A.e.port, 'alpha');
    A.e.syncPut({ name: 'Shared', folder: A.folder, partners: [] }); // C not ticked
    writeFileSync(join(A.folder, 'secret.txt'), 's');
    C.e.syncPut({ name: 'Shared', folder: C.folder, partners: [A.e.identity.deviceId] });
    await C.e.syncNow();
    expect(C.e.syncStatus().folders[0]!.partners[0]!.last?.error).toMatch(/403/);
    expect(existsSync(join(C.folder, 'secret.txt'))).toBe(false);
    expect(() => A.e.syncPut({ folder: join(A.folder, '..', 'inbox', 'x'), partners: [] })).toThrow(/separate/);
    expect(() => A.e.syncPut({ folder: 'relative', partners: [] })).toThrow(/full path/);
    expect(() => A.e.syncPut({ name: 'Other', folder: join(A.folder, 'inner'), partners: [] })).toThrow(/another synced folder/);
    A.e.syncPut({ name: 'Two', folder: join(A.folder, '..', 'Elsewhere'), partners: [] });
    expect(() => A.e.syncPut({ name: 'Shared', folder: join(A.folder, '..', 'Elsewhere'), partners: [] }, 'Two')).toThrow(/already called/);
  }, 30_000);
});

describe('several folders', () => {
  it('folders sync by name, each with its own partners; a folder only one side has stays put', async () => {
    const A = await mk('alpha');
    const B = await mk('beta');
    await A.e.pairManual('127.0.0.1', B.e.port, 'beta');
    await B.e.pairManual('127.0.0.1', A.e.port, 'alpha');
    const [a, b] = [A.e.identity.deviceId, B.e.identity.deviceId];
    const A1 = join(A.folder, '..', 'Documents');
    const A2 = join(A.folder, '..', 'Photos');
    const B1 = join(B.folder, '..', 'Docs on phone');
    A.e.syncPut({ name: 'Docs', folder: A1, partners: [b] });
    A.e.syncPut({ folder: A2, partners: [b] }); // named after its folder: "Photos"
    B.e.syncPut({ name: 'Docs', folder: B1, partners: [a] });
    expect(A.e.syncConfig().folders.map((f) => f.name)).toEqual(['Docs', 'Photos']);
    writeFileSync(join(A1, 'cv.txt'), 'cv');
    writeFileSync(join(A2, 'cat.jpg'), 'meow');
    await B.e.syncNow();
    expect(tree(B1)).toEqual({ 'cv.txt': 'cv' });
    expect(B.e.syncStatus().folders.map((f) => f.name)).toEqual(['Docs']);
    // A asks B for "Photos": B has no such folder.
    await A.e.syncNow('Photos');
    expect(A.e.syncStatus().folders[1]!.partners[0]!.last?.error).toMatch(/404/);
    // Rename on B keeps its files; remove stops syncing but keeps them.
    B.e.syncPut({ name: 'Docs', folder: B1, partners: [] });
    writeFileSync(join(A1, 'new.txt'), 'n');
    await B.e.syncNow();
    expect(existsSync(join(B1, 'new.txt'))).toBe(false);
    B.e.syncRemove('Docs');
    expect(B.e.syncConfig().folders).toEqual([]);
    expect(readFileSync(join(B1, 'cv.txt'), 'utf8')).toBe('cv');
  }, 30_000);

  it('a 0.3.0 config (one folder) becomes a folder named after its directory and keeps its base', async () => {
    const A = await mk('alpha');
    const home = join(A.folder, '..');
    const id = 'ab'.repeat(32);
    mkdirSync(join(home, 'sync'), { recursive: true });
    writeFileSync(join(home, 'sync', 'config.json'), JSON.stringify({ folder: join(home, 'My Sync'), partners: [id] }));
    writeFileSync(join(home, 'sync', `base-${id}.json`), JSON.stringify({ 'a.txt': 'h1' }));
    const { SyncStore } = await import('../src/sync/store.ts');
    const st = new SyncStore(home);
    expect(st.config()).toEqual({ folders: [{ name: 'My Sync', folder: join(home, 'My Sync'), partners: [id] }] });
    expect(st.base('My Sync', id).get('a.txt')).toBe('h1');
    st.setConfig(st.config());
    expect(new SyncStore(home).base('My Sync', id).get('a.txt')).toBe('h1');
    expect(new SyncStore(home).base('Other', id).size).toBe(0);
  });
});

describe('photo backup', () => {
  it('a backup send lands in <backupDir>/<sender>/, never in the inbox, and says so', async () => {
    const A = await mk('alpha');
    const B = await mk('beta');
    await A.e.pairManual('127.0.0.1', B.e.port, 'beta');
    await B.e.pairManual('127.0.0.1', A.e.port, 'alpha phone');
    const src = join(tmp(), 'IMG_0001.jpg');
    writeFileSync(src, 'jpeg');
    writeFileSync(join(tmp(), 'x'), '');
    const [r] = await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: src }], { backup: true });
    expect(r!.status).toBe('done');
    await until(() => B.events.some((x) => x.source === 'receiver' && x.type === 'received'));
    const got = B.events.find((x) => x.source === 'receiver' && x.type === 'received') as Extract<EngineEvent, { type: 'received' }>;
    expect(got).toMatchObject({ backup: true, files: [join(B.e.backupDir, 'alpha phone', 'IMG_0001.jpg')] });
    expect(readFileSync(join(B.e.backupDir, 'alpha phone', 'IMG_0001.jpg'), 'utf8')).toBe('jpeg');
    expect(existsSync(join(B.e.backupDir, '..', 'inbox', 'IMG_0001.jpg'))).toBe(false);
    // The same name again: a free name, never over the first one.
    await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: src }], { backup: true });
    await until(() => existsSync(join(B.e.backupDir, 'alpha phone', 'IMG_0001 (1).jpg')));
  }, 30_000);
});
