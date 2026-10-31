import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_SHOW_ARGS, HOTSPOT_PROFILE, JOIN_PROFILE, NetMan, TetherGuard, guardArgs, hotspotArgs, isPhoneLink, joinAddArgs,
  joinUpArgs, newHotspot, parseDevices, reapplyArgs, validHotspot, wifiQr, type Run,
} from '../src/main/netman.ts';

const dev = (device: string, f: { type?: string; state?: number; connection?: string; metered?: string; driver?: string }) =>
  [`GENERAL.DEVICE:${device}`, `GENERAL.TYPE:${f.type ?? 'ethernet'}`, `GENERAL.STATE:${f.state ?? 100} (connected)`, `GENERAL.CONNECTION:${f.connection ?? '--'}`,
    `GENERAL.METERED:${f.metered ?? 'no (guessed)'}`, `GENERAL.DRIVER:${f.driver ?? 'e1000e'}`, ''].join('\n');

/** A fake nmcli: `show` is what `device show` prints; every call is recorded. */
function fakeNm(show: () => string, fail: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const runner: Run = async (_cmd, args) => {
    calls.push(args);
    if (fail(args)) throw new Error('nope');
    return args.join(' ') === DEVICE_SHOW_ARGS.join(' ') ? show() : '';
  };
  return { calls, runner, modifies: () => calls.filter((a) => a[0] === 'device' && a[1] !== 'show') };
}

