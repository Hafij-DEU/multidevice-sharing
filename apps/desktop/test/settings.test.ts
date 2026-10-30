import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsError, SettingsStore, defaultSettings } from '../src/main/settings.ts';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-settings-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('starts from defaults when the file is missing', () => {
    const dir = tmpDir();
    const defaults = defaultSettings({ alias: 'pc', inbox: join(dir, 'inbox') });
    const s = new SettingsStore(join(dir, 'desktop-settings.json'), defaults);
    expect(s.get()).toEqual(defaults);
    expect(defaults).toMatchObject({ port: 53318, discovery: true, autostart: false, startHidden: false, closeToTray: true, clipboardReceive: true, notifications: true });
  });

  it('persists a valid change (0600) and reloads it', () => {
    const dir = tmpDir();
    const file = join(dir, 'desktop-settings.json');
    const defaults = defaultSettings({ alias: 'pc', inbox: dir });
    new SettingsStore(file, defaults).set({ alias: 'Laptop ✓', notifications: false });
    expect(new SettingsStore(file, defaults).get()).toMatchObject({ alias: 'Laptop ✓', notifications: false });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses an inbox it cannot write and keeps the old one', () => {
    const dir = tmpDir();
    const s = new SettingsStore(join(dir, 's.json'), defaultSettings({ alias: 'pc', inbox: dir }));
    expect(() => s.set({ inbox: '/proc/forbidden' })).toThrow(SettingsError);
    expect(() => s.set({ inbox: 'relative/path' })).toThrow(SettingsError);
    expect(s.get().inbox).toBe(dir);
    expect(s.set({ inbox: join(dir, 'new', 'inbox') }).inbox).toBe(join(dir, 'new', 'inbox')); // creatable
  });

  it('refuses aliases with control or bidi characters, bad ports and non-booleans; nothing changes', () => {
    const dir = tmpDir();
    const s = new SettingsStore(join(dir, 's.json'), defaultSettings({ alias: 'pc', inbox: dir }));
    expect(() => s.set({ alias: '‮evil' })).toThrow(SettingsError);
    expect(() => s.set({ alias: '' })).toThrow(SettingsError);
    expect(() => s.set({ alias: 'x'.repeat(65) })).toThrow(SettingsError);
    expect(() => s.set({ port: 80 })).toThrow(SettingsError);
    expect(() => s.set({ port: 70000 })).toThrow(SettingsError);
    expect(() => s.set({ alias: 'ok', notifications: 'yes' as unknown as boolean })).toThrow(SettingsError);
    expect(s.get().alias).toBe('pc');
    expect(s.set({ port: 0 }).port).toBe(0);
  });

  it('No Wi-Fi (M14): Bluetooth on and mobile data off by default; per-device modes are checked', () => {
    const dir = tmpDir();
    const s = new SettingsStore(join(dir, 's.json'), defaultSettings({ alias: 'pc', inbox: dir }));
    expect(s.get()).toMatchObject({ bluetooth: true, allBluetooth: false, deviceLinks: {}, tetherNoData: true, btSoundKbps: 12 });
    const id = 'a'.repeat(64);
    expect(s.set({ deviceLinks: { [id]: 'bt' }, allBluetooth: true }).deviceLinks).toEqual({ [id]: 'bt' });
    expect(() => s.set({ deviceLinks: { [id]: 'usb' as never } })).toThrow(SettingsError);
    expect(() => s.set({ deviceLinks: { nothex: 'wifi' } })).toThrow(SettingsError);
    expect(() => s.set({ deviceLinks: [] as never })).toThrow(SettingsError);
    expect(() => s.set({ tetherNoData: 1 as never })).toThrow(SettingsError);
    expect(s.get().deviceLinks).toEqual({ [id]: 'bt' });
    for (const k of [8, 12, 16, 24]) expect(s.set({ btSoundKbps: k }).btSoundKbps).toBe(k);
    expect(s.set({ btSoundKbps: 32 }).btSoundKbps).toBe(32);
    for (const k of [6, 20, 64]) expect(() => s.set({ btSoundKbps: k })).toThrow(SettingsError);
    expect(s.get().btSoundKbps).toBe(32);
  });
});
