// The PC's Bluetooth platform against a fake helper (same protocol as build/meshdrop-bt.py, no BlueZ).
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { bluezPlatform } from '../src/main/bluetooth.ts';

const FAKE = join(__dirname, 'fixtures', 'fake-bt.py');
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

  it('fails listen() when the helper cannot start', async () => {
    const bt = bluezPlatform({ script: join(__dirname, 'fixtures', 'missing.py') });
    await expect(bt.listen(() => undefined)).rejects.toThrow('not installed');
  });
});
