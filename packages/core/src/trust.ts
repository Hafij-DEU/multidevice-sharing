import { createPublicKey, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TrustedDevice {
  /** Lowercase hex SHA-256 of the device certificate DER (64 chars). */
  deviceId: string;
  alias: string;
  /** SPKI PEM of the device's public key. */
  publicKeyPem: string;
  /** Epoch milliseconds. */
  addedAt: number;
}

const DEVICE_ID_RE = /^[0-9a-f]{64}$/;

function validate(d: TrustedDevice): void {
  if (typeof d?.deviceId !== 'string' || !DEVICE_ID_RE.test(d.deviceId)) {
    throw new Error('invalid device id: expected 64 lowercase hex characters');
  }
  if (typeof d.alias !== 'string') throw new Error('invalid alias');
  if (typeof d.addedAt !== 'number' || !Number.isFinite(d.addedAt)) throw new Error('invalid addedAt');
  try {
    if (typeof d.publicKeyPem !== 'string') throw new Error('not a string');
    createPublicKey(d.publicKeyPem);
  } catch {
    throw new Error('invalid public key: expected an SPKI PEM');
  }
}

function copy(d: TrustedDevice): TrustedDevice {
  return { deviceId: d.deviceId, alias: d.alias, publicKeyPem: d.publicKeyPem, addedAt: d.addedAt };
}

/**
 * The set of devices this device trusts, persisted as `trust.json`.
 *
 * Reads happen once in the constructor (the file is only ever written by this class); every
 * mutation rewrites the file atomically: unique tmp file in the same directory, fsync, rename.
 * A corrupt file is an error rather than an empty store, so a damaged file can never silently
 * drop (or be replaced by) trust decisions.
 */
export class TrustStore {
  private readonly file: string;
  private readonly devices = new Map<string, TrustedDevice>();

  constructor(file: string) {
    this.file = file;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as { devices?: TrustedDevice[] };
      if (!parsed || !Array.isArray(parsed.devices)) throw new Error('missing "devices" array');
      for (const d of parsed.devices) {
        validate(d);
        this.devices.set(d.deviceId, copy(d));
      }
    } catch (e) {
      throw new Error(`corrupt trust store ${file}: ${(e as Error).message}`);
    }
  }

  list(): TrustedDevice[] {
    return [...this.devices.values()].map(copy);
  }

  get(deviceId: string): TrustedDevice | undefined {
    const d = this.devices.get(deviceId);
    return d && copy(d);
  }

  isTrusted(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /** Adds a device, replacing any existing entry with the same id. */
  add(d: TrustedDevice): void {
    validate(d);
    const prev = this.devices.get(d.deviceId);
    this.devices.set(d.deviceId, copy(d));
    this.persistOrRollback(d.deviceId, prev);
  }

  /** Removes a device; unknown ids are a no-op. */
  remove(deviceId: string): void {
    const prev = this.devices.get(deviceId);
    if (!prev) return;
    this.devices.delete(deviceId);
    this.persistOrRollback(deviceId, prev);
  }

  /** Keeps memory and disk consistent: if the write fails, the in-memory change is undone. */
  private persistOrRollback(deviceId: string, prev: TrustedDevice | undefined): void {
    try {
      this.persist();
    } catch (e) {
      if (prev) this.devices.set(deviceId, prev);
      else this.devices.delete(deviceId);
      throw e;
    }
  }

  private persist(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const data = JSON.stringify({ devices: this.list() }, null, 2) + '\n';
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600); // open() mode is subject to umask; be explicit
      renameSync(tmp, this.file);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw e;
    }
    // Persist the rename itself (best effort: directory fsync is unsupported on some platforms).
    try {
      const dfd = openSync(dir, 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* ignore */
    }
  }
}
