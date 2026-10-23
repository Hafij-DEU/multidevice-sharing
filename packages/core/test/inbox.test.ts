import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, newSessionId, type Manifest } from '../src/chunk.ts';
import {
  ChunkRangeError, IncompleteFileError, Inbox, IntegrityError, UnknownSessionError, UnsafePathError,
} from '../src/inbox.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const roots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-inbox-'));
  roots.push(d);
  return d;
}
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

function manifest(
  sid: string,
  files: { path: string; data: Buffer; sha256?: string }[],
  dirs: string[] = [],
): Manifest {
  return {
    v: 1, sessionId: sid, from: 'a'.repeat(64), to: 'b'.repeat(64), createdAt: 1,
    files: files.map((f, i) => ({
      fileId: i, path: f.path, size: f.data.length, mime: 'application/octet-stream', sha256: f.sha256 ?? sha(f.data),
    })),
    dirs: dirs.map((path) => ({ path })),
  };
}
const partialDir = (root: string, sid: string) => join(root, '.meshdrop-partial', sid);

describe('Inbox', () => {
  it('stores a small file, finalizes with verified hash, cleans up partial', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.from('hello world');
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'sub\\dir/hi.txt', data }]), 'CTX');
    await inbox.writeChunk(sid, 0, 0, data);
    const p = await inbox.finalize(sid, 0);
    expect(p).toBe(join(root, 'sub/dir/hi.txt'));
    expect(readFileSync(p).equals(data)).toBe(true);
    expect(existsSync(join(partialDir(root, sid), '0.part'))).toBe(false);
    expect(await inbox.finalize(sid, 0)).toBe(p); // idempotent
    await inbox.drop(sid);
    expect(existsSync(partialDir(root, sid))).toBe(false);
    expect(await inbox.load(sid)).toBeNull();
  });

  it('state.json is mode 0600 and load() round-trips manifest + ctxExport', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const m = manifest(sid, [{ path: 'a.txt', data: Buffer.from('x') }], ['empty']);
    const inbox = new Inbox(root);
    await inbox.begin(sid, m, 'SECRET-CTX');
    expect(statSync(join(partialDir(root, sid), 'state.json')).mode & 0o777).toBe(0o600);
    expect(await new Inbox(root).load(sid)).toEqual({ manifest: m, ctxExport: 'SECRET-CTX' });
  });

  it('collision: existing file untouched, two finalizes get (1) and (2)', async () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'photo.jpg'), 'ORIGINAL');
    const sid = newSessionId();
    const a = Buffer.from('aaa'), b = Buffer.from('bbb');
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'photo.jpg', data: a }, { path: 'photo.jpg', data: b }]), 'c');
    await inbox.writeChunk(sid, 0, 0, a);
    await inbox.writeChunk(sid, 1, 0, b);
    const p1 = await inbox.finalize(sid, 0);
    const p2 = await inbox.finalize(sid, 1);
    expect(p1).toBe(join(root, 'photo (1).jpg'));
    expect(p2).toBe(join(root, 'photo (2).jpg'));
    expect(readFileSync(join(root, 'photo.jpg'), 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(p1)).toEqual(a);
    expect(readFileSync(p2)).toEqual(b);
  });

  it('two files with the same path in one manifest both land (second gets " (1)")', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const a = Buffer.from('aaa'), b = Buffer.from('bbb');
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'd/x.bin', data: a }, { path: 'd/x.bin', data: b }]), 'c');
    await inbox.writeChunk(sid, 0, 0, a);
    await inbox.writeChunk(sid, 1, 0, b);
    expect(await inbox.finalize(sid, 0)).toBe(join(root, 'd/x.bin'));
    expect(await inbox.finalize(sid, 1)).toBe(join(root, 'd/x (1).bin'));
  });

  it('resume state survives restart (chunks 0 and 2 of 3)', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.alloc(2 * CHUNK_SIZE + 10, 7);
    const m = manifest(sid, [{ path: 'big.bin', data }]);
    const inbox = new Inbox(root);
    await inbox.begin(sid, m, 'ctx');
    await inbox.writeChunk(sid, 0, 0, data.subarray(0, CHUNK_SIZE));
    await inbox.writeChunk(sid, 0, 2, data.subarray(2 * CHUNK_SIZE));
    const inbox2 = new Inbox(root);
    expect(await inbox2.have(sid)).toEqual({ 0: [0, 2] });
    await inbox2.writeChunk(sid, 0, 1, data.subarray(CHUNK_SIZE, 2 * CHUNK_SIZE));
    expect(await inbox2.have(sid)).toEqual({ 0: [0, 1, 2] });
    const p = await inbox2.finalize(sid, 0);
    expect(readFileSync(p).equals(data)).toBe(true);
  });

  it('begin with the same manifest keeps progress; a different manifest resets it', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.from('abc');
    const m = manifest(sid, [{ path: 'a.txt', data }]);
    const inbox = new Inbox(root);
    await inbox.begin(sid, m, 'ctx');
    await inbox.writeChunk(sid, 0, 0, data);
    await inbox.begin(sid, m, 'ctx');
    expect(await inbox.have(sid)).toEqual({ 0: [0] });
    await inbox.begin(sid, manifest(sid, [{ path: 'other.txt', data }]), 'ctx');
    expect(await inbox.have(sid)).toEqual({});
  });

  it('hash mismatch: IntegrityError, no final file, partial discarded so the file restarts', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.from('payload');
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'f.txt', data, sha256: 'ab'.repeat(32) }]), 'c');
    await inbox.writeChunk(sid, 0, 0, data);
    await expect(inbox.finalize(sid, 0)).rejects.toBeInstanceOf(IntegrityError);
    expect(existsSync(join(root, 'f.txt'))).toBe(false);
    expect(await inbox.have(sid)).toEqual({});
  });

  it('0-byte file: finalize with no chunks creates an empty file', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'empty.txt', data: Buffer.alloc(0) }]), 'c');
    const p = await inbox.finalize(sid, 0);
    expect(statSync(p).size).toBe(0);
    expect(p).toBe(join(root, 'empty.txt'));
  });

  it('empty dir: finalizeDirs creates it (nested, sanitized)', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [], ['photos/2024\\empty', 'a:b']), 'c');
    await inbox.finalizeDirs(sid);
    expect(statSync(join(root, 'photos/2024/empty')).isDirectory()).toBe(true);
    expect(statSync(join(root, 'a_b')).isDirectory()).toBe(true);
  });

  it('write failure keeps partial: ENOSPC on 2nd chunk rejects with code, have() keeps 1st', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.alloc(2 * CHUNK_SIZE, 3);
    let partWrites = 0;
    const fs = {
      ...fsp,
      open: async (path: string, ...rest: unknown[]) => {
        const h = await (fsp.open as (...a: unknown[]) => Promise<fsp.FileHandle>)(path, ...rest);
        if (String(path).endsWith('.part')) {
          const w = h.write.bind(h) as (...a: unknown[]) => Promise<unknown>;
          (h as unknown as { write: unknown }).write = async (...a: unknown[]) => {
            if (++partWrites === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            return w(...a);
          };
        }
        return h;
      },
    } as unknown as typeof fsp;
    const inbox = new Inbox(root, { fs });
    await inbox.begin(sid, manifest(sid, [{ path: 'big.bin', data }]), 'c');
    await inbox.writeChunk(sid, 0, 0, data.subarray(0, CHUNK_SIZE));
    await expect(inbox.writeChunk(sid, 0, 1, data.subarray(CHUNK_SIZE))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await inbox.have(sid)).toEqual({ 0: [0] });
    expect(await new Inbox(root).have(sid)).toEqual({ 0: [0] });
    expect(existsSync(join(root, 'big.bin'))).toBe(false);
    await expect(inbox.finalize(sid, 0)).rejects.toBeInstanceOf(IncompleteFileError);
  });

  it('begin rejects the whole manifest on any unsafe path, writing no state', async () => {
    const root = tmpRoot();
    const d = Buffer.from('x');
    for (const bad of ['../x', '/etc/passwd', 'C:\\x', 'a/../../b', '.meshdrop-partial/zzz/state.json', '.MeshDrop-Partial', '', '.']) {
      const sid = newSessionId();
      const inbox = new Inbox(root);
      await expect(inbox.begin(sid, manifest(sid, [{ path: 'ok.txt', data: d }, { path: bad, data: d }]), 'c'), bad)
        .rejects.toBeInstanceOf(UnsafePathError);
      await expect(inbox.begin(sid, manifest(sid, [{ path: 'ok.txt', data: d }], ['fine', bad]), 'c'), bad)
        .rejects.toBeInstanceOf(UnsafePathError);
      expect(existsSync(partialDir(root, sid))).toBe(false);
    }
  });

  it('refuses malformed sessionIds before touching the filesystem', async () => {
    const root = tmpRoot();
    const inbox = new Inbox(root);
    for (const bad of ['../../etc', 'short', 'a'.repeat(23), `${'a'.repeat(21)}/`, '']) {
      await expect(inbox.have(bad)).rejects.toBeInstanceOf(UnsafePathError);
      await expect(inbox.load(bad)).rejects.toBeInstanceOf(UnsafePathError);
      await expect(inbox.drop(bad)).rejects.toBeInstanceOf(UnsafePathError);
      await expect(inbox.writeChunk(bad, 0, 0, Buffer.alloc(0))).rejects.toBeInstanceOf(UnsafePathError);
      await expect(inbox.begin(bad, manifest(newSessionId(), []), 'c')).rejects.toBeInstanceOf(UnsafePathError);
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('writeChunk rejects unknown session, unknown fileId, bad index, wrong length', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.alloc(CHUNK_SIZE + 5, 1);
    const inbox = new Inbox(root);
    await expect(inbox.writeChunk(sid, 0, 0, data)).rejects.toBeInstanceOf(UnknownSessionError);
    await inbox.begin(sid, manifest(sid, [{ path: 'a.bin', data }]), 'c');
    const full = data.subarray(0, CHUNK_SIZE), last = data.subarray(CHUNK_SIZE);
    await expect(inbox.writeChunk(sid, 9, 0, full)).rejects.toBeInstanceOf(ChunkRangeError);
    await expect(inbox.writeChunk(sid, 0, 2, last)).rejects.toBeInstanceOf(ChunkRangeError);
    await expect(inbox.writeChunk(sid, 0, -1, full)).rejects.toBeInstanceOf(ChunkRangeError);
    await expect(inbox.writeChunk(sid, 0, 0.5, full)).rejects.toBeInstanceOf(ChunkRangeError);
    await expect(inbox.writeChunk(sid, 0, 0, last)).rejects.toBeInstanceOf(ChunkRangeError); // too short
    await expect(inbox.writeChunk(sid, 0, 1, full)).rejects.toBeInstanceOf(ChunkRangeError); // too long
    await expect(inbox.writeChunk(sid, 0, 0, Buffer.alloc(CHUNK_SIZE + 1))).rejects.toBeInstanceOf(ChunkRangeError);
    expect(await inbox.have(sid)).toEqual({});
    expect(existsSync(join(partialDir(root, sid), '0.part'))).toBe(false);
  });

  it('concurrent chunk writes all get recorded', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.alloc(3 * CHUNK_SIZE, 9);
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'c.bin', data }]), 'c');
    await Promise.all([2, 0, 1].map((i) => inbox.writeChunk(sid, 0, i, data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))));
    expect(await new Inbox(root).have(sid)).toEqual({ 0: [0, 1, 2] });
  });

  it('never writes through a symlinked directory inside the inbox', async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    symlinkSync(outside, join(root, 'link'));
    const sid = newSessionId();
    const d = Buffer.from('evil');
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'link/x.txt', data: d }], ['link/newdir']), 'c');
    await inbox.writeChunk(sid, 0, 0, d);
    await expect(inbox.finalize(sid, 0)).rejects.toBeInstanceOf(UnsafePathError);
    await expect(inbox.finalizeDirs(sid)).rejects.toBeInstanceOf(UnsafePathError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('finalize refuses an incomplete file and an unknown fileId', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const data = Buffer.alloc(CHUNK_SIZE + 1);
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: 'a.bin', data }]), 'c');
    await inbox.writeChunk(sid, 0, 1, data.subarray(CHUNK_SIZE));
    await expect(inbox.finalize(sid, 0)).rejects.toBeInstanceOf(IncompleteFileError);
    await expect(inbox.finalize(sid, 5)).rejects.toBeInstanceOf(ChunkRangeError);
  });

  it('over-long names are truncated up front: finalize works, collisions do not hit ENAMETOOLONG', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const a = Buffer.from('aaa'), b = Buffer.from('bbb'), c = Buffer.from('ccc');
    const long = 'n'.repeat(304) + '.txt';
    const inbox = new Inbox(root);
    await inbox.begin(sid, manifest(sid, [{ path: long, data: a }, { path: long, data: b }, { path: '\u00e9'.repeat(200) + '.md', data: c }]), 'c');
    for (const [i, d] of [a, b, c].entries()) await inbox.writeChunk(sid, i, 0, d);
    const p1 = await inbox.finalize(sid, 0);
    const p2 = await inbox.finalize(sid, 1);
    const p3 = await inbox.finalize(sid, 2);
    const base1 = p1.slice(root.length + 1);
    expect(Buffer.byteLength(base1)).toBe(240);
    expect(base1.endsWith('.txt')).toBe(true);
    expect(p2).toBe(join(root, base1.replace(/\.txt$/, ' (1).txt')));
    expect(readFileSync(p1, 'utf8')).toBe('aaa');
    expect(readFileSync(p2, 'utf8')).toBe('bbb');
    expect(Buffer.byteLength(p3.slice(root.length + 1))).toBeLessThanOrEqual(240);
    expect(readFileSync(p3, 'utf8')).toBe('ccc');
  });

  it('begin rejects a total path over 3072 bytes', async () => {
    const root = tmpRoot();
    const sid = newSessionId();
    const d = Buffer.from('x');
    const tooLong = Array(13).fill('p'.repeat(240)).join('/');
    const inbox = new Inbox(root);
    await expect(inbox.begin(sid, manifest(sid, [{ path: tooLong, data: d }]), 'c')).rejects.toBeInstanceOf(UnsafePathError);
    await expect(inbox.begin(sid, manifest(sid, [], [tooLong]), 'c')).rejects.toBeInstanceOf(UnsafePathError);
    expect(existsSync(partialDir(root, sid))).toBe(false);
  });
});
