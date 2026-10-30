// Desktop settings: one JSON file next to the engine's config (<home>/desktop-settings.json, 0600).
// Every change is validated as a whole; an invalid patch changes nothing.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import type { Settings } from '../shared/api.ts';

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** Controls and bidi overrides never belong in a name shown to other devices. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export function defaultSettings(over: Partial<Settings> = {}): Settings {
  return {
    alias: hostname().slice(0, 64),
    inbox: join(homedir(), 'Downloads', 'MeshDrop'),
    port: 53318,
    discovery: true,
    autostart: false,
    startHidden: false,
    closeToTray: true,
    clipboardReceive: true,
    clipboardSync: false,
    notifications: true,
    guestMinutes: 60,
    remoteFrom: [],
    openLinks: true,
    phoneNotifications: true,
    printFromDevices: true,
    sortInbox: false,
    sendReceipts: true,
    cleanupDays: 0,
    bluetooth: true,
    allBluetooth: false,
    deviceLinks: {},
    tetherNoData: true,
    btSoundKbps: 12,
    ...over,
  };
}

/** Writable directory, or a path whose nearest existing ancestor is a writable directory. */
function writableDirOrCreatable(p: string): boolean {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) {
      try {
        if (!statSync(cur).isDirectory()) return false;
        accessSync(cur, constants.W_OK | constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

function validate(s: Settings): void {
  if (typeof s.alias !== 'string' || s.alias.length < 1 || s.alias.length > 64 || UNPRINTABLE.test(s.alias)) {
    throw new SettingsError('The device name must be 1–64 characters, without control characters.');
  }
  if (typeof s.inbox !== 'string' || !isAbsolute(s.inbox) || !writableDirOrCreatable(s.inbox)) {
    throw new SettingsError(`Cannot save received files in ${JSON.stringify(s.inbox)}: choose a folder you can write to.`);
  }
  if (!Number.isInteger(s.port) || (s.port !== 0 && (s.port < 1024 || s.port > 65535))) {
    throw new SettingsError('The port must be between 1024 and 65535 (or 0 for any free port).');
  }
  if (!Number.isInteger(s.guestMinutes) || s.guestMinutes < 5 || s.guestMinutes > 1440) {
    throw new SettingsError('A guest link must last between 5 minutes and 24 hours (1440 minutes).');
  }
  if (!Number.isInteger(s.cleanupDays) || s.cleanupDays < 0 || s.cleanupDays > 3650) {
    throw new SettingsError('Clean-up must be 0 (never) or a number of days up to 3650.');
  }
  if (!Array.isArray(s.remoteFrom) || s.remoteFrom.length > 64 || s.remoteFrom.some((d) => typeof d !== 'string' || !/^[0-9a-f]{64}$/.test(d))) {
    throw new SettingsError('Invalid list of devices that may control this PC.');
  }
  const links = s.deviceLinks;
  if (
    typeof links !== 'object' || links === null || Array.isArray(links) || Object.keys(links).length > 256 ||
    Object.entries(links).some(([id, m]) => !/^[0-9a-f]{64}$/.test(id) || (m !== 'auto' && m !== 'wifi' && m !== 'bt'))
  ) {
    throw new SettingsError('Invalid connection choice for a device.');
  }
  if (![8, 12, 16, 24, 32].includes(s.btSoundKbps)) {
    throw new SettingsError('Sound over Bluetooth must be 8, 12, 16, 24 or 32 kbit/s.');
  }
  for (const k of ['discovery', 'autostart', 'startHidden', 'closeToTray', 'clipboardReceive', 'clipboardSync', 'notifications', 'openLinks', 'phoneNotifications', 'printFromDevices', 'sortInbox', 'sendReceipts', 'bluetooth', 'allBluetooth', 'tetherNoData'] as const) {
    if (typeof s[k] !== 'boolean') throw new SettingsError(`Invalid value for ${k}.`);
  }
}

export class SettingsStore {
  readonly #file: string;
  #current: Settings;

  constructor(file: string, defaults: Settings) {
    this.#file = file;
    let loaded: Partial<Settings> = {};
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
    } catch {
      /* missing or damaged: defaults */
    }
    const merged = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof Settings)[]) {
      if (loaded[k] !== undefined) (merged as Record<string, unknown>)[k] = loaded[k];
    }
    try {
      validate(merged);
      this.#current = merged;
    } catch {
      this.#current = { ...defaults };
    }
  }

  get(): Settings {
    return { ...this.#current };
  }

  /** The settings `patch` would produce, validated; nothing is saved. */
  preview(patch: Partial<Settings>): Settings {
    const next = { ...this.#current };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in next)) throw new SettingsError(`Unknown setting ${k}.`);
      (next as Record<string, unknown>)[k] = v;
    }
    validate(next);
    return next;
  }

  set(patch: Partial<Settings>): Settings {
    const next = this.preview(patch);
    writeFileAtomic(this.#file, JSON.stringify(next, null, 2));
    this.#current = next;
    return this.get();
  }
}
