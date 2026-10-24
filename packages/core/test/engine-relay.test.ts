import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent, type EngineOptions } from '../src/engine.ts';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-relay-'));
  tmps.push(d);
  return d;
}
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.stop();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}
const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

async function make(home: string, extra: Partial<EngineOptions> = {}): Promise<{ e: Engine; events: EngineEvent[]; inbox: string }> {
  const inbox = extra.inbox ?? tmpDir();
  const e = await Engine.create({
    home, inbox, port: 0, discovery: false, alias: extra.alias ?? 'dev',
    hub: { ingressPort: 0 }, hubBackoffMs: [50, 100], allowLoopbackHubUrls: true, hubFailbackMs: 500, hubDrainMs: 60_000, ...extra,
  });
  const events: EngineEvent[] = [];
  e.on('event', (x: EngineEvent) => events.push(x));
  engines.push(e);
  return { e, events, inbox };
}

describe('relay hubs (M9)', () => {
  it('members fail over to a relay hub while the main hub is off, and a file it held is fetched later', async () => {
    const hHome = tmpDir();
    const hIngress = await freePort();
    let H = await make(hHome, { alias: 'hub', hub: { ingressPort: hIngress } });
    await H.e.hubInit([]);
    await H.e.start();
    await H.e.setHubUrls([`ws://127.0.0.1:${hIngress}/mesh/v1/hub`]);
    const hPort = H.e.port;

    const rIngress = await freePort();
    const R = await make(tmpDir(), { alias: 'vps', hub: { ingressPort: rIngress }, lanAddrs: () => [] });
    await R.e.start();
    const A = await make(tmpDir(), { alias: 'laptop', lanAddrs: () => [] });
    await A.e.start();
    const bHome = tmpDir();
    let B = await make(bHome, { alias: 'phone', lanAddrs: () => [] });
    await B.e.start();
    for (const x of [R, A, B]) expect(await x.e.join(H.e.createInvite().uri)).toBe('member');
    await until(() => [R, A, B].every((x) => x.e.hubStatus().online));

    // only the main hub names relays, only members can be relays
    await expect(A.e.relaysSet([{ deviceId: R.e.identity.deviceId, urls: ['wss://x/mesh/v1/hub'] }])).rejects.toThrow(/main hub/);
    await expect(H.e.relaysSet([{ deviceId: 'f'.repeat(64), urls: ['wss://x/mesh/v1/hub'] }])).rejects.toThrow(/member/);
    await H.e.relaysSet([{ deviceId: R.e.identity.deviceId, urls: [`ws://127.0.0.1:${rIngress}/mesh/v1/hub`] }]);
    await until(() => R.e.hubStatus().relayHub === true && A.e.relays().length === 1 && B.e.relays().length === 1);
    await until(() => R.e.hubStatus().online);
    expect(A.e.relays()[0]).toMatchObject({ alias: 'vps' });

    // main hub off: both members move to the relay and send through it
    await H.e.stop();
    await until(() => A.e.hubStatus().linkedTo === 'relay' && B.e.hubStatus().linkedTo === 'relay');
    const f1 = join(tmpDir(), 'via-relay.txt');
    writeFileSync(f1, 'through the relay '.repeat(500));
    const [r1] = await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: f1 }]);
    expect(r1).toMatchObject({ status: 'done' });
    expect(readFileSync(join(B.inbox, 'via-relay.txt'), 'utf8')).toBe(readFileSync(f1, 'utf8'));

    // B off: the relay holds A's send
    const bId = B.e.identity.deviceId;
    await B.e.stop();
    await sleep(500);
    const f2 = join(tmpDir(), 'held-on-relay.txt');
    writeFileSync(f2, 'kept by the relay '.repeat(500));
    const [r2] = await A.e.send([bId], [{ kind: 'file', srcPath: f2 }]);
    expect(r2, JSON.stringify(r2)).toMatchObject({ status: 'held' });

    // main hub back: A moves back to it; B links to the main hub and fetches what the relay held
    H = await make(hHome, { alias: 'hub', port: hPort, hub: { ingressPort: hIngress } });
    await H.e.start();
    await until(() => A.e.hubStatus().linkedTo === 'main');
    B = await make(bHome, { alias: 'phone', lanAddrs: () => [], inbox: B.inbox });
    await B.e.start();
    await until(() => B.e.hubStatus().linkedTo === 'main');
    await until(() => existsSync(join(B.inbox, 'held-on-relay.txt')), 20_000);
    expect(readFileSync(join(B.inbox, 'held-on-relay.txt'), 'utf8')).toBe(readFileSync(f2, 'utf8'));
  }, 90_000);
});
