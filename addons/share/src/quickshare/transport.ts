// Quick Share (Android's share-to-nearby-device) as a MeshDrop add-on transport: advertises this PC on
// the LAN, turns incoming shares into offers the user accepts or declines, and sends to phones whose
// Quick Share is open and visible.
import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { AddonHost, AddonOffer, AddonPeer, AddonTransport } from '@meshdrop/core/src/addons.ts';
import { DEVICE_LAPTOP, DEVICE_PHONE, DEVICE_TABLET, endpointInfo } from './frames.ts';
import { QuickShareMdns } from './mdns.ts';
import { receive, type Incoming } from './receiver.ts';
import { sendTo } from './sender.ts';

/** How long an offer waits for the user before it is declined. */
const OFFER_MS = 5 * 60_000;
/** Incoming connections handled at once; more are dropped. */
const MAX_CONNECTIONS = 4;

interface Waiting {
  offer: AddonOffer;
  answer: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

function newEndpointId(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 4 }, () => abc[randomInt(abc.length)]).join('');
}

function deviceTypeName(t: number): string | undefined {
  if (t === DEVICE_PHONE || t === DEVICE_TABLET) return 'mobile';
  if (t === DEVICE_LAPTOP) return 'desktop';
  return undefined;
}

export class QuickShareTransport implements AddonTransport {
  readonly id = 'quickshare';
  readonly label = 'Quick Share';
  #host: AddonHost | null = null;
  #server: Server | null = null;
  #mdns: QuickShareMdns | null = null;
  readonly #sockets = new Set<Socket>();
  readonly #offers = new Map<string, Waiting>();

  async start(host: AddonHost): Promise<void> {
    this.#host = host;
    const server = createServer((sock) => void this.#incoming(sock));
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (e) => host.log(`quickshare: ${e.message}`));
    this.#server = server;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const mdns = new QuickShareMdns({
      endpointId: newEndpointId(),
      info: endpointInfo(host.alias, host.deviceType === 'mobile' ? DEVICE_PHONE : DEVICE_LAPTOP),
      port,
      onChange: () => host.emit({ type: 'peers' }),
      log: host.log,
    });
    try {
      await mdns.start();
    } catch (e) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.#server = null;
      throw e;
    }
    this.#mdns = mdns;
  }

  async stop(): Promise<void> {
    for (const id of [...this.#offers.keys()]) this.#answer(id, false);
    for (const s of this.#sockets) s.destroy();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.#mdns?.stop();
    this.#mdns = null;
    this.#host = null;
  }

  peers(): AddonPeer[] {
    const now = Date.now();
    return (this.#mdns?.peers() ?? []).map((p) => {
      const deviceType = deviceTypeName(p.deviceType);
      return { id: p.id, alias: p.alias, lastSeen: now, ...(deviceType ? { deviceType } : {}) };
    });
  }

  async send(peerId: string, items: { paths: string[]; text?: string }, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const host = this.#host;
    const peer = this.#mdns?.peers().find((p) => p.id === peerId);
    if (!host || !peer) throw new Error('That device is not visible right now. Open Quick Share on it and try again.');
    await sendTo(peer.address, peer.port, items, {
      alias: host.alias,
      deviceType: host.deviceType === 'mobile' ? DEVICE_PHONE : DEVICE_LAPTOP,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  pending(): AddonOffer[] {
    return [...this.#offers.values()].map((w) => w.offer);
  }

  has(offerId: string): boolean {
    return this.#offers.has(offerId);
  }

  async accept(offerId: string): Promise<void> {
    if (!this.#answer(offerId, true)) throw new Error('no such offer');
  }

  async reject(offerId: string): Promise<void> {
    if (!this.#answer(offerId, false)) throw new Error('no such offer');
  }

  /** Settles a waiting offer; false when there was none. */
  #answer(offerId: string, ok: boolean): boolean {
    const w = this.#offers.get(offerId);
    if (!w) return false;
    this.#offers.delete(offerId);
    clearTimeout(w.timer);
    w.answer(ok);
    return true;
  }

  async #incoming(sock: Socket): Promise<void> {
    const host = this.#host;
    if (!host) {
      sock.destroy();
      return;
    }
    this.#sockets.add(sock);
    let offerId: string | null = null;
    let alias = 'Quick Share device';
    const decide = (o: Incoming): Promise<boolean> => {
      if (!host.accepting() || this.#host !== host) return Promise.resolve(false);
      const id = randomUUID();
      offerId = id;
      alias = o.alias;
      const offer: AddonOffer = {
        id,
        alias: o.alias,
        files: o.files.map((f) => ({ name: f.name, size: f.size, type: f.mime })),
        pin: o.pin,
        ...(o.texts.length > 0 ? { text: o.texts.map((t) => t.title).join('\n') } : {}),
      };
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => this.#answer(id, false), OFFER_MS);
        this.#offers.set(id, { offer, answer: resolve, timer });
        host.emit({ type: 'offer', ...offer });
      });
    };
    try {
      const got = await receive(sock, { partialDir: join(host.partialDir, randomUUID()), decide, land: host.land });
      if (got && offerId) host.emit({ type: 'received', id: offerId, alias: got.alias, files: got.files, ...(got.text !== undefined ? { text: got.text } : {}) });
      else if (offerId) host.emit({ type: 'rejected', id: offerId });
    } catch (e) {
      host.log(`quickshare: ${alias}: ${e instanceof Error ? e.message : String(e)}`);
      if (offerId) {
        // still waiting for the user: the sender gave up, so the offer goes away
        if (this.#offers.has(offerId)) this.#answer(offerId, false);
        host.emit({ type: 'rejected', id: offerId });
      }
    } finally {
      this.#sockets.delete(sock);
      sock.destroy();
    }
  }
}
