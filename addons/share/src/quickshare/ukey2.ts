// UKEY2: Quick Share's key exchange (P-256 ECDH with a commitment), then the keys and the 4-digit
// code both screens show. The derivation follows the open UKEY2 and Nearby Connections sources.
import { createECDH, createHash, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { Fields, Writer } from './proto.ts';

const T_CLIENT_INIT = 2;
const T_SERVER_INIT = 3;
const T_CLIENT_FINISH = 4;
const P256_SHA512 = 100;
const EC_P256 = 1;
const NEXT_PROTOCOL = 'AES_256_CBC-HMAC_SHA256';

export interface Keys {
  encryptKey: Buffer;
  sendHmacKey: Buffer;
  decryptKey: Buffer;
  receiveHmacKey: Buffer;
  /** The code both devices show. */
  pin: string;
}

/** Reads and writes one handshake message at a time (the plaintext, length-prefixed connection). */
export interface HandshakeIo {
  next(timeoutMs: number): Promise<Buffer>;
  write(b: Buffer): Promise<void>;
}

export class HandshakeError extends Error {}

const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
const sha512 = (b: Buffer): Buffer => createHash('sha512').update(b).digest();
const hkdf = (ikm: Buffer, salt: Buffer | string, info: Buffer | string, n: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, typeof salt === 'string' ? Buffer.from(salt) : salt, typeof info === 'string' ? Buffer.from(info) : info, n));

export const D2D_SALT = sha256('D2D');
export const SECURE_MESSAGE_SALT = sha256('SecureMessage');

function message(type: number, data: Buffer): Buffer {
  return new Writer().int(1, type).bytes(2, data).done();
}

function unwrap(raw: Buffer, want: number): Fields {
  const m = new Fields(raw);
  const type = m.int(1);
  if (type !== want) throw new HandshakeError(`expected UKEY2 message ${want}, got ${String(type)}`);
  return new Fields(m.bytes(2) ?? Buffer.alloc(0));
}

/** A coordinate as Java's BigInteger writes it: big-endian, with a 0 byte when the top bit is set. */
function coordinate(b: Buffer): Buffer {
  return (b[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), b]) : b;
}

function publicKey(ecdh: ECDH): Writer {
  const p = ecdh.getPublicKey(); // 0x04 ‖ X ‖ Y
  return new Writer().int(1, EC_P256).msg(2, new Writer().bytes(1, coordinate(p.subarray(1, 33))).bytes(2, coordinate(p.subarray(33, 65))));
}

function point(b: Buffer | undefined): Buffer {
  if (!b) throw new HandshakeError('missing key coordinate');
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  if (v.length > 32) throw new HandshakeError('bad key coordinate');
  return Buffer.concat([Buffer.alloc(32 - v.length), v]);
}

function peerKey(f: Fields | undefined): Buffer {
  if (!f || f.int(1) !== EC_P256) throw new HandshakeError('not a P-256 key');
  const ec = f.msg(2);
  return Buffer.concat([Buffer.from([4]), point(ec?.bytes(1)), point(ec?.bytes(2))]);
}

/** The code shown on both screens: a hash of the auth string, as Nearby Sharing computes it. */
export function pinOf(auth: Buffer): string {
  let hash = 0;
  let mult = 1;
  for (const u of auth) {
    const b = u > 127 ? u - 256 : u;
    hash = (hash + b * mult) % 9973;
    mult = (mult * 31) % 9973;
  }
  return String(Math.abs(hash)).padStart(4, '0');
}

function derive(ecdh: ECDH, peer: Buffer, clientInit: Buffer, serverInit: Buffer, client: boolean): Keys {
  let shared: Buffer;
  try {
    shared = ecdh.computeSecret(peer);
  } catch {
    throw new HandshakeError('bad peer key');
  }
  const ikm = sha256(shared);
  const info = Buffer.concat([clientInit, serverInit]);
  const auth = hkdf(ikm, 'UKEY2 v1 auth', info, 32);
  const next = hkdf(ikm, 'UKEY2 v1 next', info, 32);
  const d2dClient = hkdf(next, D2D_SALT, 'client', 32);
  const d2dServer = hkdf(next, D2D_SALT, 'server', 32);
  const enc = (k: Buffer): Buffer => hkdf(k, SECURE_MESSAGE_SALT, 'ENC:2', 32);
  const sig = (k: Buffer): Buffer => hkdf(k, SECURE_MESSAGE_SALT, 'SIG:1', 32);
  const mine = client ? d2dClient : d2dServer;
  const theirs = client ? d2dServer : d2dClient;
  return { encryptKey: enc(mine), sendHmacKey: sig(mine), decryptKey: enc(theirs), receiveHmacKey: sig(theirs), pin: pinOf(auth) };
}

/** The sending side's half of the handshake. */
export async function clientHandshake(io: HandshakeIo, timeoutMs: number): Promise<Keys> {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const finished = message(T_CLIENT_FINISH, new Writer().msg(1, publicKey(ecdh)).done());
  const init = message(
    T_CLIENT_INIT,
    new Writer().int(1, 1).bytes(2, randomBytes(32)).msg(3, new Writer().int(1, P256_SHA512).bytes(2, sha512(finished))).str(4, NEXT_PROTOCOL).done(),
  );
  await io.write(init);
  const serverInit = await io.next(timeoutMs);
  const s = unwrap(serverInit, T_SERVER_INIT);
  if (s.int(1) !== 1) throw new HandshakeError('unsupported UKEY2 version');
  if (s.int(3) !== P256_SHA512) throw new HandshakeError('unsupported UKEY2 cipher');
  const keys = derive(ecdh, peerKey(s.msg(4)), init, serverInit, true);
  await io.write(finished);
  return keys;
}

/** The receiving side's half: answers the client's init and checks its finish against the commitment. */
export async function serverHandshake(io: HandshakeIo, timeoutMs: number): Promise<Keys> {
  const clientInit = await io.next(timeoutMs);
  const c = unwrap(clientInit, T_CLIENT_INIT);
  if (c.int(1) !== 1) throw new HandshakeError('unsupported UKEY2 version');
  const commitment = c.msgs(3).find((m) => m.int(1) === P256_SHA512)?.bytes(2);
  if (!commitment) throw new HandshakeError('no P256_SHA512 commitment');
  if (c.str(4) !== NEXT_PROTOCOL) throw new HandshakeError('unsupported next protocol');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const serverInit = message(T_SERVER_INIT, new Writer().int(1, 1).bytes(2, randomBytes(32)).int(3, P256_SHA512).msg(4, publicKey(ecdh)).done());
  await io.write(serverInit);
  const finished = await io.next(timeoutMs);
  if (!sha512(finished).equals(commitment)) throw new HandshakeError('client finish does not match its commitment');
  const f = unwrap(finished, T_CLIENT_FINISH);
  return derive(ecdh, peerKey(f.msg(1)), clientInit, serverInit, false);
}
