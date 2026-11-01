// Quick Share's LAN discovery: a small mDNS responder (so phones find this PC) and browser (so this PC
// finds phones whose Quick Share is open). It shares port 5353 with avahi through SO_REUSEADDR.
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { parseEndpointInfo } from './frames.ts';

export const SERVICE = '_FC9F5ED42C8A._tcp.local';
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const T_A = 1;
const T_PTR = 12;
const T_TXT = 16;
const T_SRV = 33;
const T_ANY = 255;
const TTL = 120;
const FLUSH = 0x8000;
const QUERY_EVERY_MS = 15_000;

// ---- packet codec -----------------------------------------------------------------------------------------

export type Rec =
  | { type: typeof T_PTR; name: string; ttl: number; target: string }
  | { type: typeof T_SRV; name: string; ttl: number; port: number; target: string }
  | { type: typeof T_TXT; name: string; ttl: number; entries: Buffer[] }
  | { type: typeof T_A; name: string; ttl: number; address: string };

export interface Question {
  name: string;
  type: number;
  /** The QU bit: the asker wants a unicast reply. */
  unicast: boolean;
}

export interface Packet {
  id: number;
  response: boolean;
  questions: Question[];
  /** Answers, authority and additional records together. */
  records: Rec[];
}

function readName(buf: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let off = start;
  let end = -1;
  let hops = 0;
  let len = 0;
  for (;;) {
    if (off >= buf.length) throw new Error('truncated name');
    const n = buf[off]!;
    if (n === 0) {
      if (end < 0) end = off + 1;
      break;
    }
    if ((n & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length || ++hops > 32) throw new Error('bad name pointer');
      if (end < 0) end = off + 2;
      off = ((n & 0x3f) << 8) | buf[off + 1]!;
      continue;
    }
    if ((n & 0xc0) !== 0 || off + 1 + n > buf.length) throw new Error('bad label');
    len += n + 1;
    if (len > 255) throw new Error('name too long');
    labels.push(buf.toString('utf8', off + 1, off + 1 + n));
    off += 1 + n;
  }
  return [labels.join('.'), end];
}

export function decode(buf: Buffer): Packet {
  if (buf.length < 12) throw new Error('short packet');
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const p: Packet = { id: buf.readUInt16BE(0), response: (flags & 0x8000) !== 0, questions: [], records: [] };
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const [name, next] = readName(buf, off);
    if (next + 4 > buf.length) throw new Error('truncated question');
    p.questions.push({ name, type: buf.readUInt16BE(next), unicast: (buf.readUInt16BE(next + 2) & 0x8000) !== 0 });
    off = next + 4;
  }
  for (let i = 0; i < rr; i++) {
    const [name, next] = readName(buf, off);
    if (next + 10 > buf.length) throw new Error('truncated record');
    const type = buf.readUInt16BE(next);
    const ttl = buf.readUInt32BE(next + 4);
    const dlen = buf.readUInt16BE(next + 8);
    const data = next + 10;
    if (data + dlen > buf.length) throw new Error('truncated record data');
    if (type === T_PTR) p.records.push({ type, name, ttl, target: readName(buf, data)[0] });
    else if (type === T_SRV && dlen >= 7) p.records.push({ type, name, ttl, port: buf.readUInt16BE(data + 4), target: readName(buf, data + 6)[0] });
    else if (type === T_A && dlen === 4) p.records.push({ type, name, ttl, address: [...buf.subarray(data, data + 4)].join('.') });
    else if (type === T_TXT) {
      const entries: Buffer[] = [];
      for (let j = data; j < data + dlen; ) {
        const n = buf[j]!;
        if (j + 1 + n > data + dlen) break;
        entries.push(buf.subarray(j + 1, j + 1 + n));
        j += 1 + n;
      }
      p.records.push({ type, name, ttl, entries });
    }
    off = data + dlen;
  }
  return p;
}

function name(n: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of n.split('.')) {
    const b = Buffer.from(label, 'utf8');
    if (b.length === 0 || b.length > 63) throw new Error('bad label');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function record(r: Rec, flush: boolean): Buffer {
  let data: Buffer;
  if (r.type === T_PTR) data = name(r.target);
  else if (r.type === T_SRV) data = Buffer.concat([u16(0), u16(0), u16(r.port), name(r.target)]);
  else if (r.type === T_A) data = Buffer.from(r.address.split('.').map(Number));
  else data = Buffer.concat(r.entries.flatMap((e) => [Buffer.from([e.length]), e]));
  const head = Buffer.alloc(10);
  head.writeUInt16BE(r.type, 0);
  head.writeUInt16BE(1 | (flush ? FLUSH : 0), 2);
  head.writeUInt32BE(r.ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(r.name), head, data]);
}

