// The contract between the UI (renderer) and the app (main). The renderer imports only types from
// here and talks only to window.meshdrop, so the same UI can run elsewhere (the Android WebView).

export type Reach = 'lan' | 'hub' | 'offline';

export interface DeviceView {
  deviceId: string;
  alias: string;
  role: 'hub' | 'member' | 'paired' | 'nearby';
  trusted: boolean;
  reach: Reach;
  deviceType?: string;
  lastSeen?: number;
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
  status: 'preparing' | 'sending' | 'receiving' | 'done' | 'held' | 'failed' | 'cancelled';
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
  notifications: boolean;
}

export interface AppState {
  self: { deviceId: string; alias: string; port: number };
  mode: 'serving' | 'client-only';
  hub: { role: 'hub' | 'member' | 'provisional' | 'none'; online: boolean; version: number; members: number; urls: string[]; ingressPort: number };
  devices: DeviceView[];
  transfers: TransferView[];
  outbox: { sessionId: string; deviceId: string; alias?: string; files: number; bytes: number }[];
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
  /** Android: files shared into MeshDrop from another app, waiting for takeSharedItems(). */
  sharedPending?: number;
  /** Mesh members (for the Mesh page). */
  members: { deviceId: string; alias: string; role: 'hub' | 'member'; self: boolean }[];
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
  openInbox(): Promise<void>;
  reveal(path: string): Promise<void>;
  registerClipboardShortcut(binding: string): Promise<void>;
  openConfigFolder(): Promise<void>;
  /** Android: the system picker, returning items with display names (content URIs are not readable paths). */
  pickItems?(kind: 'file' | 'dir'): Promise<SendItemInput[]>;
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
