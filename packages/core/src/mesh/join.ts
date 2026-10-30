// Redeeming a QR invite (protocol v1).
//
// LAN: the new device posts {deviceId, alias, cert, proof} to the inviter's `POST /mesh/v1/join`
// over pinned TLS (the inviter's id is in the invite). The inviter checks the proof, then:
//   - it is the hub, or its hub link is up: the hub signs the device in → {status:'member', anchorPem, membership}
//   - otherwise: it trusts the device locally and queues the join for its next hub link
//     → {status:'provisional', anchorPem, inviterKeyPem}; the device later calls completeJoin().
// Hub: the new device's first message on /mesh/v1/hub is {t:'join', ...} instead of {t:'auth'}.
// Either way the joining device only stores the mesh once the anchor matches the invite's mesh id
// and the signed list verifies and contains it.
import { X509Certificate, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import type { HubClient } from '../hub/client.ts';
import { HUB_AUTH_DOMAIN, isAlias, type HubServer } from '../hub/server.ts';
import { deviceIdOf, type Identity } from '../identity.ts';
import { connectPinned, pinnedRequest } from '../tls.ts';
import { TrustStore, writeFileAtomic } from '../trust.ts';
import { signDomain, spkiSha256, verifyDomain } from './canonical.ts';
import { InviteBook, joinProof, parseInviteUri, type Invite } from './invite.ts';
import { MembershipStore } from './members.ts';
import { parseAnchor, verifySigned, type SignedMembership } from './membership.ts';

const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PENDING_FILE = 'mesh-pending.json';
const JOIN_TIMEOUT_MS = 15_000;

class JoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinError';
  }
}

/** `cert`: the new device's certificate (base64 DER): the hub checks that it binds deviceId to publicKeyPem. */
interface NewMember { deviceId: string; alias: string; publicKeyPem: string; cert: string }

export interface JoinHandlerOptions {
  id: Identity;
  invites: InviteBook;
  /** This device's mesh state (null if it is not in a mesh: it cannot invite). */
  members: () => MembershipStore | null;
  /** Set on the hub device: it signs new members in itself. */
  hub?: HubServer;
  /** Set on other devices: their link to the hub. */
  hubClient?: () => HubClient | null;
  /** Where a provisionally admitted device is trusted until the hub signs it in. */
  manualTrust: TrustStore;
}

const spkiPemOf = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }) as string;

/** The inviter side of `POST /mesh/v1/join`. */
export function createJoinHandler(o: JoinHandlerOptions): (peer: string, body: unknown) => Promise<{ status: number; body: object }> {
  const queued = new Map<string, NewMember>();
  let listening: HubClient | null = null;

  const flush = async (hc: HubClient) => {
    for (const nm of [...queued.values()]) {
      try {
        await hc.requestJoin(nm);
        queued.delete(nm.deviceId);
        o.manualTrust.remove(nm.deviceId); // the mesh list covers it now
      } catch {
        /* still offline or refused: keep it for the next link */
      }
    }
  };

  return async (peer, body) => {
    const b = body as Record<string, unknown>;
    if (typeof b !== 'object' || b === null || b.deviceId !== peer || !isAlias(b.alias) || typeof b.proof !== 'string') {
      return { status: 400, body: { error: 'bad-request' } };
    }
    if (typeof b.cert !== 'string' || !B64_RE.test(b.cert) || b.cert.length > 8192) return { status: 400, body: { error: 'bad-request' } };
    const der = Buffer.from(b.cert, 'base64');
    if (deviceIdOf(der) !== peer) return { status: 400, body: { error: 'bad-request' } };
    let pub: KeyObject;
    try {
      pub = new X509Certificate(der).publicKey;
    } catch {
      return { status: 400, body: { error: 'bad-request' } };
    }
    const store = o.members();
    if (!store) return { status: 409, body: { error: 'no-mesh' } };
    const result = o.invites.consume(peer, o.id.deviceId, b.proof);
    if (result !== 'ok') return { status: 403, body: { error: result } };
    const nm: NewMember = { deviceId: peer, alias: b.alias, publicKeyPem: spkiPemOf(pub), cert: b.cert };
    const anchorPem = spkiPemOf(store.anchor);

    if (o.hub) {
      try {
        return { status: 200, body: { status: 'member', anchorPem, membership: await o.hub.addMember(nm) } };
      } catch {
        return { status: 403, body: { error: 'refused' } };
      }
    }
    const hc = o.hubClient?.() ?? null;
    if (hc?.state === 'online') {
      try {
        return { status: 200, body: { status: 'member', anchorPem, membership: await hc.requestJoin(nm) } };
      } catch (e) {
        if (e instanceof Error && (e.message === 'revoked' || e.message === 'refused')) return { status: 403, body: { error: e.message } };
        /* hub unreachable after all: fall back to provisional */
      }
    }
    o.manualTrust.add({ deviceId: nm.deviceId, alias: nm.alias, publicKeyPem: nm.publicKeyPem, addedAt: Date.now() });
    queued.set(nm.deviceId, nm);
    if (hc && listening !== hc) {
      listening = hc;
      hc.on('online', () => void flush(hc));
    }
    return { status: 200, body: { status: 'provisional', anchorPem, inviterKeyPem: spkiPemOf(o.id.publicKey) } };
  };
}

