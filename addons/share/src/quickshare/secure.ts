// The encrypted channel after UKEY2: every frame is a DeviceToDeviceMessage (frame + sequence number),
// AES-256-CBC encrypted and HMAC-SHA256 signed inside a SecureMessage.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Fields, Writer } from './proto.ts';
import type { Keys } from './ukey2.ts';

const HMAC_SHA256 = 1;
const AES_256_CBC = 2;
/** GcmMetadata { type: DEVICE_TO_DEVICE_MESSAGE (13), version: 1 } */
const METADATA = Buffer.from([0x08, 0x0d, 0x10, 0x01]);

export class SecureError extends Error {}

export class SecureChannel {
  readonly #keys: Keys;
  #sent = 0;
  #received = 0;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

  seal(frame: Buffer): Buffer {
    const d2d = new Writer().bytes(1, frame).int(2, ++this.#sent).done();
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', this.#keys.encryptKey, iv);
    const body = Buffer.concat([c.update(d2d), c.final()]);
    const header = new Writer().int(1, HMAC_SHA256).int(2, AES_256_CBC).bytes(5, iv).bytes(6, METADATA);
    const hb = new Writer().msg(1, header).bytes(2, body).done();
    return new Writer().bytes(1, hb).bytes(2, createHmac('sha256', this.#keys.sendHmacKey).update(hb).digest()).done();
  }

  open(msg: Buffer): Buffer {
    const sm = new Fields(msg);
    const hb = sm.bytes(1);
    const sig = sm.bytes(2);
    if (!hb || !sig) throw new SecureError('not a secure message');
    const want = createHmac('sha256', this.#keys.receiveHmacKey).update(hb).digest();
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) throw new SecureError('bad signature');
    const parts = new Fields(hb);
    const header = parts.msg(1);
    const body = parts.bytes(2);
    const iv = header?.bytes(5);
    if (!header || !body || !iv || iv.length !== 16) throw new SecureError('bad secure message header');
    if (header.int(1) !== HMAC_SHA256 || header.int(2) !== AES_256_CBC) throw new SecureError('unsupported secure message scheme');
    let d2d: Buffer;
    try {
      const d = createDecipheriv('aes-256-cbc', this.#keys.decryptKey, iv);
      d2d = Buffer.concat([d.update(body), d.final()]);
    } catch {
      throw new SecureError('cannot decrypt');
    }
    const m = new Fields(d2d);
    if (m.int(2) !== ++this.#received) throw new SecureError('out-of-order message');
    const frame = m.bytes(1);
    if (!frame) throw new SecureError('empty message');
    return frame;
  }
}
