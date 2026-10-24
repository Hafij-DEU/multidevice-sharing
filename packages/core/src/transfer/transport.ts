// How the sender reaches a receiver's API: directly over pinned TLS on the LAN, or through the hub
// as signed relay envelopes (live relay, or held on the hub for an offline target). The sender's
// session logic (send.ts) is the same over all of them.
import { randomBytes, type KeyObject } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { HubClient } from '../hub/client.ts';
import type { Identity } from '../identity.ts';
import { openEnvelope, sealEnvelope, type Envelope } from '../mesh/envelope.ts';
import { DEFAULT_CONNECT_TIMEOUT_MS, connectPinned, pinnedRequest, type PinnedResponse } from '../tls.ts';

export interface TransportRequestOptions { timeoutMs: number; signal?: AbortSignal }

export interface Transport {
  readonly kind: 'lan' | 'relay' | 'held';
  request(
    method: string,
    path: string,
    body: Buffer | Readable | undefined,
    headers: Record<string, string | number>,
    opts: TransportRequestOptions,
  ): Promise<PinnedResponse>;
}

/** No way to reach the target on this transport (non-transient: retrying cannot help). */
export class NoRouteError extends Error {
  constructor(message = 'no route to the device') {
    super(message);
    this.name = 'NoRouteError';
  }
}

/** The relay answered with something that is not a valid answer for this request. */
export class RelayReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayReplyError';
  }
}

export interface LanTarget { deviceId: string; host?: string; port?: number }

/** One request per pinned mutual-TLS connection to the target's LAN address (protocol v1 M1 path). */
export class LanTransport implements Transport {
  readonly kind = 'lan' as const;
  readonly #id: Identity;
  readonly #t: LanTarget;
  readonly #connectTimeoutMs: number;

  constructor(id: Identity, target: LanTarget, connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS) {
    this.#id = id;
    this.#t = target;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  async request(method: string, path: string, body: Buffer | Readable | undefined, headers: Record<string, string | number>, opts: TransportRequestOptions): Promise<PinnedResponse> {
    const { host, port, deviceId } = this.#t;
    if (!host || !port) throw new NoRouteError();
    const sock = await connectPinned(host, port, this.#id, deviceId, { timeoutMs: this.#connectTimeoutMs });
    return pinnedRequest(sock, method, path, body, headers, opts);
  }
}

const HUB_ERRORS = new Set([400, 500, 503, 504, 507]);

/**
 * Requests as signed envelopes through the hub link. In 'held' mode the offer carries `holdBytes`,
 * so an offline target's session is stored on the hub; the hub's synthetic 2xx replies are then
 * accepted from the hub (its own signature) as well as from the target.
 */
export class RelayTransport implements Transport {
  readonly #mode: 'relay' | 'held';
  /** A 'relay' transport whose session turned out to be held on the hub (an interrupted held upload). */
  #latched = false;
  get kind(): 'relay' | 'held' {
    return this.#latched ? 'held' : this.#mode;
  }
  readonly #id: Identity;
  readonly #hub: HubClient;
  readonly #to: string;
  readonly #pubOf: (id: string) => KeyObject | undefined;
  readonly #holdBytes: number | undefined;

  constructor(id: Identity, hub: HubClient, to: string, pubOf: (id: string) => KeyObject | undefined, mode: 'relay' | 'held', holdBytes?: number) {
    if (mode === 'held' && (holdBytes === undefined || !Number.isSafeInteger(holdBytes) || holdBytes < 0)) throw new TypeError('held mode needs holdBytes');
    this.#mode = mode;
    this.#id = id;
    this.#hub = hub;
    this.#to = to;
    this.#pubOf = pubOf;
    this.#holdBytes = holdBytes;
  }

  async request(method: string, path: string, body: Buffer | Readable | undefined, headers: Record<string, string | number>, opts: TransportRequestOptions): Promise<PinnedResponse> {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : await collect(body);
    const h: Parameters<typeof sealEnvelope>[0] = {
      v: 1, kind: 'req', id: randomBytes(16).toString('base64url'), from: this.#id.deviceId, to: this.#to, method, path,
    };
    const ct = headers['content-type'];
    if (typeof ct === 'string') h.contentType = ct;
    if (this.kind === 'held' && method === 'POST' && path === '/mesh/v1/offer') h.holdBytes = this.#holdBytes!;
    const res = await this.#hub.request(sealEnvelope(h, buf, this.#id.privateKey), opts.timeoutMs, opts.signal);
    return this.#check(res, h.id, method === 'POST' && path === '/mesh/v1/offer');
  }

  #check(res: Envelope, id: string, isOffer: boolean): PinnedResponse {
    // The hub this link is on: the main hub, or a relay hub (M9) while the main one is away.
    const hubId = this.#hub.linkedHub ?? this.#hub.hubDeviceId;
    try {
      openEnvelope(res, this.#pubOf);
    } catch {
      throw new RelayReplyError('relay reply does not verify');
    }
    const r = res.header;
    if (r.kind !== 'res' || r.id !== id || r.to !== this.#id.deviceId) throw new RelayReplyError('relay reply for another request');
    const status = r.status!;
    if (r.from !== this.#to) {
      // The hub may only answer for the target with its own errors, or (held mode) held replies.
      let allowed = r.from === hubId && (HUB_ERRORS.has(status) || (this.kind === 'held' && (status >= 200 && status < 300 || status === 403 || status === 409)));
      if (!allowed && r.from === hubId && this.#mode === 'relay' && isOffer && status === 200 && isHeldBody(res.body)) {
        // Resuming an upload the hub already holds for an offline target: continue it as held.
        this.#latched = true;
        allowed = true;
      }
      if (!allowed) throw new RelayReplyError('relay reply from an unexpected device');
    }
    const out: PinnedResponse = { status, body: res.body };
    if (r.contentType && /^application\/json\s*(;|$)/i.test(r.contentType) && res.body.length > 0) {
      try {
        out.json = JSON.parse(res.body.toString('utf8'));
      } catch {
        throw new RelayReplyError('invalid JSON in application/json response');
      }
    }
    return out;
  }
}

function isHeldBody(b: Buffer): boolean {
  try {
    return (JSON.parse(b.toString('utf8')) as { held?: unknown }).held === true;
  } catch {
    return false;
  }
}

async function collect(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}
