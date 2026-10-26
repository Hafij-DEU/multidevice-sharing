import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './paths.ts';
import { buildSelfSignedCert } from './x509.ts';

export interface Identity {
  /** Lowercase hex SHA-256 of the certificate DER (64 chars). */
  deviceId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  certDer: Buffer;
  certPem: string;
  keyPem: string;
}

export function deviceIdOf(certDer: Buffer): string {
  return createHash('sha256').update(certDer).digest('hex');
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function fromParts(privateKey: KeyObject, certDer: Buffer): Identity {
  return {
    deviceId: deviceIdOf(certDer),
    privateKey,
    publicKey: createPublicKey(privateKey),
    certDer,
    certPem: derToPem(certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeAtomic(path: string, data: string | Buffer, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/**
 * Loads the device identity from `<dir>/identity/{key.pem,cert.der}`, creating a fresh
 * P-256 key and self-signed certificate on first run (neither file exists). If only one of the two
 * files exists it throws instead of regenerating: the device id must never change silently.
 */
export async function loadOrCreateIdentity(dir: string = configDir()): Promise<Identity> {
  const idDir = join(dir, 'identity');
  const keyPath = join(idDir, 'key.pem');
  const certPath = join(idDir, 'cert.der');

  const keyPem = await readIfExists(keyPath);
  const certDer = await readIfExists(certPath);
  if (keyPem && certDer) {
    const privateKey = createPrivateKey(keyPem);
    // Fail loudly if the stored cert does not belong to the stored key.
    if (!new X509Certificate(certDer).verify(createPublicKey(privateKey))) {
      throw new Error(`identity cert does not match key in ${idDir}`);
    }
    return fromParts(privateKey, certDer);
  }
  // Half an identity is never "repaired": a new cert (even for the same key) or a new key is a new
  // device id, which silently breaks every pairing. Make the user restore the file or remove both.
  if (keyPem || certDer) {
    const missing = keyPem ? 'cert.der' : 'key.pem';
    throw new Error(
      `identity in ${idDir} is incomplete: ${missing} is missing. Restore it from a backup, or delete ` +
        `${keyPem ? 'key.pem' : 'cert.der'} too to create a new device identity (this device will need to be paired again).`,
    );
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spkiHash = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // keep the serial a small positive integer
  const cert = buildSelfSignedCert({
    publicKey,
    privateKey,
    commonName: `meshdrop-${spkiHash.slice(0, 8)}`,
    serial,
  });

  // Created atomically: both files go into a temp dir that is renamed to identity/ in one step, so a
  // crash can never leave half an identity behind (which the check above would refuse).
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpDir = join(dir, `identity.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await mkdir(tmpDir, { mode: 0o700 });
  try {
    await writeAtomic(join(tmpDir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
    await writeAtomic(join(tmpDir, 'cert.der'), cert, 0o644);
    try {
      await rename(tmpDir, idDir); // replaces an empty identity/ dir
    } catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      // Windows will not rename a folder onto an existing one, even an empty one: EPERM there
      if (c !== 'ENOTEMPTY' && c !== 'EEXIST' && !(c === 'EPERM' && process.platform === 'win32')) throw e;
      // Lost a race to another process: use its identity.
      if ((await readIfExists(keyPath)) || (await readIfExists(certPath))) return loadOrCreateIdentity(dir);
      // identity/ holds neither file. Leftover `*.tmp` files from a crashed first run (older
      // writeAtomic) are safe to clear; anything else is the user's and stops us, never a retry loop.
      const names = await readdir(idDir);
      const unexpected = names.filter((n) => !n.endsWith('.tmp'));
      if (unexpected.length > 0) {
        throw new Error(
          `identity dir ${idDir} has no key.pem/cert.der but contains unexpected files: ${unexpected.join(', ')}. ` +
            `Move them away (or restore key.pem and cert.der) and start again.`,
        );
      }
      for (const n of names) await rm(join(idDir, n), { force: true });
      await rmdir(idDir); // empty now (fails if not): gone, so Windows can rename onto it too
      await rename(tmpDir, idDir);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  return fromParts(privateKey, cert);
}
