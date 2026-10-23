/**
 * The mesh root key: `<home>/hub/root-key.pem`, PKCS#8 PEM (EC P-256), mode 0600 in a 0700 directory.
 * Only the hub holds it. The mesh id is spkiSha256 of its public half (see membership.ts).
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../trust.ts';
import { MembershipError } from './membership.ts';

function keyFile(home: string): string {
  return join(home, 'hub', 'root-key.pem');
}

/** Reads the key file; null when it does not exist. A file that is not a P-256 private key is an error (never overwritten). */
function readKey(file: string): KeyObject | null {
  let pem: string;
  try {
    pem = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new MembershipError(`corrupt root key ${file}: not a PEM private key`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new MembershipError(`corrupt root key ${file}: not an EC P-256 key`);
  }
  if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
  return key;
}

/** Whether this home has a mesh root key (i.e. it is, or was set up as, a hub). */
export async function hasRootKey(home: string): Promise<boolean> {
  try {
    statSync(keyFile(home));
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the root key, generating and persisting it on first use. Creation never replaces an existing
 * file (hard-link publish), so concurrent first calls end up with one key.
 */
export async function loadOrCreateRootKey(home: string): Promise<KeyObject> {
  const file = keyFile(home);
  const existing = readKey(file);
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  try {
    writeFileAtomic(file, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { noClobber: true });
    return privateKey;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const winner = readKey(file);
    if (!winner) throw e;
    return winner;
  }
}
