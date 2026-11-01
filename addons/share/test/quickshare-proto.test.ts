import { describe, expect, it } from 'vitest';
import { Fields, Writer } from '../src/quickshare/proto.ts';
import {
  DEVICE_LAPTOP, S_INTRODUCTION, S_RESPONSE, endpointInfo, introduction, mimeOf, parseEndpointInfo, parseSharing, randomId, sharingResponse,
} from '../src/quickshare/frames.ts';
import { D2D_SALT, SECURE_MESSAGE_SALT, pinOf } from '../src/quickshare/ukey2.ts';
import { SecureChannel, SecureError } from '../src/quickshare/secure.ts';
import { SERVICE, addressesFor, answerFor, decode, encode, instanceLabel } from '../src/quickshare/mdns.ts';

describe('protobuf', () => {
  it('round-trips varints, negatives, bytes and nested messages', () => {
    const b = new Writer().int(1, 300).int(2, -1).int(3, 1n << 62n).str(4, 'héllo').msg(5, new Writer().int(1, 7)).int(6, true).done();
    const f = new Fields(b);
    expect(f.int(1)).toBe(300);
    expect(f.int(2)).toBe(-1);
    expect(f.big(3)).toBe(1n << 62n);
    expect(f.str(4)).toBe('héllo');
    expect(f.msg(5)?.int(1)).toBe(7);
    expect(f.int(6)).toBe(1);
  });
});

describe('frames', () => {
  it('carries a name and device type in the endpoint info', () => {
    const info = endpointInfo('Hafij PC', DEVICE_LAPTOP);
    expect(parseEndpointInfo(info)).toEqual({ name: 'Hafij PC', deviceType: DEVICE_LAPTOP });
    expect(parseEndpointInfo(endpointInfo('x'.repeat(400), DEVICE_LAPTOP)).name).toHaveLength(150);
  });

  it('round-trips an introduction and a response', () => {
    const file = { name: 'a.jpg', size: 12, payloadId: randomId(), ...mimeOf('a.jpg') };
    const text = { title: 'hi', size: 2, payloadId: randomId(), kind: 1 };
    const s = parseSharing(introduction([file], [text]));
    expect(s.type).toBe(S_INTRODUCTION);
    expect(s.files).toEqual([file]);
    expect(s.texts).toEqual([text]);
    expect(parseSharing(sharingResponse(1))).toEqual({ type: S_RESPONSE, files: [], texts: [], status: 1 });
  });
});

describe('ukey2', () => {
  it('uses the published salts', () => {
    expect(D2D_SALT.toString('hex').toUpperCase()).toBe('82AA55A0D397F88346CA1CEE8D3909B95F13FA7DEB1D4AB38376B8256DA85510');
    expect(SECURE_MESSAGE_SALT.toString('hex').toUpperCase()).toBe('BF9D2A53C63616D75DB0A7165B91C1EF73E537F2427405FA23610A4BE657642E');
  });

  it('makes a 4-digit code', () => {
    expect(pinOf(Buffer.alloc(32, 0xff))).toMatch(/^\d{4}$/);
  });
});

describe('secure channel', () => {
  const k = (n: number): Buffer => Buffer.alloc(32, n);
  const a = new SecureChannel({ encryptKey: k(1), sendHmacKey: k(2), decryptKey: k(3), receiveHmacKey: k(4), pin: '0000' });
  const b = new SecureChannel({ encryptKey: k(3), sendHmacKey: k(4), decryptKey: k(1), receiveHmacKey: k(2), pin: '0000' });

  it('opens what the other side sealed, in order', () => {
    expect(b.open(a.seal(Buffer.from('one'))).toString()).toBe('one');
    expect(a.open(b.seal(Buffer.from('two'))).toString()).toBe('two');
    expect(b.open(a.seal(Buffer.from('three'))).toString()).toBe('three');
  });

  it('refuses a tampered or replayed message', () => {
    const m = a.seal(Buffer.from('four'));
    const bad = Buffer.from(m);
    bad[bad.length - 1]! ^= 1;
    expect(() => b.open(bad)).toThrow(SecureError);
    expect(b.open(m).toString()).toBe('four');
    expect(() => b.open(m)).toThrow(SecureError);
  });
});

describe('mdns', () => {
  it('names the instance like Quick Share', () => {
    const raw = Buffer.from(instanceLabel('AB12'), 'base64url');
    expect([...raw]).toEqual([0x23, 0x41, 0x42, 0x31, 0x32, 0xfc, 0x9f, 0x5e, 0, 0]);
  });

  it('answers a PTR query with SRV, TXT and A records that decode back', () => {
    const me = { instance: instanceLabel('AB12'), host: 'meshdrop-qs-ab12.local', port: 4321, info: endpointInfo('PC', DEVICE_LAPTOP) };
    const q = decode(encode({ response: false, questions: [{ name: SERVICE, type: 12, unicast: false }] }));
    const r = answerFor(q, me, ['192.168.1.5']);
    expect(r).not.toBeNull();
    const p = decode(encode({ response: true, ...r! }));
    expect(p.response).toBe(true);
    const srv = p.records.find((x) => x.type === 33);
    const txt = p.records.find((x) => x.type === 16);
    const a = p.records.find((x) => x.type === 1);
    expect(srv && srv.type === 33 && srv.port).toBe(4321);
    expect(a && a.type === 1 && a.address).toBe('192.168.1.5');
    const n = txt && txt.type === 16 ? txt.entries[0]!.toString() : '';
    expect(parseEndpointInfo(Buffer.from(n.slice(2), 'base64url')).name).toBe('PC');
    expect(answerFor(decode(encode({ response: false, questions: [{ name: '_other._tcp.local', type: 12, unicast: false }] })), me, [])).toBeNull();
  });

  it('picks the address on the asker\'s subnet', () => {
    const all = [{ address: '10.0.0.2', netmask: '255.0.0.0' }, { address: '192.168.1.5', netmask: '255.255.255.0' }];
    expect(addressesFor('192.168.1.77', all)).toEqual(['192.168.1.5']);
    expect(addressesFor('172.16.0.1', all)).toEqual(['10.0.0.2', '192.168.1.5']);
  });

  it('does not loop on a compression pointer to itself', () => {
    const b = Buffer.alloc(16);
    b.writeUInt16BE(1, 4);
    b[12] = 0xc0;
    b[13] = 12;
    expect(() => decode(b)).toThrow();
  });
});
