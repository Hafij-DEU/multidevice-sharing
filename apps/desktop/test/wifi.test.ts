import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WifiControl, type WifiControlOptions } from '../src/main/wifi.ts';

// The desktop Wi-Fi backend is "view + copy / QR / share + sync" only. These tests pin the security
// invariants that mirror Android: the passphrase and the enterprise password never leave as a view field,
// they are read in the backend for copy / QR / share, and sync carries them only over the (trusted) mesh.

/** A wire/stored profile map; omitted fields take WifiControl's Android-matching defaults. */
function profile(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 'p1', ssid: 'Home', security: 'wpa2', psk: '', updatedAt: 100, ...over };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mdwifi-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Seeds the plaintext store (no seal, matching no-keyring hosts) with the given profile maps. */
function seed(maps: Record<string, unknown>[]): void {
  writeFileSync(join(home, 'wifi-profiles.bin'), JSON.stringify(maps));
}

interface Harness {
  ctl: WifiControl;
  clips: string[];
  sent: { to: string; msg: Record<string, unknown> }[];
}

/** A WifiControl wired to in-memory clipboard + mesh fakes. `reply` answers each outgoing sync send. */
function make(opts: { peers?: string[]; reply?: (msg: Record<string, unknown>) => unknown } = {}): Harness {
  const clips: string[] = [];
  const sent: { to: string; msg: Record<string, unknown> }[] = [];
  const o: WifiControlOptions = {
    home,
    clip: (t) => clips.push(t),
    peers: () => opts.peers ?? [],
    send: async (to, msg) => {
      sent.push({ to, msg });
      return { status: 200, body: opts.reply ? opts.reply(msg) : {} };
    },
  };
  return { ctl: new WifiControl(o), clips, sent };
}

