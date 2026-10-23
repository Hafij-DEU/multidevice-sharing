import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_CHUNK_BODY, createMeshHandler, type MeshRequest } from '../src/api/handler.ts';
import { createOffer, newSessionId, sealChunk, type Manifest } from '../src/chunk.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import { TrustStore } from '../src/trust.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-handler-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

let A: Identity; // receiver
let B: Identity; // trusted sender
beforeAll(async () => {
  [A, B] = (await Promise.all([1, 2].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity];
});

function harness(inbox?: Inbox) {
  const trust = new TrustStore(join(tmpDir(), 'trust.json'));
  trust.add({
    deviceId: B.deviceId,
    alias: 'b',
    publicKeyPem: B.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    addedAt: 1,
  });
  const root = tmpDir();
  const box = inbox ?? new Inbox(root);
  const h = createMeshHandler({ id: A, trust, inbox: box, onEvent: () => {} });
  return { h, root };
}

function req(peer: string | null, method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): MeshRequest {
  const hdrs = { ...headers };
  if (body) hdrs['content-length'] = String(body.length);
  return { peer, method, path, headers: hdrs, body: Readable.from(body ? [body] : []) };
}

describe('createMeshHandler (no network)', () => {
  it('peer:null may only GET info; POST offer is 403 untrusted', async () => {
    const { h } = harness();
    const info = await h.handle(req(null, 'GET', '/mesh/v1/info'));
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body.toString()).deviceId).toBe(A.deviceId);
    const r = await h.handle(req(null, 'POST', '/mesh/v1/offer', Buffer.from('{}')));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body.toString())).toEqual({ error: 'untrusted' });
  });

  it('offer, chunk, complete, finish over in-memory bodies delivers the file', async () => {
    const { h, root } = harness();
    const data = Buffer.from('hello handler '.repeat(100));
    const sessionId = newSessionId();
    const m: Manifest = {
      v: 1, sessionId, from: B.deviceId, to: A.deviceId, createdAt: 1,
      files: [{ fileId: 0, path: 'h.txt', size: data.length, mime: 'text/plain', sha256: sha(data) }], dirs: [],
    };
    const { offer, ctx } = createOffer(B, A.publicKey, m);
    const o = await h.handle(req(B.deviceId, 'POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(offer)), { 'content-type': 'application/json' }));
    expect(o.status).toBe(200);
    const c = await h.handle(req(B.deviceId, 'PUT', `/mesh/v1/chunk/${sessionId}/0/0`, sealChunk(ctx, sessionId, 0, 0, data)));
    expect(c.status).toBe(204);
    const done = await h.handle(req(B.deviceId, 'POST', `/mesh/v1/complete/${sessionId}/0`));
    expect(done.status).toBe(200);
    const fin = await h.handle(req(B.deviceId, 'POST', `/mesh/v1/finish/${sessionId}`));
    expect(fin.status).toBe(200);
    expect(JSON.parse(fin.body.toString())).toEqual({ files: ['h.txt'] });
    expect(readFileSync(join(root, 'h.txt')).equals(data)).toBe(true);
  });

  it('a chunk body of MAX_CHUNK_BODY + 1 is 413 too-large', async () => {
    const { h } = harness();
    const sessionId = newSessionId();
    const data = Buffer.alloc(10);
    const m: Manifest = {
      v: 1, sessionId, from: B.deviceId, to: A.deviceId, createdAt: 1,
      files: [{ fileId: 0, path: 'x', size: 10, mime: 'x', sha256: sha(data) }], dirs: [],
    };
    const { offer } = createOffer(B, A.publicKey, m);
    await h.handle(req(B.deviceId, 'POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(offer))));
    const big = Buffer.alloc(MAX_CHUNK_BODY + 1);
    // no content-length header: the cap must be enforced while reading
    const r = await h.handle({ peer: B.deviceId, method: 'PUT', path: `/mesh/v1/chunk/${sessionId}/0/0`, headers: {}, body: Readable.from([big]) });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body.toString())).toEqual({ error: 'too-large' });
    expect(r.close).toBe(true);
  });

  it('a throwing dependency is 500 internal with no detail', async () => {
    const boom = new Inbox(tmpDir());
    boom.load = async () => { throw new Error('secret detail /home/x'); };
    const { h } = harness(boom);
    const r = await h.handle(req(B.deviceId, 'POST', `/mesh/v1/complete/${newSessionId()}/0`));
    expect(r.status).toBe(500);
    expect(r.body.toString()).toBe('{"error":"internal"}');
  });
});