export function encode(p: { id?: number; response: boolean; questions?: Question[]; answers?: Rec[]; additional?: Rec[]; legacy?: boolean }): Buffer {
  const qs = p.questions ?? [];
  const an = p.answers ?? [];
  const ar = p.additional ?? [];
  const head = Buffer.alloc(12);
  head.writeUInt16BE(p.id ?? 0, 0);
  head.writeUInt16BE(p.response ? 0x8400 : 0, 2); // response + authoritative
  head.writeUInt16BE(qs.length, 4);
  head.writeUInt16BE(an.length, 6);
  head.writeUInt16BE(ar.length, 10);
  const flush = (r: Rec): boolean => !p.legacy && r.type !== T_PTR; // shared PTR records never flush
  return Buffer.concat([
    head,
    ...qs.map((q) => Buffer.concat([name(q.name), u16(q.type), u16(1 | (q.unicast ? 0x8000 : 0))])),
    ...an.map((r) => record(r, flush(r))),
    ...ar.map((r) => record(r, flush(r))),
  ]);
}

// ---- naming ------------------------------------------------------------------------------------------------

/** The service instance label: 0x23, the 4-character endpoint id, the Nearby Sharing service id hash, 2 zero bytes. */
export function instanceLabel(endpointId: string): string {
  return Buffer.concat([Buffer.from([0x23]), Buffer.from(endpointId, 'ascii'), Buffer.from([0xfc, 0x9f, 0x5e, 0, 0])]).toString('base64url');
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

interface Iface {
  address: string;
  netmask: string;
}

function ipv4s(): Iface[] {
  return Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ address: a.address, netmask: a.netmask })));
}

const num = (ip: string): number => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);

/** Our addresses the asker can reach: the one on its subnet, or all of them. */
export function addressesFor(from: string | undefined, all: Iface[]): string[] {
  if (from) {
    const hit = all.find((a) => ((num(a.address) & num(a.netmask)) >>> 0) === ((num(from) & num(a.netmask)) >>> 0));
    if (hit) return [hit.address];
  }
  return all.map((a) => a.address);
}

export interface Me {
  instance: string;
  host: string;
  port: number;
  /** The TXT `n=` value: base64url endpoint info. */
  info: Buffer;
}

/** What to answer to a query, or null when it is not about us. */
export function answerFor(q: Packet, me: Me, addresses: string[], ttl = TTL): { answers: Rec[]; additional: Rec[] } | null {
  const full = `${me.instance}.${SERVICE}`;
  const ptr: Rec = { type: T_PTR, name: SERVICE, ttl, target: full };
  const srv: Rec = { type: T_SRV, name: full, ttl, port: me.port, target: me.host };
  const txt: Rec = { type: T_TXT, name: full, ttl, entries: [Buffer.from(`n=${me.info.toString('base64url')}`)] };
  const a: Rec[] = addresses.map((address) => ({ type: T_A, name: me.host, ttl, address }));
  const answers: Rec[] = [];
  const additional: Rec[] = [];
  for (const x of q.questions) {
    const any = x.type === T_ANY;
    if (same(x.name, SERVICE) && (x.type === T_PTR || any)) {
      answers.push(ptr);
      additional.push(srv, txt, ...a);
    } else if (same(x.name, full)) {
      if (x.type === T_SRV || any) answers.push(srv);
      if (x.type === T_TXT || any) answers.push(txt);
      if (x.type === T_SRV || any) additional.push(...a);
    } else if (same(x.name, me.host) && (x.type === T_A || any)) answers.push(...a);
  }
  if (answers.length === 0) return null;
  return { answers, additional: additional.filter((r) => !answers.includes(r)) };
}

// ---- the responder and browser ----------------------------------------------------------------------------

export interface Found {
  /** The instance label, unique per advertising device. */
  id: string;
  alias: string;
  deviceType: number;
  address: string;
  port: number;
}

interface Entry {
  label: string;
  expires: number;
  port?: number;
  host?: string;
  from: string;
  info?: Buffer;
  asked: number;
}

export interface MdnsOptions {
  endpointId: string;
  info: Buffer;
  port: number;
  onChange: () => void;
  log?: (msg: string) => void;
}

export class QuickShareMdns {
  readonly #me: Me;
  readonly #opts: MdnsOptions;
  #sock: Socket | null = null;
  readonly #entries = new Map<string, Entry>();
  readonly #hosts = new Map<string, { address: string; expires: number }>();
  readonly #timers: NodeJS.Timeout[] = [];
  #last = '';

  constructor(opts: MdnsOptions) {
    this.#opts = opts;
    const label = instanceLabel(opts.endpointId);
    this.#me = { instance: label, host: `meshdrop-qs-${opts.endpointId.toLowerCase()}.local`, port: opts.port, info: opts.info };
  }

