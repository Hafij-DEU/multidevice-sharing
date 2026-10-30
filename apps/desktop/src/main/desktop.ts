// Linux desktop integration that needs no Electron: the autostart entry, the GNOME custom keyboard
// shortcut for "send clipboard" and the Files (Nautilus) right-click script "Send with MeshDrop".
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';

export const AUTOSTART_NAME = 'io.github.hafijbge.meshdrop.desktop';
const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
const KEYBINDING_BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings';

/** An Exec= argument, quoted per the Desktop Entry spec when it needs it. */
function execArg(s: string): string {
  return /^[A-Za-z0-9_./+-]+$/.test(s) ? s : `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The command line that starts this app: one path, or argv (e.g. electron + app dir in development). */
export type Exec = string | string[];
const execLine = (e: Exec): string => (typeof e === 'string' ? [e] : e).map(execArg).join(' ');

export function autostartDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart');
}

export function autostartFile(execPath: Exec): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=MeshDrop',
    'Comment=Send files between your devices',
    `Exec=${execLine(execPath)} --hidden`,
    'Icon=meshdrop-desktop',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function setAutostart(on: boolean, execPath: Exec, dir = autostartDir()): void {
  const file = join(dir, AUTOSTART_NAME);
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, autostartFile(execPath));
}

/** A GTK accelerator such as `<Primary><Alt>c`: nothing that could break out of a gsettings value. */
export function validBinding(b: string): boolean {
  return b.length <= 64 && /^(<[A-Za-z0-9]+>)*[A-Za-z0-9]+$/.test(b);
}

/** Parses gsettings' printed string array (`@as []` or `['a', 'b']`). */
export function parseStrList(out: string): string[] {
  return [...out.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
}

/**
 * The gsettings argv lists that add a "MeshDrop: send clipboard" custom keybinding, appended to
 * the `existing` custom keybinding paths (read them first with `gsettings get`).
 */
export function gnomeShortcutCommands(binding: string, execPath: Exec, existing: string[]): string[][] {
  if (!validBinding(binding)) throw new Error(`invalid shortcut ${JSON.stringify(binding)}`);
  let n = 0;
  while (existing.includes(`${KEYBINDING_BASE}/custom${n}/`)) n++;
  const path = `${KEYBINDING_BASE}/custom${n}/`;
  const list = [...existing, path].map((p) => `'${p}'`).join(', ');
  const schema = `${MEDIA_KEYS}.custom-keybinding:${path}`;
  return [
    ['gsettings', 'set', MEDIA_KEYS, 'custom-keybindings', `[${list}]`],
    ['gsettings', 'set', schema, 'name', 'MeshDrop: send clipboard'],
    ['gsettings', 'set', schema, 'command', `${execLine(execPath)} --send-clipboard`],
    ['gsettings', 'set', schema, 'binding', binding],
  ];
}

export const READ_KEYBINDINGS = ['gsettings', 'get', MEDIA_KEYS, 'custom-keybindings'];

export const NAUTILUS_SCRIPT = 'Send with MeshDrop';

function nautilusScriptsDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'nautilus', 'scripts');
}

/** Files → right-click → Scripts → Send with MeshDrop: hands the selection to the running app. */
function nautilusScript(execPath: Exec): string {
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return ['#!/bin/sh', '# Installed by MeshDrop: right-click files in Files, then Scripts → Send with MeshDrop.', `exec ${(typeof execPath === 'string' ? [execPath] : execPath).map(sh).join(' ')} --send "$@"`, ''].join('\n');
}

/** Writes the script when Files is in use here (its data folder exists) and it changed; returns whether it is there. */
export function installNautilusScript(execPath: Exec, dir = nautilusScriptsDir()): boolean {
  if (!existsSync(join(dir, '..'))) return false;
  const file = join(dir, NAUTILUS_SCRIPT);
  const body = nautilusScript(execPath);
  if (existsSync(file) && readFileSync(file, 'utf8') === body) return true;
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, body);
  chmodSync(file, 0o755);
  return true;
}

/** The files after `--send` in a command line (absolute paths that exist; `C:\...` on Windows). */
export function sendArgs(argv: string[]): string[] {
  const i = argv.indexOf('--send');
  return i < 0 ? [] : argv.slice(i + 1).filter((p) => isAbsolute(p) && existsSync(p));
}
