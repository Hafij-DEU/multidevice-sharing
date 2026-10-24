// The contract between the UI (renderer) and the app (main). The renderer imports only types from
// here and talks only to window.meshdrop, so the same UI can run elsewhere (the Android WebView).

export type Reach = 'lan' | 'hub' | 'offline';

export interface DeviceView {
  deviceId: string;
  alias: string;
  role: 'hub' | 'member' | 'paired' | 'nearby' | 'localsend';
  trusted: boolean;
  reach: Reach;
  deviceType?: string;
  lastSeen?: number;
  /** Nearby devices: their address, for one-click pairing. */
  host?: string;
  port?: number;
  self: false;
}

export interface SendItemInput {
  kind: 'file' | 'dir' | 'text';
  /** A local path, or a content:// URI on Android. */
  path?: string;
  /** Display name when `path` is not readable (a content URI). */
  name?: string;
  text?: string;
}

export interface TransferView {
  /** `${deviceId}:${sessionId || startedAt}` */
  key: string;
  direction: 'out' | 'in';
  deviceId: string;
  alias: string;
  files: number;
  bytes: number;
  sent: number;
  /** waiting: the device was away; the send goes out when it is seen again. */
  status: 'preparing' | 'sending' | 'receiving' | 'done' | 'held' | 'waiting' | 'failed' | 'cancelled';
  /** Smoothed speed while it moves (absent until measured). */
  bytesPerSec?: number;
  error?: string;
  startedAt: number;
}

export interface ReceivedRecord {
  at: number;
  from: string;
  alias: string;
  files: string[];
  text?: string;
  clipboard?: boolean;
}

export interface Settings {
  alias: string;
  inbox: string;
  port: number;
  discovery: boolean;
  autostart: boolean;
  startHidden: boolean;
  closeToTray: boolean;
  clipboardReceive: boolean;
  /** Copying text sends it to the online trusted devices (they put it on their clipboard). */
  clipboardSync: boolean;
  notifications: boolean;
  /** How long a guest link works, in minutes (5..1440). */
  guestMinutes: number;
}

export interface GuestFileView { name: string; size: number; type?: string; thumb?: string }

/** The LAN guest session (the desktop and Android apps). */
export interface GuestView {
  active: boolean;
  /** False when the guest server could not start (its port is taken, or this window is client-only). */
  available: boolean;
  url?: string;
  qrSvg?: string;
  expiresAt?: number;
  /** A browser has opened the link. */
  claimed?: boolean;
  shared: { id: string; name: string; size: number }[];
  /** Sends waiting for the owner's answer (`via: 'link'`: from an internet link). */
  offers: { id: string; files: GuestFileView[]; text?: string; via?: 'link' | 'localsend'; alias?: string }[];
}

/** An internet guest link (hub PC only). */
export interface LinkView {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  files: number;
  bytes: number;
  downloads: number;
  maxDownloads?: number;
  hasPassword: boolean;
  allowUploads: boolean;
  url?: string;
}

export type ReachMode = 'off' | 'tailscale' | 'cloudflare' | 'port-forward';

/** How the hub PC is reached from the internet (hub only). */
export interface ReachView {
  mode: ReachMode;
  state: 'off' | 'starting' | 'on' | 'error' | 'missing' | 'logged-out';
  url?: string;
  host?: string;
  error?: string;
  fix?: string;
  certExpiresAt?: number;
  tokenSet: boolean;
  mapped?: 'upnp' | 'natpmp' | 'manual';
  listenPort?: number;
  config: { cloudflareHost?: string; duckdnsDomain?: string; mapping?: 'auto' | 'manual' };
  detection: { wanIp?: string; publicIp?: string; upnp: boolean; natpmp: boolean; cgnat: boolean; suggestion: 'tunnel' | 'port-forward'; reason: string } | null;
}

export interface ReachInput {
  mode: ReachMode;
  cloudflareHost?: string;
  duckdnsDomain?: string;
  duckdnsToken?: string;
  mapping?: 'auto' | 'manual';
}

export interface LinkCreateInput {
  files: string[];
  text?: string;
  days: number;
  password?: string;
  maxDownloads?: number;
  allowUploads: boolean;
}