  async start(): Promise<void> {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (m, r) => this.#onMessage(m, r));
    sock.on('error', (e) => this.#opts.log?.(`mdns: ${e.message}`));
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(MDNS_PORT, () => {
        sock.off('error', reject);
        resolve();
      });
    });
    sock.setMulticastTTL(255);
    sock.setMulticastLoopback(true);
    this.#sock = sock;
    this.#join();
    this.#announce(TTL);
    this.#query();
    this.#timers.push(
      setTimeout(() => this.#announce(TTL), 1000),
      setTimeout(() => this.#query(), 1000),
      setTimeout(() => this.#query(), 3000),
      setInterval(() => {
        this.#join();
        this.#query();
      }, QUERY_EVERY_MS),
      setInterval(() => this.#sweep(), 5000),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.#timers.splice(0)) clearTimeout(t);
    const sock = this.#sock;
    if (!sock) return;
    this.#announce(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    this.#sock = null;
    await new Promise<void>((resolve) => sock.close(() => resolve()));
  }

  peers(): Found[] {
    const now = Date.now();
    const out: Found[] = [];
    for (const e of this.#entries.values()) {
      if (e.expires < now || e.port === undefined) continue;
      const host = e.host ? this.#hosts.get(e.host.toLowerCase()) : undefined;
      const who = parseEndpointInfo(e.info);
      out.push({ id: e.label, alias: (who.name || 'Quick Share device').slice(0, 64), deviceType: who.deviceType, address: host?.address ?? e.from, port: e.port });
    }
    return out;
  }

  #join(): void {
    for (const a of ipv4s()) {
      try {
        this.#sock?.addMembership(MDNS_GROUP, a.address);
      } catch {
        /* already a member there */
      }
    }
  }

  #send(b: Buffer, port = MDNS_PORT, address = MDNS_GROUP): void {
    this.#sock?.send(b, port, address, (e) => {
      if (e) this.#opts.log?.(`mdns send: ${e.message}`);
    });
  }

  #announce(ttl: number): void {
    const r = answerFor({ id: 0, response: false, questions: [{ name: SERVICE, type: T_PTR, unicast: false }], records: [] }, this.#me, addressesFor(undefined, ipv4s()), ttl);
    if (r) this.#send(encode({ response: true, ...r }));
  }

  #query(): void {
    this.#send(encode({ response: false, questions: [{ name: SERVICE, type: T_PTR, unicast: false }] }));
  }

  #onMessage(msg: Buffer, from: RemoteInfo): void {
    let p: Packet;
    try {
      p = decode(msg);
    } catch {
      return;
    }
    if (!p.response) {
      const r = answerFor(p, this.#me, addressesFor(from.address, ipv4s()));
      if (!r) return;
      if (from.port !== MDNS_PORT) {
        // a one-shot resolver: answer it directly, echoing its question, with short TTLs
        const short = (x: Rec): Rec => ({ ...x, ttl: Math.min(x.ttl, 10) });
        this.#send(encode({ id: p.id, response: true, questions: p.questions, answers: r.answers.map(short), additional: r.additional.map(short), legacy: true }), from.port, from.address);
      } else if (p.questions.some((q) => q.unicast)) this.#send(encode({ response: true, ...r }), from.port, from.address);
      else this.#send(encode({ response: true, ...r }));
      return;
    }
    this.#learn(p, from);
  }

  #learn(p: Packet, from: RemoteInfo): void {
    const now = Date.now();
    const suffix = `.${SERVICE}`.toLowerCase();
    const labelOf = (full: string): string | null => {
      if (!full.toLowerCase().endsWith(suffix)) return null;
      const l = full.slice(0, -suffix.length);
      return /^[A-Za-z0-9_-]{1,64}$/.test(l) && l !== this.#me.instance ? l : null;
    };
    const entry = (label: string): Entry => {
      let e = this.#entries.get(label);
      if (!e) {
        e = { label, expires: now + TTL * 1000, from: from.address, asked: 0 };
        this.#entries.set(label, e);
      }
      return e;
    };
    for (const r of p.records) {
      if (r.type === T_A) {
        if (r.ttl === 0) this.#hosts.delete(r.name.toLowerCase());
        else this.#hosts.set(r.name.toLowerCase(), { address: r.address, expires: now + r.ttl * 1000 });
        continue;
      }
      const label = labelOf(r.type === T_PTR ? r.target : r.name);
      if (!label) continue;
      if (r.type === T_PTR && !same(r.name, SERVICE)) continue;
      if (r.ttl === 0) {
        this.#entries.delete(label);
        continue;
      }
      const e = entry(label);
      e.expires = Math.max(e.expires, now + r.ttl * 1000);
      e.from = from.address;
      if (r.type === T_SRV) {
        e.port = r.port;
        e.host = r.target;
      } else if (r.type === T_TXT) {
        const n = r.entries.map((b) => b.toString('latin1')).find((s) => s.startsWith('n='));
        if (n) e.info = Buffer.from(n.slice(2), 'base64url');
      }
    }
    for (const e of this.#entries.values()) {
      if ((e.port === undefined || e.info === undefined) && now - e.asked > 1000) {
        e.asked = now;
        const full = `${e.label}.${SERVICE}`;
        this.#send(encode({ response: false, questions: [{ name: full, type: T_SRV, unicast: false }, { name: full, type: T_TXT, unicast: false }] }));
      }
    }
    this.#changed();
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.#entries) if (e.expires < now) this.#entries.delete(k);
    for (const [k, h] of this.#hosts) if (h.expires < now) this.#hosts.delete(k);
    this.#changed();
  }

  #changed(): void {
    const key = JSON.stringify(this.peers().map((p) => [p.id, p.alias, p.address, p.port]).sort());
    if (key === this.#last) return;
    this.#last = key;
    this.#opts.onChange();
  }
}
