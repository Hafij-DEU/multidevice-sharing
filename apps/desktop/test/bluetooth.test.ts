// The PC's Bluetooth platform against a fake helper (same protocol as build/meshdrop-bt.py, no BlueZ).
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { a2dpStreams, bluezPlatform, holdA2dp, type BtAudioSource } from '../src/main/bluetooth.ts';

const FAKE = join(__dirname, 'fixtures', 'fake-bt.py');
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};
const read = (s: Duplex, n: number) =>
  new Promise<string>((resolve) => {
    let got = '';
    s.on('data', (c: Buffer) => {
      got += c.toString();
      if (got.length >= n) resolve(got);
    });
  });

describe('bluezPlatform (M14)', () => {
  it('lists paired devices, dials, and hands over incoming connections', async () => {
    const bt = bluezPlatform({ script: FAKE });
    expect(await bt.bonded()).toEqual([]); // not started yet
    const incoming: [Duplex, string][] = [];
    await bt.listen((c, a) => incoming.push([c, a]));
    try {
      expect(await bt.bonded()).toEqual([{ address: 'AA:AA:AA:AA:AA:AA', name: 'Phone' }]);
      const s = await bt.dial('AA:AA:AA:AA:AA:AA');
      s.write('ping');
      expect(await read(s, 4)).toBe('ping');
      s.destroy();
      await expect(bt.dial('BB:BB:BB:BB:BB:BB')).rejects.toThrow('Host is down');
      const [c, address] = incoming[0]!;
      expect(address).toBe('CC:CC:CC:CC:CC:CC');
      expect(await read(c, 2)).toBe('hi');
    } finally {
      bt.stop();
    }
    await expect(bt.dial('AA:AA:AA:AA:AA:AA')).rejects.toThrow('not running');
  });

  it('reports phones playing their sound here as Bluetooth audio, and ends it', async () => {
    const bt = bluezPlatform({ script: FAKE });
    const seen: BtAudioSource[][] = [];
    bt.onAudio((s) => seen.push(s));
    await bt.listen(() => undefined);
    try {
      await until(() => seen.length === 1);
      expect(seen[0]).toEqual([{ address: 'DD:DD:DD:DD:DD:DD', name: 'Phone' }]);
      await bt.audioStop('DD:DD:DD:DD:DD:DD');
      await until(() => seen.length === 2);
      expect(seen[1]).toEqual([]);
      await bt.audioStart('DD:DD:DD:DD:DD:DD');
      await until(() => seen.length === 3);
      expect(seen[2]).toEqual([{ address: 'DD:DD:DD:DD:DD:DD', name: 'Phone' }]);
    } finally {
      bt.stop();
    }
    expect(seen.at(-1)).toEqual([]); // stopped: nothing plays here any more
  });

  it('holdA2dp connects a phone\'s Bluetooth audio for the sound, and drops it after only if it connected it', async () => {
    const calls: string[] = [];
    const bt = {
      audioStart: async (a: string) => { calls.push(`start ${a}`); },
      audioStop: async (a: string) => { calls.push(`stop ${a}`); },
    };
    const release = holdA2dp(bt, 'AA:AA:AA:AA:AA:AA', () => []);
    expect(calls).toEqual(['start AA:AA:AA:AA:AA:AA']);
    release();
    release(); // twice: still one stop
    await until(() => calls.length === 2);
    expect(calls).toEqual(['start AA:AA:AA:AA:AA:AA', 'stop AA:AA:AA:AA:AA:AA']);

    // already playing here (the user picked this PC as the phone's audio): left as it was
    calls.length = 0;
    holdA2dp(bt, 'AA:AA:AA:AA:AA:AA', () => [{ address: 'AA:AA:AA:AA:AA:AA', name: 'Phone' }])();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);

    // the connect failed: logged, nothing to drop
    const logs: string[] = [];
    holdA2dp({ ...bt, audioStart: async () => { throw new Error('Host is down'); } }, 'AA:AA:AA:AA:AA:AA', () => [], (m) => logs.push(m))();
    await until(() => logs.length === 1);
    expect(logs[0]).toContain('Host is down');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('a2dpStreams names the MeshDrop device behind each Bluetooth audio source', () => {
    const devices: Record<string, string> = { 'AA:AA:AA:AA:AA:AA': 'phone-id' };
    expect(a2dpStreams(
      [{ address: 'AA:AA:AA:AA:AA:AA', name: 'POCO' }, { address: 'BB:BB:BB:BB:BB:BB', name: 'Tablet' }],
      (a) => devices[a],
      (id) => (id === 'phone-id' ? 'My phone' : undefined),
    )).toEqual([
      { id: 'bt-audio:AA:AA:AA:AA:AA:AA', kind: 'bt-audio', peer: 'phone-id', alias: 'My phone' },
      { id: 'bt-audio:BB:BB:BB:BB:BB:BB', kind: 'bt-audio', peer: '', alias: 'Tablet' },
    ]);
  });

  it('fails listen() when the helper cannot start', async () => {
    const bt = bluezPlatform({ script: join(__dirname, 'fixtures', 'missing.py') });
    await expect(bt.listen(() => undefined)).rejects.toThrow('not installed');
  });
});
