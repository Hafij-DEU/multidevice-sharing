import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent, type EngineOptions } from '../src/engine.ts';

const run = promisify(execFile);
const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-enghub-'));
  tmps.push(d);
  return d;
}
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.stop();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}

async function make(home: string, extra: Partial<EngineOptions> = {}): Promise<{ e: Engine; events: EngineEvent[]; inbox: string }> {
  const inbox = extra.inbox ?? tmpDir();
  const e = await Engine.create({
    home, inbox, port: 0, discovery: false, alias: extra.alias ?? 'dev',
    hub: { ingressPort: 0 }, hubBackoffMs: [50, 100], ...extra,
  });
  const events: EngineEvent[] = [];
  e.on('event', (x: EngineEvent) => events.push(x));
  engines.push(e);
  return { e, events, inbox };
}
const meshEvents = (ev: EngineEvent[], type: string) => ev.filter((x) => x.source === 'mesh' && x.type === type);

describe('invite lifetime across restarts (C1)', () => {
  it('a redeemed invite stays dead after the inviter restarts; a fresh one works', async () => {
    const hHome = tmpDir();
    let H = await make(hHome, { alias: 'hub' });
    await H.e.hubInit([]);
    await H.e.start();
    const { uri } = H.e.createInvite();
    const A = await make(tmpDir(), { alias: 'a' });
    expect(await A.e.join(uri)).toBe('member');
    const port = H.e.port;
    await H.e.stop();
    H = await make(hHome, { alias: 'hub', port });
    await H.e.start();
    await sleep(1500); // the invite poll runs every second
    const B = await make(tmpDir(), { alias: 'b' });
    await expect(B.e.join(uri)).rejects.toThrow(/used|expired|unknown/);
    expect(await B.e.join(H.e.createInvite().uri)).toBe('member');
  }, 30_000);
});

describe('engine with a hub', () => {
  it('init, join by QR (LAN), relay, held, revoke and recovery, end to end', async () => {
    // Hub
    const hHome = tmpDir();
    const H = await make(hHome, { alias: 'hub' });
    await H.e.hubInit([]);
    await H.e.start();
    await H.e.setHubUrls([`ws://127.0.0.1:${H.e.hubIngressPort}/mesh/v1/hub`]);
    expect(H.e.hubStatus()).toMatchObject({ role: 'hub', members: 1 });

    // A joins with the hub's invite (over the LAN)
    const A = await make(tmpDir(), { alias: 'laptop' });
    await A.e.start();
    expect(await A.e.join(H.e.createInvite().uri)).toBe('member');
    await until(() => A.e.hubStatus().online);

    // B joins with A's invite while the hub is online; B has no LAN route known to A
    const bHome = tmpDir();
    let B = await make(bHome, { alias: 'phone', lanAddrs: () => [] });
    await B.e.start();
    expect(await B.e.join(A.e.createInvite().uri)).toBe('member');
    await until(() => B.e.hubStatus().online && A.e.members().length === 3);
    expect(A.e.members().map((m) => m.alias).sort()).toEqual(['hub', 'laptop', 'phone']);

    // CLI: members (client-only process on H's home) and invite
    const members = await run(process.execPath, [CLI, 'members', '--home', hHome]);
    expect(members.stdout).toMatch(/hub\s.*hub/);
    expect(members.stdout).toMatch(/phone/);
    const inv = await run(process.execPath, [CLI, 'invite', '--home', hHome]);
    expect(inv.stdout).toMatch(/^meshdrop:\/\/join\?/m);

    // relay: A → B with no LAN address for B
    const f1 = join(tmpDir(), 'relayed.txt');
    writeFileSync(f1, 'over the hub '.repeat(1000));
    const bId = B.e.identity.deviceId;
    const [r1] = await A.e.send([bId.slice(0, 8)], [{ kind: 'file', srcPath: f1 }]);
    expect(r1).toMatchObject({ status: 'done' });
    expect(readFileSync(join(B.inbox, 'relayed.txt'), 'utf8')).toBe(readFileSync(f1, 'utf8'));

    // held: B offline → A's send is held on the hub, delivered when B returns
    await B.e.stop();
    await until(() => !H.e.hubDirectory().find((d) => d.deviceId === bId)?.online);
    const f2 = join(tmpDir(), 'held.txt');
    writeFileSync(f2, 'kept for you '.repeat(1000));
    const [r2] = await A.e.send([bId.slice(0, 8)], [{ kind: 'file', srcPath: f2 }]);
    expect(r2).toMatchObject({ status: 'held' });
    B = await make(bHome, { alias: 'phone', lanAddrs: () => [], inbox: B.inbox });
    await B.e.start();
    await until(() => existsSync(join(B.inbox, 'held.txt')) && meshEvents(A.events, 'held-delivered').length === 1);

    // revoke B
    await H.e.revoke(bId.slice(0, 8));
    await until(() => meshEvents(B.events, 'revoked').length === 1);
    await sleep(300);
    expect(meshEvents(B.events, 'revoked').length).toBe(1);
    expect(existsSync(join(bHome, 'mesh'))).toBe(false);
    expect(existsSync(join(bHome, 'identity', 'key.pem'))).toBe(true);
    await until(() => !A.e.members().some((m) => m.deviceId === bId));

    // recovery: export from H, import on a fresh home, the new hub takes over
    const text = H.e.exportRecovery('correct horse battery');
    const ingress = H.e.hubIngressPort;
    const versionBefore = A.e.hubStatus().version;
    await H.e.stop();
    const H2 = await make(tmpDir(), { alias: 'hub2', hub: { ingressPort: ingress } });
    await H2.e.importRecovery(text, 'correct horse battery');
    await H2.e.start();
    await until(() => A.e.hubStatus().online && A.e.hubStatus().version > versionBefore, 15_000);
    expect(A.e.hubStatus().hubId).toBe(H2.e.identity.deviceId);
    expect(A.e.members().some((m) => m.deviceId === H.e.identity.deviceId)).toBe(false);
  }, 90_000);
});