describe('M14 netman', () => {
  it('parses nmcli device show, including "connected (externally)" and no connection', () => {
    const text = [
      'GENERAL.DEVICE:wlp0s20f3', 'GENERAL.TYPE:wifi', 'GENERAL.STATE:100 (connected)', 'GENERAL.CONNECTION:Spectrum', 'GENERAL.METERED:no (guessed)', 'GENERAL.DRIVER:iwlwifi', '',
      'GENERAL.DEVICE:tailscale0', 'GENERAL.TYPE:tun', 'GENERAL.STATE:100 (connected (externally))', 'GENERAL.CONNECTION:tailscale0', 'GENERAL.METERED:no (guessed)', 'GENERAL.DRIVER:tun', '',
      'GENERAL.DEVICE:usb0', 'GENERAL.TYPE:ethernet', 'GENERAL.STATE:30 (disconnected)', 'GENERAL.CONNECTION:--', 'GENERAL.METERED:unknown', 'GENERAL.DRIVER:rndis_host',
    ].join('\n');
    expect(parseDevices(text)).toEqual([
      { device: 'wlp0s20f3', type: 'wifi', state: 100, connection: 'Spectrum', metered: 'no (guessed)', driver: 'iwlwifi' },
      { device: 'tailscale0', type: 'tun', state: 100, connection: 'tailscale0', metered: 'no (guessed)', driver: 'tun' },
      { device: 'usb0', type: 'ethernet', state: 30, connection: '', metered: 'unknown', driver: 'rndis_host' },
    ]);
  });

  it('parses what this machine prints (if it has nmcli)', () => {
    let text: string;
    try {
      text = readFileSync(process.env.MESHDROP_NM_SAMPLE ?? '/nonexistent', 'utf8');
    } catch {
      return;
    }
    const devices = parseDevices(text);
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) expect(d.device).not.toBe('');
  });

  it('guards only the hotspot MeshDrop joined, never a network the user picked', () => {
    const base = { device: 'x', type: 'ethernet', state: 100, connection: 'c', metered: 'no (guessed)', driver: 'e1000e' };
    expect(isPhoneLink(base)).toBe(false);
    expect(isPhoneLink({ ...base, type: 'wifi', metered: 'yes (guessed)' })).toBe(false); // a hotspot the user joined
    for (const driver of ['rndis_host', 'cdc_ncm', 'cdc_ether', 'ipheth']) expect(isPhoneLink({ ...base, driver })).toBe(false);
    expect(isPhoneLink({ ...base, type: 'bt', driver: 'btusb' })).toBe(false);
    expect(isPhoneLink({ ...base, type: 'wifi', connection: JOIN_PROFILE })).toBe(true);
    expect(isPhoneLink({ ...base, type: 'wifi', connection: HOTSPOT_PROFILE })).toBe(false); // this PC hosts it
  });

  it('builds the nmcli commands', () => {
    expect(guardArgs('usb0')).toEqual(['device', 'modify', 'usb0', 'ipv4.never-default', 'yes', 'ipv6.never-default', 'yes', 'ipv4.ignore-auto-dns', 'yes', 'ipv6.ignore-auto-dns', 'yes']);
    expect(reapplyArgs('usb0')).toEqual(['device', 'reapply', 'usb0']);
    expect(hotspotArgs('wlan0', 'MeshDrop-AB12', 'pass word1')).toEqual(['device', 'wifi', 'hotspot', 'ifname', 'wlan0', 'con-name', HOTSPOT_PROFILE, 'ssid', 'MeshDrop-AB12', 'band', 'bg', 'password', 'pass word1']);
    const add = joinAddArgs('AndroidShare_1234', 'hafij');
    expect(add.slice(0, 10)).toEqual(['connection', 'add', 'type', 'wifi', 'con-name', JOIN_PROFILE, 'ifname', '*', 'ssid', 'AndroidShare_1234']);
    const opt = (k: string) => add[add.indexOf(k) + 1];
    expect(opt('connection.permissions')).toBe('user:hafij');
    expect(opt('connection.autoconnect')).toBe('no');
    expect(opt('ipv4.never-default')).toBe('yes');
    expect(opt('ipv6.ignore-auto-dns')).toBe('yes');
    expect(add.join(' ')).not.toContain('wifi-sec.psk '); // the password goes through a file
    const open = joinAddArgs('AndroidShare_1234', 'hafij', false); // tetherNoData off: the phone's internet is fine
    expect(open).not.toContain('ipv4.never-default');
    expect(open).not.toContain('ipv4.ignore-auto-dns');
    expect(joinUpArgs('/tmp/x')).toEqual(['connection', 'up', 'id', JOIN_PROFILE, 'passwd-file', '/tmp/x']);
  });

  it('makes hotspot credentials, checks them, and writes a Wi-Fi QR', () => {
    const h = newHotspot();
    expect(h.ssid).toMatch(/^MeshDrop-[0-9A-F]{4}$/);
    expect(h.psk).toMatch(/^[a-z2-9]{12}$/);
    expect(validHotspot(h.ssid, h.psk)).toBe(true);
    expect(validHotspot('x', 'short')).toBe(false);
    expect(validHotspot('', '12345678')).toBe(false);
    expect(validHotspot('a'.repeat(33), '12345678')).toBe(false);
    expect(validHotspot('ok', 'tab\there')).toBe(false);
    expect(wifiQr('My;Net', 'p:a"s,s\\')).toBe('WIFI:T:WPA;S:My\\;Net;P:p\\:a\\"s\\,s\\\\;;');
  });

  it('the guard: guards a phone link once per connection, lets go when it drops, puts it back when turned off', async () => {
    let show = dev('enp1', {}) + dev('usb0', { driver: 'rndis_host', connection: 'Wired 2' }) + dev('wlan0', { type: 'wifi', connection: JOIN_PROFILE });
    const nm = fakeNm(() => show);
    let changes = 0;
    const g = new TetherGuard(nm.runner, () => changes++, 60_000);
    await g.setEnabled(true);
    expect(nm.modifies()).toEqual([guardArgs('wlan0')]); // not the user's own USB tether
    expect(g.guarded()).toEqual(['wlan0']);
    expect(changes).toBe(1);

    await g.tick(); // nothing new
    expect(nm.modifies().length).toBe(1);

    show = dev('enp1', {}) + dev('wlan0', { type: 'wifi', state: 30 });
    await g.tick(); // left
    expect(g.guarded()).toEqual([]);
    show = dev('enp1', {}) + dev('wlan0', { type: 'wifi', connection: JOIN_PROFILE });
    await g.tick(); // joined again: a fresh connection, guarded again
    expect(nm.modifies().filter((a) => a[1] === 'modify').length).toBe(2);

    await g.setEnabled(false);
    expect(nm.modifies().at(-1)).toEqual(reapplyArgs('wlan0'));
    expect(g.guarded()).toEqual([]);
    const before = nm.calls.length;
    await g.tick(); // off: does nothing
    expect(nm.calls.length).toBe(before);
    g.stop();
  });

  it('the guard tries again next time when nmcli refuses', async () => {
    let refuse = true;
    const nm = fakeNm(() => dev('wlan0', { type: 'wifi', connection: JOIN_PROFILE }), (a) => refuse && a[1] === 'modify');
    const g = new TetherGuard(nm.runner, () => undefined, 60_000);
    await g.setEnabled(true);
    expect(g.guarded()).toEqual([]);
    refuse = false;
    await g.tick();
    expect(g.guarded()).toEqual(['wlan0']);
    g.stop();
  });

  it('NetMan: hosts on the Wi-Fi device, joins with the password in a file, stops both', async () => {
    let seenFile = '';
    let fileText = '';
    const calls: string[][] = [];
    const runner: Run = async (_c, args) => {
      calls.push(args);
      if (args[0] === '-t') return dev('wlp2', { type: 'wifi', connection: 'Home', driver: 'iwlwifi' });
      if (args[1] === 'up') {
        seenFile = args[5]!;
        fileText = readFileSync(seenFile, 'utf8');
      }
      return '';
    };
    const n = new NetMan(runner, () => undefined, 'me');
    expect(await n.wifi()).toEqual({ device: 'wlp2', network: 'Home' });
    const h = await n.host();
    expect(calls.at(-1)).toEqual(hotspotArgs('wlp2', h.ssid, h.psk));

    await n.join('Phone AP', 'secret123');
    expect(fileText).toBe('802-11-wireless-security.psk:secret123\n');
    expect(() => readFileSync(seenFile)).toThrow(); // removed again
    expect(calls.some((a) => a.includes('secret123'))).toBe(false);

    calls.length = 0;
    await n.stop();
    expect(calls).toEqual([['connection', 'delete', 'id', HOTSPOT_PROFILE], ['connection', 'delete', 'id', JOIN_PROFILE]]);
  });

  it('NetMan: a failed join removes the half-made profile', async () => {
    const calls: string[][] = [];
    const n = new NetMan(async (_c, args) => {
      calls.push(args);
      if (args[1] === 'up') throw new Error('Secrets were required, but not provided.');
      return '';
    }, () => undefined, 'me');
    await expect(n.join('X', '12345678')).rejects.toThrow(/Secrets/);
    expect(calls.at(-1)).toEqual(['connection', 'delete', 'id', JOIN_PROFILE]);
  });
});
