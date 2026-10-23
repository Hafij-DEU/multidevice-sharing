// LAN propagation of the membership list (protocol v1): while the hub is unreachable, a device
// that sees a peer advertising a newer list version (`mv` in GET info) fetches that peer's list
// and runs it through MembershipStore.accept, which only takes lists signed by the mesh root.
import type { Identity } from '../identity.ts';
import { connectPinned, pinnedRequest } from '../tls.ts';
import type { MembershipStore } from './members.ts';
import type { SignedMembership } from './membership.ts';

const TIMEOUT_MS = 5000;

export interface MeshPeer { deviceId: string; host: string; port: number }

async function get(id: Identity, peer: MeshPeer, path: string): Promise<{ status: number; json?: unknown }> {
  const sock = await connectPinned(peer.host, peer.port, id, peer.deviceId, { timeoutMs: TIMEOUT_MS });
  return pinnedRequest(sock, 'GET', path, undefined, {}, { timeoutMs: TIMEOUT_MS });
}

/**
 * Pulls `peer`'s membership list if it advertises a newer version. 'none': the peer has no newer
 * list (or none at all). Throws if the peer's list does not verify against our anchor.
 */
export async function pullMembership(id: Identity, store: MembershipStore, peer: MeshPeer): Promise<'updated' | 'same' | 'stale' | 'none'> {
  const info = await get(id, peer, '/mesh/v1/info');
  const mv = (info.json as { mv?: unknown } | undefined)?.mv;
  if (typeof mv !== 'number' || !Number.isSafeInteger(mv)) return 'none';
  if (mv <= store.list().version) return 'same';
  const res = await get(id, peer, '/mesh/v1/membership');
  if (res.status !== 200 || !res.json) return 'none';
  return store.accept(res.json as SignedMembership);
}
