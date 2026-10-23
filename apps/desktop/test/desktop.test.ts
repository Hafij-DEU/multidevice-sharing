import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSTART_NAME, autostartFile, gnomeShortcutCommands, parseStrList, setAutostart, validBinding } from '../src/main/desktop.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings';

describe('autostart', () => {
  it('starts hidden at login', () => {
    const f = autostartFile('/opt/MeshDrop/meshdrop-desktop');
    expect(f).toContain('Exec=/opt/MeshDrop/meshdrop-desktop --hidden');
    expect(f).toContain('X-GNOME-Autostart-enabled=true');
    expect(f.startsWith('[Desktop Entry]\n')).toBe(true);
  });

  it('quotes an executable path with spaces', () => {
    expect(autostartFile('/home/u/My Apps/meshdrop')).toContain('Exec="/home/u/My Apps/meshdrop" --hidden');
  });

  it('writes and removes the autostart entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-auto-'));
    tmps.push(dir);
    setAutostart(true, '/opt/MeshDrop/meshdrop-desktop', dir);
    expect(readFileSync(join(dir, AUTOSTART_NAME), 'utf8')).toContain('--hidden');
    setAutostart(false, '/opt/MeshDrop/meshdrop-desktop', dir);
    expect(existsSync(join(dir, AUTOSTART_NAME))).toBe(false);
    setAutostart(false, '/x', dir); // already off: no error
  });
});

describe('GNOME shortcut', () => {
  it('appends a new custom keybinding and keeps the existing ones', () => {
    const cmds = gnomeShortcutCommands('<Primary><Alt>c', '/opt/MeshDrop/meshdrop-desktop', [`${BASE}/custom0/`]);
    expect(cmds[0]).toEqual(['gsettings', 'set', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings', `['${BASE}/custom0/', '${BASE}/custom1/']`]);
    const schema = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${BASE}/custom1/`;
    expect(cmds).toContainEqual(['gsettings', 'set', schema, 'name', 'MeshDrop: send clipboard']);
    expect(cmds).toContainEqual(['gsettings', 'set', schema, 'command', '/opt/MeshDrop/meshdrop-desktop --send-clipboard']);
    expect(cmds).toContainEqual(['gsettings', 'set', schema, 'binding', '<Primary><Alt>c']);
  });

  it('starts at custom0 with no existing keybindings and skips used numbers', () => {
    expect(gnomeShortcutCommands('<Super>m', '/x', [])[0]![4]).toBe(`['${BASE}/custom0/']`);
    expect(gnomeShortcutCommands('<Super>m', '/x', [`${BASE}/custom1/`, `${BASE}/custom0/`])[0]![4]).toContain('custom2/');
  });

  it('parses gsettings string lists', () => {
    expect(parseStrList('@as []')).toEqual([]);
    expect(parseStrList(`['${BASE}/custom0/', '${BASE}/custom3/']\n`)).toEqual([`${BASE}/custom0/`, `${BASE}/custom3/`]);
  });

  it('accepts only plain accelerator strings', () => {
    expect(validBinding('<Primary><Alt>c')).toBe(true);
    expect(validBinding("c'; rm -rf ~")).toBe(false);
    expect(validBinding('')).toBe(false);
  });
});