describe('desktop wifi backend', () => {
  it('list() exposes metadata and hasPassword but never the passphrase or enterprise password', () => {
    seed([
      profile({ id: 'home', ssid: 'Home', security: 'wpa2', psk: 'secretpass' }),
      profile({ id: 'edu', ssid: 'eduroam', security: 'enterprise', psk: '', eapPassword: 'entpass', identity: 'me@uni' }),
    ]);
    const views = make().ctl.list();
    const serialised = JSON.stringify(views);
    expect(serialised).not.toContain('secretpass');
    expect(serialised).not.toContain('entpass');
    for (const v of views) {
      expect('psk' in v).toBe(false);
      expect('eapPassword' in v).toBe(false);
      expect(v.hasPassword).toBe(true);
    }
    expect(views.find((v) => v.id === 'edu')?.enterprise).toBe(true);
    expect(views.find((v) => v.id === 'edu')?.identity).toBe('me@uni');
  });

  it('list() hides deleted tombstones', () => {
    seed([profile({ id: 'gone', deletedAt: Date.now() }), profile({ id: 'live' })]);
    expect(make().ctl.list().map((v) => v.id)).toEqual(['live']);
  });

  it('copyPassword puts the passphrase on the clipboard, never through a view', () => {
    seed([profile({ id: 'home', psk: 'secretpass' })]);
    const h = make();
    h.ctl.copyPassword('home');
    expect(h.clips).toEqual(['secretpass']);
  });

  it('copyPassword rejects enterprise and open networks', () => {
    seed([profile({ id: 'edu', security: 'enterprise', eapPassword: 'x' }), profile({ id: 'open', security: 'open', psk: '' })]);
    const h = make();
    expect(() => h.ctl.copyPassword('edu')).toThrow(/eduroam/);
    expect(() => h.ctl.copyPassword('open')).toThrow(/open network/);
    expect(h.clips).toEqual([]);
  });

  it('copyPassword on a missing id throws', () => {
    seed([]);
    expect(() => make().ctl.copyPassword('nope')).toThrow(/no longer saved/);
  });

  it('share copies the details incl. an escaped WIFI: QR payload, and rejects enterprise', async () => {
    seed([profile({ id: 'home', ssid: 'My;Net', psk: 'secretpass' }), profile({ id: 'edu', security: 'enterprise', eapPassword: 'x' })]);
    const h = make();
    h.ctl.share('home');
    expect(h.clips[0]).toContain('Password: secretpass');
    expect(h.clips[0]).toContain('WIFI:T:WPA;S:My\\;Net;P:secretpass;;');
    expect(() => h.ctl.share('edu')).toThrow(/cannot be shared/);
  });

  it('qr returns an SVG for a normal network and rejects enterprise', async () => {
    seed([profile({ id: 'home', psk: 'secretpass' }), profile({ id: 'edu', security: 'enterprise', eapPassword: 'x' })]);
    const h = make();
    const svg = await h.ctl.qr('home');
    expect(svg).toContain('<svg');
    await expect(h.ctl.qr('edu')).rejects.toThrow(/QR code cannot carry/);
  });

  it('onWifiSync pull returns full profiles incl. secrets (they ride the trusted link)', () => {
    seed([profile({ id: 'home', psk: 'secretpass' })]);
    const out = make().ctl.onWifiSync('peer', { op: 'pull' });
    expect(out.ok).toBe(true);
    const profiles = out.profiles as Record<string, unknown>[];
    expect(profiles[0]?.psk).toBe('secretpass');
  });

  it('onWifiSync push merges newer entries (newer timestamp wins), ignores older', () => {
    seed([profile({ id: 'home', ssid: 'Home', updatedAt: 100 })]);
    const h = make();
    const r1 = h.ctl.onWifiSync('peer', { op: 'push', profiles: [profile({ id: 'home', ssid: 'Renamed', updatedAt: 200 })] });
    expect(r1.merged).toBe(1);
    expect(h.ctl.list().find((v) => v.id === 'home')?.ssid).toBe('Renamed');
    const r2 = h.ctl.onWifiSync('peer', { op: 'push', profiles: [profile({ id: 'home', ssid: 'Older', updatedAt: 50 })] });
    expect(r2.merged).toBe(0);
    expect(h.ctl.list().find((v) => v.id === 'home')?.ssid).toBe('Renamed');
  });

  it('onWifiSync push with a newer delete tombstone removes the network locally', () => {
    seed([profile({ id: 'home', updatedAt: 100 })]);
    const h = make();
    const r = h.ctl.onWifiSync('peer', { op: 'push', profiles: [profile({ id: 'home', deletedAt: Date.now() })] });
    expect(r.merged).toBe(1);
    expect(h.ctl.list()).toEqual([]);
  });

  it('onWifiSync rejects an unknown op', () => {
    seed([]);
    expect(make().ctl.onWifiSync('peer', { op: 'frobnicate' }).error).toBe('bad-op');
  });

  it('syncNow pulls then pushes to every trusted device and reports the tally', async () => {
    seed([profile({ id: 'home', ssid: 'Home', updatedAt: 100 })]);
    const h = make({
      peers: ['devA'],
      reply: (msg) => (msg.op === 'pull' ? { profiles: [profile({ id: 'laptop', ssid: 'Laptop', updatedAt: 300 })] } : { merged: 1 }),
    });
    const res = await h.ctl.syncNow();
    expect(res).toEqual({ devices: 1, reached: 1, pushed: 1, merged: 1 });
    // The incoming network from devA is now local.
    expect(h.ctl.list().map((v) => v.id).sort()).toEqual(['home', 'laptop']);
    // We sent a pull then a push; the push carries our full export (secrets included, over the trusted link).
    expect(h.sent.map((s) => s.msg.op)).toEqual(['pull', 'push']);
    const pushed = (h.sent[1]?.msg.profiles ?? []) as Record<string, unknown>[];
    expect(pushed.some((p) => p.id === 'home')).toBe(true);
  });

  it('syncNow counts an unreachable device but still returns', async () => {
    seed([]);
    const o: WifiControlOptions = {
      home,
      clip: () => {},
      peers: () => ['dead'],
      send: async () => {
        throw new Error('offline');
      },
    };
    const res = await new WifiControl(o).syncNow();
    expect(res).toEqual({ devices: 1, reached: 0, pushed: 0, merged: 0 });
  });
});
