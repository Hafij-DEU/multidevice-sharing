import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gtkToAccelerator, listStartMenuApps, parseBattery, parseFileNameW, savedShortcut, saveShortcut } from '../src/main/windows.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};

describe('Windows clipboard shortcut', () => {
  it('turns the GTK binding Settings offers into an Electron accelerator', () => {
    expect(gtkToAccelerator('<Primary><Alt>c')).toBe('CommandOrControl+Alt+C');
    expect(gtkToAccelerator('<Shift><Super>F9')).toBe('Shift+Super+F9');
    expect(gtkToAccelerator('<Control><Control>v')).toBe('Control+V');
  });

  it('refuses a binding without a key or with an unknown modifier', () => {
    expect(() => gtkToAccelerator('<Primary>')).toThrow();
    expect(() => gtkToAccelerator('<Hyper>c')).toThrow();
  });

  it('keeps the shortcut in the config folder', () => {
    const home = tmp('md-sc-');
    expect(savedShortcut(home)).toBeNull();
    saveShortcut(home, '<Primary><Alt>c');
    expect(savedShortcut(home)).toBe('<Primary><Alt>c');
    saveShortcut(home, null);
    expect(savedShortcut(home)).toBeNull();
  });
});

describe('Windows platform bits', () => {
  it('reads the battery from Win32_Battery', () => {
    expect(parseBattery('87 1\r\n')).toEqual({ level: 87, charging: false });
    expect(parseBattery('100 2')).toEqual({ level: 100, charging: true });
    expect(parseBattery('')).toBeUndefined();
  });

  it("reads Explorer's FileNameW clipboard format", () => {
    expect(parseFileNameW(Buffer.from('C:\\Users\\u\\a b.txt\0\0garbage', 'utf16le'))).toEqual(['C:\\Users\\u\\a b.txt']);
    expect(parseFileNameW(Buffer.alloc(0))).toEqual([]);
  });

  it('lists Start menu shortcuts without uninstallers, the first folder winning', () => {
    const all = tmp('md-sm-');
    const mine = tmp('md-sm-');
    mkdirSync(join(all, 'Tools'));
    writeFileSync(join(all, 'Tools', 'Paint.lnk'), '');
    writeFileSync(join(all, 'Uninstall Paint.lnk'), '');
    writeFileSync(join(all, 'notes.txt'), '');
    writeFileSync(join(mine, 'paint.lnk'), '');
    writeFileSync(join(mine, 'Calculator.url'), '');
    const apps = listStartMenuApps([all, mine]);
    expect(apps.map((a) => [a.id, a.name])).toEqual([
      ['1/Calculator.url', 'Calculator'],
      ['0/Tools/Paint.lnk', 'Paint'],
    ]);
    expect(apps[1]!.path).toBe(join(all, 'Tools', 'Paint.lnk'));
  });
});