// ---- joining device -----------------------------------------------------------------------------

interface Pending { anchorPem: string; mesh: string; inviter: string; lan: Invite['lan'] }

/** Checks the anchor against the invite, verifies the list and that it lists `id`, then stores it. */
async function adopt(id: Identity, home: string, invite: { mesh: string }, anchorPem: unknown, s: unknown): Promise<MembershipStore> {
  if (typeof anchorPem !== 'string') throw new JoinError('no anchor in reply');
  let anchor: KeyObject;
  try {
    anchor = parseAnchor(anchorPem);
  } catch {
    throw new JoinError('invalid anchor');
  }
  if (spkiSha256(anchor) !== invite.mesh) throw new JoinError('anchor does not match the invite mesh id');
  const list = verifySigned(s as SignedMembership, anchor);
  if (!list.members.some((m) => m.deviceId === id.deviceId)) throw new JoinError('the signed list does not include this device');
  return MembershipStore.init(home, anchor, s as SignedMembership);
}

const certB64 = (id: Identity) => id.certDer.toString('base64');

/** Redeems an invite over the LAN. 'provisional': call completeJoin() once the hub has signed it in. */
export async function joinViaLan(id: Identity, uri: string, alias: string, home: string): Promise<'member' | 'provisional'> {
  const invite = parseInviteUri(uri);
  if (invite.lan.length === 0) throw new JoinError('the invite has no LAN address');
  const body = Buffer.from(JSON.stringify({ deviceId: id.deviceId, alias, cert: certB64(id), proof: joinProof(invite.secret, id.deviceId, invite.inviter) }));
  let lastErr: unknown = new JoinError('no LAN address answered');
  for (const a of invite.lan) {
    let res;
    try {
      const sock = await connectPinned(a.host, a.port, id, invite.inviter, { timeoutMs: 5000 });
      res = await pinnedRequest(sock, 'POST', '/mesh/v1/join', body, { 'content-type': 'application/json' }, { timeoutMs: JOIN_TIMEOUT_MS });
    } catch (e) {
      lastErr = e;
      continue;
    }
    const j = res.json as Record<string, unknown> | undefined;
    if (res.status !== 200 || !j) throw new JoinError(`join refused: ${typeof j?.error === 'string' ? j.error : res.status}`);
    if (j.status === 'member') {
      await adopt(id, home, invite, j.anchorPem, j.membership);
      return 'member';
    }
    if (j.status === 'provisional') {
      if (typeof j.anchorPem !== 'string' || spkiSha256(parseAnchor(j.anchorPem)) !== invite.mesh) throw new JoinError('anchor does not match the invite mesh id');
      if (typeof j.inviterKeyPem !== 'string') throw new JoinError('bad reply');
      const inviterKey = createPublicKey(j.inviterKeyPem);
      // The inviter is the device we pinned by id; keep trusting it until the mesh list arrives.
      new TrustStore(join(home, 'trust.json')).add({ deviceId: invite.inviter, alias: 'inviter', publicKeyPem: spkiPemOf(inviterKey), addedAt: Date.now() });
      const pending: Pending = { anchorPem: j.anchorPem, mesh: invite.mesh, inviter: invite.inviter, lan: invite.lan };
      writeFileAtomic(join(home, PENDING_FILE), JSON.stringify(pending));
      return 'provisional';
    }
    throw new JoinError('bad reply');
  }
  throw lastErr;
}

