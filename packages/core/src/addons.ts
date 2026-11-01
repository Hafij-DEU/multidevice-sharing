// Add-on transports: other apps' share protocols (Quick Share, ...) that ship apart from MeshDrop and
// are loaded by the desktop app. An add-on finds its own peers, sends to them, and turns their
// incoming sends into offers the user accepts or declines. The engine shows add-on peers next to the
// LocalSend ones (untrusted, LAN only) and routes sends and offers back to the add-on.
import type { GuestFile } from './guest/uploads.ts';

/** The add-on contract version this MeshDrop speaks; an add-on built for another one is not loaded. */
export const ADDON_API_VERSION = 1;

/** A device an add-on can send to right now. `id` is unique within the add-on. */
export interface AddonPeer {
  id: string;
  alias: string;
  deviceType?: string;
  lastSeen: number;
}

/** An incoming send waiting for the user. `pin`: a code both screens show, when the protocol has one. */
export interface AddonOffer {
  id: string;
  alias: string;
  files: GuestFile[];
  text?: string;
  pin?: string;
}

export type AddonEvent =
  | { type: 'peers' }
  | ({ type: 'offer' } & AddonOffer)
  | { type: 'received'; id: string; alias: string; files: string[]; text?: string }
  | { type: 'rejected'; id: string };

/** What MeshDrop gives a transport when it starts. */
export interface AddonHost {
  alias: string;
  deviceType: string;
  /** A scratch folder only this transport uses; emptied before start. */
  partialDir: string;
  /** Moves a finished file into the inbox under `name` or the next free name; returns where it landed. */
  land(part: string, name: string): Promise<string>;
  /** False while the user has receiving turned off: decline new offers. */
  accepting(): boolean;
  emit(e: AddonEvent): void;
  log(msg: string): void;
}

export interface AddonTransport {
  /** Short stable id ("quickshare"); device ids are `${id}:${peer.id}`. */
  readonly id: string;
  /** What the UI calls it ("Quick Share"). */
  readonly label: string;
  start(host: AddonHost): Promise<void>;
  stop(): Promise<void>;
  peers(): AddonPeer[];
  /** Resolves once the peer has the files; rejects with a message for the user when it declined or failed. */
  send(peerId: string, items: { paths: string[]; text?: string }, onProgress?: (sent: number, total: number) => void): Promise<void>;
  pending(): AddonOffer[];
  has(offerId: string): boolean;
  accept(offerId: string): Promise<void>;
  reject(offerId: string): Promise<void>;
}

/** What an add-on's main file exports (CommonJS `module.exports` or its `default`). */
export interface AddonModule {
  apiVersion: number;
  transports(): AddonTransport[];
}
