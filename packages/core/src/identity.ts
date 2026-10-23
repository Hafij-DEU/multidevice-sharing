import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
 * P-256 key and self-signed certificate on first run.
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

  const { publicKey, privateKey } = keyPem
    ? { privateKey: createPrivateKey(keyPem), publicKey: createPublicKey(keyPem) }
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spkiHash = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // keep the serial a small positive integer
  const cert = buildSelfSignedCert({
    publicKey,
    privateKey,
    commonName: `meshdrop-${spkiHash.slice(0, 8)}`,
    serial,
  });

  await mkdir(idDir, { recursive: true, mode: 0o700 });
  if (!keyPem) await writeAtomic(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  await writeAtomic(certPath, cert, 0o644);
  return fromParts(privateKey, cert);
}
