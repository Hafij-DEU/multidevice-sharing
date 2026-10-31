// M14 No Wi-Fi on the PC, through NetworkManager (nmcli):
// - the tether guard: on a phone's hotspot that MeshDrop joined, the PC never routes internet or DNS
//   through the phone (no mobile data), runtime only — networks the user picked are left alone;
// - hosting a hotspot (a phone with no Wi-Fi joins it) and joining a phone's local-only hotspot.
import { execFile } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Runs a command and resolves with its stdout (rejects with stderr in the message on a non-zero exit). */
export type Run = (cmd: string, args: string[]) => Promise<string>;

export const run: Run = (cmd, args) =>
  new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 60_000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) rej(new Error(String(stderr).trim() || err.message));
      else res(String(stdout));
    });
  });

/** The profile `nmcli device wifi hotspot` makes when this PC hosts. */
export const HOTSPOT_PROFILE = 'MeshDrop hotspot';
/** The profile made to join a phone's hotspot (one at a time, replaced on each join). */
export const JOIN_PROFILE = 'MeshDrop join';
/** NetworkManager's shared mode gives the hosting PC this address. */
export const HOTSPOT_HOST_IP = '10.42.0.1';

export interface NmDevice {
  device: string;
  type: string;
  /** NetworkManager's device state number (100 = connected). */
  state: number;
  connection: string;
  /** GENERAL.METERED as printed: 'yes', 'no', 'yes (guessed)', 'no (guessed)', 'unknown'. */
  metered: string;
  driver: string;
}

export const DEVICE_SHOW_ARGS = ['-t', '-m', 'multiline', '-f', 'GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.CONNECTION,GENERAL.METERED,GENERAL.DRIVER', 'device', 'show'];

/** Parses `nmcli -t -m multiline -f GENERAL.… device show`. */
export function parseDevices(text: string): NmDevice[] {
  const out: NmDevice[] = [];
  let d: NmDevice | null = null;
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (key === 'GENERAL.DEVICE') {
      d = { device: v, type: '', state: 0, connection: '', metered: '', driver: '' };
      out.push(d);
    } else if (d) {
      if (key === 'GENERAL.TYPE') d.type = v;
      else if (key === 'GENERAL.STATE') d.state = Number.parseInt(v, 10) || 0;
      else if (key === 'GENERAL.CONNECTION') d.connection = v === '--' ? '' : v;
      else if (key === 'GENERAL.METERED') d.metered = v;
      else if (key === 'GENERAL.DRIVER') d.driver = v;
    }
  }
  return out;
}

/**
 * A link the guard keeps from carrying the PC's internet: only the phone hotspot MeshDrop joined.
 * A hotspot, USB or Bluetooth tether the user connected to on their own is their call.
 */
export function isPhoneLink(d: NmDevice): boolean {
  return d.connection === JOIN_PROFILE;
}

const NO_ROUTE = ['ipv4.never-default', 'yes', 'ipv6.never-default', 'yes', 'ipv4.ignore-auto-dns', 'yes', 'ipv6.ignore-auto-dns', 'yes'];

/** No default route and no DNS through `dev`, for as long as it stays connected (the profile is not changed). */
export const guardArgs = (dev: string): string[] => ['device', 'modify', dev, ...NO_ROUTE];
/** Back to what the profile says. */
export const reapplyArgs = (dev: string): string[] => ['device', 'reapply', dev];

/** A new SSID and WPA2 password for a hotspot this PC hosts. */
export function newHotspot(): { ssid: string; psk: string } {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let psk = '';
  for (let i = 0; i < 12; i++) psk += abc[randomInt(abc.length)];
  return { ssid: `MeshDrop-${randomBytes(2).toString('hex').toUpperCase()}`, psk };
}

export const hotspotArgs = (ifname: string, ssid: string, psk: string): string[] =>
  ['device', 'wifi', 'hotspot', 'ifname', ifname, 'con-name', HOTSPOT_PROFILE, 'ssid', ssid, 'band', 'bg', 'password', psk];

/**
 * A private (this user only), non-autoconnect profile for a phone's hotspot that, with `noData`, never
 * takes the default route or DNS. The password is not on the command line: `up` reads it from a passwd-file.
 */
export const joinAddArgs = (ssid: string, user: string, noData = true): string[] => [
  'connection', 'add', 'type', 'wifi', 'con-name', JOIN_PROFILE, 'ifname', '*', 'ssid', ssid,
  'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk-flags', '0',
  'connection.autoconnect', 'no', 'connection.permissions', `user:${user}`, ...(noData ? NO_ROUTE : []),
];
export const joinUpArgs = (passwdFile: string): string[] => ['connection', 'up', 'id', JOIN_PROFILE, 'passwd-file', passwdFile];

/** A hotspot's SSID and password: SSID is 1–32 bytes, a WPA2 password 8–63 printable ASCII. */
export function validHotspot(ssid: unknown, psk: unknown): ssid is string {
  return typeof ssid === 'string' && ssid.length > 0 && Buffer.byteLength(ssid) <= 32 && !/[\0\n\r]/.test(ssid) &&
    typeof psk === 'string' && /^[\x20-\x7e]{8,63}$/.test(psk);
}

