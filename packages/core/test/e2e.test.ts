// End-to-end: three engines (A sender, B and C receivers) on 127.0.0.1, distinct ports, separate
// MESHDROP_HOME-style tmp dirs, all mutually trusted.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkCount } from '../src/chunk.ts';
import { multiSend } from '../src/transfer/multisend.ts';
import { Outbox, sendTo } from '../src/transfer/send.ts';
import { cleanupEngines, makeEngines, progressOf, tmpDir, type Engine } from './engines.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
afterEach(() => cleanupEngines());

const SIZE_20MB = 20_000_000; // 5 chunks: 4 full + a 3 222 784-byte tail
const FAST = [20, 20, 20];

async function threeEngines(): Promise<[Engine, Engine, Engine]> {
  const e = await makeEngines(3);
  const ports = new Set(e.map((x) => x.port));
  expect(ports.size).toBe(3);
  return e as [Engine, Engine, Engine];
}

function abortAfterChunks(eng: Engine, n: number, ac: AbortController): void {
  eng.listeners.push((e) => {
    if (e.type === 'progress' && e.chunks >= n) ac.abort();
  });
}

describe('e2e', () => {
  it('folder + text: nested file, empty subdir and 0-byte file arrive with the same structure', async () => {
    const [a, b] = await threeEngines();
    const root = join(tmpDir(), 'proj');
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
    mkdirSync(join(root, 'empty', 'inner'), { recursive: true });
    const nested = randomBytes(CHUNK_SIZE + 123);
    writeFileSync(join(root, 'src', 'lib', 'deep.bin'), nested);
    writeFileSync(join(root, 'zero.txt'), '');
    writeFileSync(join(root, 'top.md'), '# hi\n');

    const r = await sendTo(a.id, b.target(), [{ kind: 'dir', srcPath: root }, { kind: 'text', text: 'see attached ✓' }]);
    expect(r.status).toBe('done');
    const out = join(b.inboxRoot, 'proj');
    expect(sha(readFileSync(join(out, 'src', 'lib', 'deep.bin')))).toBe(sha(nested));
    expect(statSync(join(out, 'zero.txt')).size).toBe(0);
    expect(readFileSync(join(out, 'top.md'), 'utf8')).toBe('# hi\n');
    expect(statSync(join(out, 'empty', 'inner')).isDirectory()).toBe(true);
    expect(readdirSync(join(out, 'empty', 'inner'))).toEqual([]);
    const received = b.events.find((e) => e.type === 'received');
    expect(received).toMatchObject({ sessionId: r.sessionId, text: 'see attached ✓' });
  });

  it('20 MB resume: abort after 2 chunks, sendTo again PUTs only the missing chunks', async () => {
    const [a, b] = await threeEngines();
    const data = randomBytes(SIZE_20MB);
    const file = join(tmpDir(), 'twenty.bin');
    writeFileSync(file, data);
    const outbox = new Outbox(a.outboxDir);
    const ac = new AbortController();
    abortAfterChunks(b, 2, ac);
    const r1 = await sendTo(a.id, b.target(), [{ kind: 'file', srcPath: file }], { outbox, signal: ac.signal });
    expect(r1.status).toBe('cancelled');
    b.listeners.length = 0;
    await sleep(150); // let any chunk that was already fully uploaded settle on the receiver

    const before = (await b.inbox.have(r1.sessionId))[0] ?? [];
    expect(before.length).toBeGreaterThanOrEqual(2);
    const total = chunkCount(SIZE_20MB);
    expect(before.length).toBeLessThan(total);
    const firstRun = progressOf(b, r1.sessionId).length;

    const r2 = await sendTo(a.id, b.target(), [{ kind: 'file', srcPath: file }], { outbox });
    expect(r2).toEqual({ deviceId: b.id.deviceId, status: 'done', sessionId: r1.sessionId });
    const secondRun = progressOf(b, r1.sessionId).length - firstRun;
    expect(secondRun).toBe(total - before.length);
    expect(sha(readFileSync(join(b.inboxRoot, 'twenty.bin')))).toBe(sha(data));
    expect(existsSync(join(a.outboxDir, `${r1.sessionId}.json`))).toBe(false);
  });

  it('restart resume: abort, new Outbox on the same dir, resumeAll completes the send', async () => {
    const [a, b] = await threeEngines();
    const data = randomBytes(3 * CHUNK_SIZE + 7);
    const file = join(tmpDir(), 'restart.bin');
    writeFileSync(file, data);
    const ac = new AbortController();
    abortAfterChunks(b, 1, ac);
    const r1 = await sendTo(a.id, b.target(), [{ kind: 'file', srcPath: file }], { outbox: new Outbox(a.outboxDir), signal: ac.signal });
    expect(r1.status).toBe('cancelled');
    b.listeners.length = 0;
    await b.restart(); // receiver restarts too (new port, Inbox re-read from disk)

    const res = await new Outbox(a.outboxDir).resumeAll(a.id, (deviceId) => (deviceId === b.id.deviceId ? b.target() : undefined));
    expect(res).toEqual([{ deviceId: b.id.deviceId, status: 'done', sessionId: r1.sessionId }]);
    expect(sha(readFileSync(join(b.inboxRoot, 'restart.bin')))).toBe(sha(data));
    expect(readdirSync(a.outboxDir).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it('multi-send isolation: C dies after its first chunk; B is done, C failed and later resumes', async () => {
    const [a, b, c] = await threeEngines();
    const data = randomBytes(3 * CHUNK_SIZE + 99);
    const file = join(tmpDir(), 'multi.bin');
    writeFileSync(file, data);
    c.listeners.push((e, eng) => {
      if (e.type === 'progress') eng.stop();
    });
    const outbox = new Outbox(a.outboxDir);
    const results = await multiSend(a.id, [b.target(), c.target()], [{ kind: 'file', srcPath: file }], { outbox, retryDelaysMs: FAST });
    expect(results.map((x) => [x.deviceId, x.status])).toEqual([
      [b.id.deviceId, 'done'],
      [c.id.deviceId, 'failed'],
    ]);
    expect(results[0]!.sessionId).not.toBe(results[1]!.sessionId);
    expect(results[1]!.error).toBeTruthy();
    expect(sha(readFileSync(join(b.inboxRoot, 'multi.bin')))).toBe(sha(data));
    const cSid = results[1]!.sessionId;
    expect(existsSync(join(a.outboxDir, `${cSid}.json`))).toBe(true);
    expect(existsSync(join(a.outboxDir, `${results[0]!.sessionId}.json`))).toBe(false);

    c.listeners.length = 0;
    await c.restart();
    const had = ((await c.inbox.have(cSid))[0] ?? []).length;
    expect(had).toBeGreaterThanOrEqual(1);
    const before = progressOf(c, cSid).length;
    const res = await outbox.resumeAll(a.id, (id) => (id === c.id.deviceId ? c.target() : undefined));
    expect(res).toEqual([{ deviceId: c.id.deviceId, status: 'done', sessionId: cSid }]);
    expect(progressOf(c, cSid).length - before).toBe(chunkCount(data.length) - had);
    expect(sha(readFileSync(join(c.inboxRoot, 'multi.bin')))).toBe(sha(data));
    expect(readdirSync(a.outboxDir).filter((n) => n.endsWith('.json'))).toEqual([]);
  });
});