/** Finishes a provisional join: fetches the signed list from the inviter once it includes us. */
export async function completeJoin(id: Identity, home: string): Promise<MembershipStore> {
  let p: Pending;
  try {
    p = JSON.parse(readFileSync(join(home, PENDING_FILE), 'utf8')) as Pending;
  } catch {
    throw new JoinError('no pending join');
  }
  if (!DEVICE_ID_RE.test(p.inviter)) throw new JoinError('bad pending join');
  let lastErr: unknown = new JoinError('inviter unreachable');
  for (const a of p.lan) {
    try {
      const sock = await connectPinned(a.host, a.port, id, p.inviter, { timeoutMs: 5000 });
      const res = await pinnedRequest(sock, 'GET', '/mesh/v1/membership', undefined, {}, { timeoutMs: JOIN_TIMEOUT_MS });
      if (res.status !== 200) throw new JoinError(`membership unavailable (${res.status})`);
      const store = await adopt(id, home, p, p.anchorPem, res.json);
      rmSync(join(home, PENDING_FILE), { force: true });
      return store;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Redeems an invite through the hub's public URL (no LAN needed). `now` is never consulted. */
export async function joinViaHub(id: Identity, uri: string, alias: string, home: string, _opts: { now?: () => number } = {}): Promise<'member'> {
  const invite = parseInviteUri(uri);
  if (invite.hubUrls.length === 0) throw new JoinError('the invite has no hub URL');
  let lastErr: unknown = new JoinError('no hub URL answered');
  for (const url of invite.hubUrls) {
    try {
      await joinOnce(id, invite, alias, home, url);
      return 'member';
    } catch (e) {
      lastErr = e;
      if (e instanceof JoinError && /^join refused/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

function joinOnce(id: Identity, invite: Invite, alias: string, home: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { key: id.keyPem, cert: id.certPem, handshakeTimeout: JOIN_TIMEOUT_MS });
    const myNonce = randomBytes(32).toString('base64');
    let hubId = '';
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new JoinError('hub did not answer')), JOIN_TIMEOUT_MS);
    ws.on('error', (e) => finish(e));
    ws.on('close', () => finish(new JoinError('hub closed the link')));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return finish(new JoinError('bad hub message'));
      }
      if (m.t === 'hello') {
        if (typeof m.hub !== 'string' || !DEVICE_ID_RE.test(m.hub) || typeof m.nonce !== 'string') return finish(new JoinError('bad hello'));
        hubId = m.hub;
        ws.send(JSON.stringify({
          t: 'join', deviceId: id.deviceId, cert: certB64(id), alias, inviter: invite.inviter, nonce: myNonce, lan: [],
          proof: joinProof(invite.secret, id.deviceId, invite.inviter),
          sig: signDomain(HUB_AUTH_DOMAIN, `${hubId}\0${id.deviceId}\0${m.nonce}`, id.privateKey),
        }));
        return;
      }
      if (m.t === 'join-failed') return finish(new JoinError(`join refused: ${typeof m.error === 'string' ? m.error : 'refused'}`));
      if (m.t !== 'welcome') return;
      void (async () => {
        try {
          // Verify everything before storing: anchor = invite mesh, list signed and listing us,
          // and the hub that answered is the hub that list names.
          if (typeof m.anchorPem !== 'string' || spkiSha256(parseAnchor(m.anchorPem)) !== invite.mesh) throw new JoinError('anchor does not match the invite mesh id');
          const list = verifySigned(m.membership as SignedMembership, parseAnchor(m.anchorPem));
          const hub = list.members.find((x) => x.deviceId === list.hub.deviceId);
          if (list.hub.deviceId !== hubId || !hub) throw new JoinError('unexpected hub');
          if (typeof m.sig !== 'string' || !verifyDomain(HUB_AUTH_DOMAIN, `hub\0${id.deviceId}\0${myNonce}`, m.sig, createPublicKey(hub.publicKeyPem))) {
            throw new JoinError('hub signature does not verify');
          }
          await adopt(id, home, invite, m.anchorPem, m.membership);
          finish();
        } catch (e) {
          finish(e);
        }
      })();
    });
  });
}