/** The text of a Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`), which phone cameras offer to join. */
export function wifiQr(ssid: string, psk: string): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(psk)};;`;
}

/**
 * Keeps the joined hotspot from carrying the PC's internet while `tetherNoData` is on: checks every 10 s,
 * guards each phone link once per connection, and puts them back when the setting is turned off.
 */
export class TetherGuard {
  readonly #run: Run;
  readonly #intervalMs: number;
  readonly #onChange: () => void;
  #on = false;
  #timer: NodeJS.Timeout | undefined;
  /** Device -> the connection it was guarded on (a reconnect is a new connection to guard). */
  readonly #guarded = new Map<string, string>();

  constructor(runner: Run, onChange: () => void = () => undefined, intervalMs = 10_000) {
    this.#run = runner;
    this.#onChange = onChange;
    this.#intervalMs = intervalMs;
  }

  /** The devices guarded right now. */
  guarded(): string[] {
    return [...this.#guarded.keys()];
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on === this.#on) return;
    this.#on = on;
    if (on) {
      this.#timer = setInterval(() => void this.tick().catch(() => undefined), this.#intervalMs);
      this.#timer.unref?.();
      await this.tick().catch(() => undefined);
      return;
    }
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const devs = this.guarded();
    this.#guarded.clear();
    for (const dev of devs) await this.#run('nmcli', reapplyArgs(dev)).catch(() => undefined);
    if (devs.length > 0) this.#onChange();
  }

  /** One check (exported for tests). */
  async tick(): Promise<void> {
    if (!this.#on) return;
    const devices = parseDevices(await this.#run('nmcli', DEVICE_SHOW_ARGS));
    let changed = false;
    for (const [dev, conn] of this.#guarded) {
      if (!devices.some((d) => d.device === dev && d.state === 100 && d.connection === conn)) {
        this.#guarded.delete(dev);
        changed = true;
      }
    }
    for (const d of devices) {
      if (d.state !== 100 || !isPhoneLink(d) || this.#guarded.get(d.device) === d.connection) continue;
      try {
        await this.#run('nmcli', guardArgs(d.device));
        this.#guarded.set(d.device, d.connection);
        changed = true;
      } catch {
        // not allowed (no polkit rule) or gone: tried again next time
      }
    }
    if (changed) this.#onChange();
  }

  /** Stops checking (the app quits); guarded links stay guarded until they disconnect. */
  stop(): void {
    this.#on = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** Hosting and joining hotspots, and the tether guard, on one NetworkManager. */
export class NetMan {
  readonly guard: TetherGuard;
  readonly #run: Run;
  readonly #user: string;

  constructor(runner: Run = run, onChange: () => void = () => undefined, user = userInfo().username) {
    this.#run = runner;
    this.#user = user;
    this.guard = new TetherGuard(runner, onChange);
  }

  async #devices(): Promise<NmDevice[]> {
    return parseDevices(await this.#run('nmcli', DEVICE_SHOW_ARGS));
  }

  /** The Wi-Fi device, and the network it is on (empty: not on one, or on a MeshDrop hotspot). */
  async wifi(): Promise<{ device: string; network: string } | null> {
    const w = (await this.#devices()).find((d) => d.type === 'wifi');
    if (!w) return null;
    const ours = w.connection === HOTSPOT_PROFILE || w.connection === JOIN_PROFILE;
    return { device: w.device, network: w.state === 100 && !ours ? w.connection : '' };
  }

  /** Starts a hotspot on this PC's Wi-Fi (it leaves the network the Wi-Fi is on). */
  async host(): Promise<{ ssid: string; psk: string }> {
    const w = await this.wifi();
    if (!w) throw new Error('This PC has no Wi-Fi to host a hotspot.');
    const h = newHotspot();
    await this.#run('nmcli', hotspotArgs(w.device, h.ssid, h.psk));
    return h;
  }

  async join(ssid: string, psk: string, noData = true): Promise<void> {
    await this.#run('nmcli', ['connection', 'delete', 'id', JOIN_PROFILE]).catch(() => undefined);
    await this.#run('nmcli', joinAddArgs(ssid, this.#user, noData));
    const dir = mkdtempSync(join(tmpdir(), 'meshdrop-nm-'));
    const file = join(dir, 'secrets');
    try {
      writeFileSync(file, `802-11-wireless-security.psk:${psk}\n`, { mode: 0o600 });
      await this.#run('nmcli', joinUpArgs(file));
    } catch (e) {
      await this.#run('nmcli', ['connection', 'delete', 'id', JOIN_PROFILE]).catch(() => undefined);
      throw e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Ends the hotspot this PC hosts or left a joined one; the Wi-Fi then goes back to its usual network. */
  async stop(): Promise<void> {
    for (const id of [HOTSPOT_PROFILE, JOIN_PROFILE]) await this.#run('nmcli', ['connection', 'delete', 'id', id]).catch(() => undefined);
  }
}
