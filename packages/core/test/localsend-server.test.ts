import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/identity.ts';
import { LocalSendReceiver, type LsEvent } from '../src/localsend/server.ts';
import { serverTlsOptions } from '../src/tls.ts';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

/** A LocalSend sender written from the protocol text (no client certificate, self-signed server). */
function call(port: number, method: string, path: string, body?: Buffer | string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, rejectUnauthorized: false, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : undefined }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const sender = { alias: 'Pixel <b>', version: '2.0', deviceModel: 'Pixel 8', deviceType: 'mobile', fingerprint: 'f'.repeat(64), port: 53317, protocol: 'https', download: false };

async function setup(answerTimeoutMs = 5000) {
  const d = mkdtempSync(join(tmpdir(), 'md-ls-'));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  const id = await loadOrCreateIdentity(join(d, 'home'));
  const events: LsEvent[] = [];
  const r = new LocalSendReceiver({
    self: () => ({ alias: 'My PC', version: '2.0', deviceModel: 'Linux', deviceType: 'desktop', fingerprint: id.deviceId, port: 53317, protocol: 'https', download: false }),
    partialDir: join(d, 'partial'), inboxRoot: join(d, 'inbox'), onEvent: (e) => events.push(e), answerTimeoutMs,
  });
  const s: Server = createServer(serverTlsOptions(id), (req, res) => {
    if (!r.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  closers.push(() => s.close());
  return { d, r, events, port: (s.address() as { port: number }).port, id };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('LocalSend v2 receiver', () => {
  it('answers info/register, waits for Accept, then takes the uploads', async () => {
    const { d, r, events, port, id } = await setup();
    expect((await call(port, 'GET', '/api/localsend/v2/info')).json).toMatchObject({ alias: 'My PC', fingerprint: id.deviceId });
    expect((await call(port, 'POST', '/api/localsend/v2/register', JSON.stringify(sender))).json).toMatchObject({ alias: 'My PC' });
    expect(events[0]).toMatchObject({ type: 'register', info: { alias: 'Pixel <b>' } });
    const prep = call(port, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: sender, files: { a: { id: 'a', fileName: 'photo.jpg', size: 5, fileType: 'image/jpeg' }, b: { id: 'b', fileName: 'empty.txt', size: 0, fileType: 'application/octet-stream' } } }));
    await until(() => r.pending().length === 1);
    expect(r.pending()[0]).toMatchObject({ alias: 'Pixel <b>', files: [{ name: 'photo.jpg', size: 5 }, { name: 'empty.txt', size: 0 }] });
    expect((await call(port, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: sender, files: { x: { id: 'x', fileName: 'x', size: 1, fileType: 'a/b' } } }))).status).toBe(409);
    r.accept(r.pending()[0]!.id);
    const p = (await prep) as { status: number; json: { sessionId: string; files: Record<string, string> } };
    expect(p.status).toBe(200);
    expect(Object.keys(p.json.files)).toEqual(['a']);
    expect((await call(port, 'POST', `/api/localsend/v2/upload?sessionId=${p.json.sessionId}&fileId=a&token=wrong`, 'hello')).status).toBe(403);
    expect((await call(port, 'POST', `/api/localsend/v2/upload?sessionId=${p.json.sessionId}&fileId=a&token=${p.json.files.a}`, 'hello')).status).toBe(200);
    expect(readFileSync(join(d, 'inbox', 'photo.jpg'), 'utf8')).toBe('hello');
    expect(existsSync(join(d, 'inbox', 'empty.txt'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'received' });
    expect((events.at(-1) as { files: string[] }).files.sort()).toEqual([join(d, 'inbox', 'empty.txt'), join(d, 'inbox', 'photo.jpg')]);
  });

  it('takes a message from its preview without an upload (204)', async () => {
    const { r, events, port } = await setup();
    const prep = call(port, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: sender, files: { m: { id: 'm', fileName: 'msg.txt', size: 5, fileType: 'text/plain', preview: 'hi pc' } } }));
    await until(() => r.pending().length === 1);
    expect(r.pending()[0]).toMatchObject({ files: [], text: 'hi pc' });
    r.accept(r.pending()[0]!.id);
    expect((await prep).status).toBe(204);
    expect(events.at(-1)).toMatchObject({ type: 'received', files: [], text: 'hi pc' });
  });

  it('a decline, a timeout and a hostile name all store nothing', async () => {
    const { d, r, port } = await setup(300);
    const prep = call(port, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: sender, files: { a: { id: 'a', fileName: 'a.bin', size: 1, fileType: 'x/y' } } }));
    await until(() => r.pending().length === 1);
    r.reject(r.pending()[0]!.id);
    expect((await prep).status).toBe(403);
    expect((await call(port, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: sender, files: { a: { id: 'a', fileName: 'late.bin', size: 1, fileType: 'x/y' } } }))).status).toBe(403);
    expect((await call(port, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: sender, files: { a: { id: 'a', fileName: '../evil', size: 1, fileType: 'x/y' } } }))).status).toBe(400);
    expect(existsSync(join(d, 'inbox')) ? readdirSync(join(d, 'inbox')) : []).toEqual([]);
  });
});
