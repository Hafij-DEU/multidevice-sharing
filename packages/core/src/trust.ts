import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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

/** What the HTTP API needs to decide whether a peer may talk to us (TrustStore, MembershipStore, CompositeTrust). */
export interface TrustSource {
  isTrusted(deviceId: string): boolean;
  get(deviceId: string): TrustedDevice | undefined;
}

export const DEVICE_ID_RE = /^[0-9a-f]{64}$/;

/** Validates `d` and returns a normalized copy (canonical SPKI PEM). */
function validate(d: TrustedDevice): TrustedDevice {
  if (typeof d?.deviceId !== 'string' || !DEVICE_ID_RE.test(d.deviceId)) {
    throw new Error('invalid device id: expected 64 lowercase hex characters');
  }
  if (typeof d.alias !== 'string') throw new Error('invalid alias');
  if (typeof d.addedAt !== 'number' || !Number.isFinite(d.addedAt)) throw new Error('invalid addedAt');
  if (typeof d.publicKeyPem !== 'string') throw new Error('invalid public key: expected an SPKI PEM');
  return { deviceId: d.deviceId, alias: d.alias, publicKeyPem: canonicalSpki(d.publicKeyPem), addedAt: d.addedAt };
}

/**
 * Returns the canonical SPKI PEM for an EC P-256 public key, or throws. `createPublicKey`
 * happily derives a public key from a PKCS#8 private-key PEM or a certificate PEM, which would
 * let secret key material be persisted into trust.json; so we require that re-exporting as SPKI
 * reproduces the input (modulo line endings / surrounding whitespace).
 */
export function canonicalSpki(pem: string): string {
  const bad = () => new Error('invalid public key: expected an EC P-256 SPKI PEM');
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw bad();
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw bad();
  }
  const canonical = key.export({ type: 'spki', format: 'pem' }) as string;
  if (pem.replace(/\r\n/g, '\n').trim() !== canonical.trim()) throw bad();
  return canonical;
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
export class TrustStore implements TrustSource {
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
        const v = validate(d);
        this.devices.set(v.deviceId, v);
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
    const v = validate(d);
    const prev = this.devices.get(v.deviceId);
    this.devices.set(v.deviceId, v);
    this.persistOrRollback(v.deviceId, prev);
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
    writeFileAtomic(this.file, JSON.stringify({ devices: this.list() }, null, 2) + '\n');
  }
}

/**
 * Atomically replaces `file`: unique tmp file in the same directory (mode 0600), fsync, rename, then
 * a best-effort directory fsync. The directory is created with mode 0700. With `noClobber` the final
 * step is a hard link instead of a rename, so an existing `file` is never replaced (throws EEXIST).
 */
export function writeFileAtomic(file: string, data: string | Buffer, opts: { noClobber?: boolean } = {}): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // open() mode is subject to umask; be explicit
    if (opts.noClobber) {
      linkSync(tmp, file);
      unlinkSync(tmp);
    } else {
      renameSync(tmp, file);
    }
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

/**
 * The pairing code both devices show (6 digits, "123 456"): the same on both sides only when each
 * talks to the other and not to someone in between. The user compares them before trusting.
 */
export function pairingCode(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  const n = createHash('sha256').update(`meshdrop-pair-v1\0${x}\0${y}`).digest().readUInt32BE(0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