export interface AppState {
  /** addrs: this device's LAN IPv4 addresses (what another device types to add it). */
  self: { deviceId: string; alias: string; port: number; addrs?: string[] };
  mode: 'serving' | 'client-only';
  hub: { role: 'hub' | 'member' | 'provisional' | 'none'; online: boolean; version: number; members: number; urls: string[]; ingressPort: number };
  devices: DeviceView[];
  transfers: TransferView[];
  /** waiting: sends on its own when the device is seen; else it stopped on `error`. */
  outbox: { sessionId: string; deviceId: string; alias?: string; files: number; bytes: number; waiting: boolean; error?: string }[];
  received: ReceivedRecord[];
  settings: Settings;
  /** Offers are accepted right now (false: paused, client-only, or the port could not be bound). */
  receiving: boolean;
  /** Why this device is not receiving although it should (shown as a banner). */
  error?: string;
  /** Which shell runs the UI (absent = desktop). */
  platform?: 'desktop' | 'android';
  /** Android: the "Keep MeshDrop alive" checklist for this phone's ROM. */
  keepAlive?: { batteryUnrestricted: boolean; rom: 'miui' | 'hios' | 'stock'; steps: { id: string; label: string; done?: boolean }[] };
  /** Files shared into MeshDrop (Android share menu, Files → Send with MeshDrop), waiting for takeSharedItems(). */
  sharedPending?: number;
  /** Android: the meshdrop://join link the app was opened with (pre-fills the join box until a join is tried). */
  joinLink?: string;
  /** Mesh members (for the Mesh page). */
  members: { deviceId: string; alias: string; role: 'hub' | 'member'; self: boolean }[];
  /** LAN guests (absent where the platform has no guest server). */
  guest?: GuestView;
  /** Internet guest links (present on the hub PC). */
  links?: LinkView[];
  /** Internet access of the hub PC. */
  reach?: ReachView;
}

export interface DesktopApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  pickFiles(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pickSavePath(defaultName: string): Promise<string | null>;
  pickOpenPath(): Promise<string | null>;
  pathForFile(file: File): string;
  send(targets: string[] | 'all', items: SendItemInput[]): Promise<void>;
  sendClipboard(targets: string[] | 'all'): Promise<void>;
  resumeOutbox(): Promise<void>;
  removeOutbox(sessionId: string): Promise<void>;
  addByAddress(host: string, port: number, alias: string): Promise<void>;
  scanSubnet(): Promise<number>;
  hubInit(urls: string[]): Promise<void>;
  setHubUrls(urls: string[]): Promise<void>;
  createInvite(): Promise<{ uri: string; qrSvg: string; expiresAt: number }>;
  join(uri: string): Promise<'member' | 'provisional'>;
  revoke(deviceId: string): Promise<void>;
  exportRecovery(path: string, passphrase: string): Promise<void>;
  importRecovery(path: string, passphrase: string): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  guestStart(): Promise<{ url: string; qrSvg: string; expiresAt: number }>;
  guestEnd(): Promise<void>;
  guestShare(paths: string[]): Promise<void>;
  guestUnshare(id: string): Promise<void>;
  guestAccept(id: string): Promise<void>;
  guestReject(id: string): Promise<void>;
  linkCreate(input: LinkCreateInput): Promise<{ id: string; url: string; qrSvg: string; expiresAt: number }>;
  linkRevoke(id: string): Promise<void>;
  reachDetect(): Promise<void>;
  reachSet(input: ReachInput): Promise<void>;
  openInbox(): Promise<void>;
  reveal(path: string): Promise<void>;
  /** Opens a received file in its default app (Android: the same as reveal). */
  openFile(path: string): Promise<void>;
  /** A preview (data: URL) of a received image or video, or null. */
  thumb(path: string): Promise<string | null>;
  registerClipboardShortcut(binding: string): Promise<void>;
  openConfigFolder(): Promise<void>;
  /** Android: the system picker, returning items with display names (content URIs are not readable paths). */
  pickItems?(kind: 'file' | 'dir'): Promise<SendItemInput[]>;
  /** Android: scans a QR code with the camera; its text, or null when cancelled. */
  scanQr?(): Promise<string | null>;
  /** Android: the items shared into MeshDrop (Share → MeshDrop), once. */
  takeSharedItems?(): Promise<SendItemInput[]>;
  /** Android: runs one step of the keep-alive checklist (opens the right system screen). */
  keepAliveAction?(id: string): Promise<void>;
}

declare global {
  interface Window {
    meshdrop: DesktopApi;
  }
}
