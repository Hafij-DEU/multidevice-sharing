// Test helper (not a test file): N in-process MeshDrop "engines" on 127.0.0.1, each with its own
// MESHDROP_HOME-style tmp dir, identity, trust store, inbox and receiver server. All engines
// trust each other. Used by send.test.ts and e2e.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:https';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMeshServer, type ReceiverEvent } from '../src/api/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import type { Target } from '../src/transfer/send.ts';
import { TrustStore } from '../src/trust.ts';

export interface Engine {
  home: string;
  id: Identity;
  trust: TrustStore;
  inbox: Inbox;
  inboxRoot: string;
  outboxDir: string;
  server: Server;
  port: number;
  events: ReceiverEvent[];
  /** Every chunk the receiver's inbox stored (successful writeChunk calls), in order. */
  writes: { sessionId: string; fileId: number; index: number }[];
  /** Extra listeners, called synchronously for every receiver event. */
  listeners: ((e: ReceiverEvent, eng: Engine) => void)[];
  target(): Target;
  /** Closes the server and drops every open connection (simulates the peer dying). */
  stop(): void;
  /** Starts a fresh server on a new port with a fresh Inbox on the same root (simulates an app restart). */
  restart(opts?: { fs?: typeof fsp }): Promise<void>;
}

const tmps: string[] = [];
const live: Engine[] = [];

export function tmpDir(prefix = 'md-send-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}

export async function makeEngines(n: number, opts: { fs?: typeof fsp } = {}): Promise<Engine[]> {
  const homes = Array.from({ length: n }, () => tmpDir('md-home-'));
  const ids = await Promise.all(homes.map((h) => loadOrCreateIdentity(h)));
  const engines: Engine[] = [];
  for (let i = 0; i < n; i++) {
    const home = homes[i]!;
    const id = ids[i]!;
    const trust = new TrustStore(join(home, 'trust.json'));
    ids.forEach((other, j) => {
      if (j === i) return;
      trust.add({
        deviceId: other.deviceId,
        alias: `e${j}`,
        publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) as string,
        addedAt: 1,
      });
    });
    const inboxRoot = join(home, 'inbox');
    const eng = { home, id, trust, inboxRoot, outboxDir: join(home, 'outbox'), events: [], writes: [], listeners: [] } as unknown as Engine;
    const start = async (fs?: typeof fsp) => {
      eng.inbox = new Inbox(inboxRoot, fs ? { fs } : {});
      const write = eng.inbox.writeChunk.bind(eng.inbox);
      eng.inbox.writeChunk = async (sessionId, fileId, index, pt) => {
        await write(sessionId, fileId, index, pt);
        eng.writes.push({ sessionId, fileId, index });
      };
      eng.server = createMeshServer({
        id,
        trust,
        inbox: eng.inbox,
        onEvent: (e) => {
          eng.events.push(e);
          for (const l of eng.listeners) l(e, eng);
        },
      });
      eng.port = await listen(eng.server);
    };
    eng.stop = () => {
      eng.server.close();
      eng.server.closeAllConnections();
    };
    eng.restart = async (o = {}) => {
      eng.stop();
      await start(o.fs);
    };
    eng.target = () => ({ deviceId: id.deviceId, host: '127.0.0.1', port: eng.port, publicKey: id.publicKey });
    await start(opts.fs);
    engines.push(eng);
    live.push(eng);
  }
  return engines;
}

/** Call from afterEach: stops every engine and removes every tmp dir. */
export function cleanupEngines(): void {
  for (const e of live.splice(0)) e.stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const progressOf = (e: Engine, sessionId: string) =>
  e.events.filter((ev): ev is Extract<ReceiverEvent, { type: 'progress' }> => ev.type === 'progress' && ev.sessionId === sessionId);

export const writesOf = (e: Engine, sessionId: string) => e.writes.filter((w) => w.sessionId === sessionId);
