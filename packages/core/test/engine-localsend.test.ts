import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent } from '../src/engine.ts';
import { lsSend } from '../src/localsend/client.ts';

const tmps: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function engine(alias: string) {
  const d = mkdtempSync(join(tmpdir(), 'md-els-'));
  tmps.push(d);
  const e = await Engine.create({ home: join(d, 'h'), inbox: join(d, 'inbox'), port: 0, alias, discovery: false, guest: false, localsend: { port: 0, answerTimeoutMs: 5000 } });
  engines.push(e);
  const events: EngineEvent[] = [];
  e.on('event', (ev: EngineEvent) => events.push(ev));
  await e.start();
  return { d, e, events };
}

describe('engine LocalSend interop', () => {
  it('a LocalSend sender registers, shows up as a device, waits for Accept, and its files land; the owner sends back', async () => {
    const A = await engine('PC');
    const B = await engine('Phone'); // stands in for a LocalSend app: same protocol on its LocalSend port
    const aPort = (A.e as unknown as { lsPort: number }).lsPort;
    const bPort = (B.e as unknown as { lsPort: number }).lsPort;
    const bSelf = (B.e as unknown as { lsSelf(): { fingerprint: string } }).lsSelf();
    const aPeer = { alias: 'PC', fingerprint: A.e.identity.deviceId, host: '127.0.0.1', port: aPort, protocol: 'https' as const, lastSeen: Date.now() };
    // B registers with A (what a LocalSend app does after hearing A's announce).
    const { lsRegister } = await import('../src/localsend/client.ts');
    expect(await lsRegister(aPeer, { ...bSelf, port: bPort } as never)).toBe(true);
    expect(A.e.devices().find((d) => d.deviceId === B.e.identity.deviceId)).toMatchObject({ role: 'localsend', trusted: false, alias: 'Phone' });

    writeFileSync(join(B.d, 'pic.jpg'), 'jpeg bytes');
    const sending = lsSend(aPeer, { ...bSelf, port: bPort } as never, { paths: [join(B.d, 'pic.jpg')], text: 'from my phone' });
    for (let i = 0; i < 100 && A.e.guestState().offers.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(A.e.guestState().offers[0]).toMatchObject({ via: 'localsend', alias: 'Phone', text: 'from my phone', files: [{ name: 'pic.jpg', size: 10 }] });
    await A.e.guestAccept(A.e.guestState().offers[0]!.id);
    await sending;
    expect(readFileSync(join(A.d, 'inbox', 'pic.jpg'), 'utf8')).toBe('jpeg bytes');
    expect(A.events.find((x) => x.source === 'guest' && x.type === 'received')).toMatchObject({ via: 'localsend', alias: 'Phone', text: 'from my phone' });

    writeFileSync(join(A.d, 'back.txt'), 'reply');
    const back = A.e.localsendSend(B.e.identity.deviceId, { paths: [join(A.d, 'back.txt')] });
    for (let i = 0; i < 100 && B.e.guestState().offers.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await B.e.guestAccept(B.e.guestState().offers[0]!.id);
    await back;
    expect(readFileSync(join(B.d, 'inbox', 'back.txt'), 'utf8')).toBe('reply');
  });
});
