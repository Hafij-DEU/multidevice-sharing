// The contract between the UI (renderer) and the app (main). The renderer imports only types from
// here and talks only to window.meshdrop, so the same UI can run elsewhere (the Android WebView).

export type Reach = 'lan' | 'bt' | 'hub' | 'offline';

export interface DeviceView {
  deviceId: string;
  alias: string;
  role: 'hub' | 'member' | 'paired' | 'nearby' | 'localsend';
  trusted: boolean;
  reach: Reach;
  deviceType?: string;
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
  /** M11 read receipt: when the receiver first opened what was sent. */
  openedAt?: number;
}

export interface ReceivedRecord {
  at: number;
  from: string;
  alias: string;
  files: string[];
  text?: string;
  clipboard?: boolean;
  /** M11: the session (for read receipts). */
  sessionId?: string;
  /** M11 burn after reading: the files go a few minutes after the first open (or after 7 days). */
  burn?: boolean;
  /** When the files will be deleted (set at the first open). */
  burnAt?: number;
  /** The files were deleted (burn after reading). */
  burned?: boolean;
  /** The files were deleted by the smart inbox clean-up. */
  cleaned?: boolean;
  openedAt?: number;
}

/** M11: options of one send. */
export interface SendOptions {
  /** Burn after reading on the receiver. */
  burn?: boolean;
  /** Print on the receiver (a PC that allows it). */
  print?: boolean;
  /** Time capsule: send at this time (ms) instead of now; the app keeps it until then. */
  at?: number;
}

/** M11: a send waiting for its time (time capsule). */
export interface ScheduledView {
  id: string;
  at: number;
  targets: string[];
  aliases: string[];
  names: string[];
  burn?: boolean;
  print?: boolean;
}

/** M14: how a device is reached. */
export type LinkMode = 'auto' | 'wifi' | 'bt';

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
  /** Devices allowed to control this device (pointer, keyboard, PC actions); empty: none (M10). */
  remoteFrom: string[];
  /** Links sent from your own devices with "Open on device" open in the browser. */
  openLinks: boolean;
  /** Show notifications forwarded from your phones. */
  phoneNotifications: boolean;
  /** M11: print files your devices send with "Print". */
  printFromDevices: boolean;
  /** M11 smart inbox: received files go in Images, Videos, Audio, Documents, Archives or Other. */
  sortInbox: boolean;
  /** M11 read receipts: tell the sender when you open what it sent. */
  sendReceipts: boolean;
  /** M11 smart inbox clean-up: received files older than this many days are deleted (0: never). */
  cleanupDays: number;
  /** M14 No Wi-Fi: Bluetooth links to trusted devices when there is no shared network (default on). */
  bluetooth: boolean;
  /** M14: every device over Bluetooth, even on the same network. */
  allBluetooth: boolean;
  /** M14 per device: Auto (network, else Bluetooth), Wi-Fi only, or Bluetooth only; missing: Auto. */
  deviceLinks: Record<string, LinkMode>;
  /** M14: on a phone's hotspot MeshDrop joined, never use the phone's mobile data (no default route, no DNS). */
  tetherNoData: boolean;
  /** Desktop: Opus bitrate in kbit/s (16, 24 or 32) for this PC's sound over Bluetooth. */
  btSoundKbps: number;
  /** Android: the devices this phone forwards its notifications to. */
  notifyTo?: string[];
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

/** Folder sync (LAN only): the folder, and the devices it is synced with. */
export interface SyncPartnerView {
  deviceId: string;
  alias?: string;
  present: boolean;
  syncing: boolean;
  last?: { at: number; pulled: number; deleted: number; conflicts: number; errors: number; error?: string };
}

/** Folder sync (LAN only): each synced folder, matched with the partners' folders by name. */
export interface SyncView {
  folders: { name: string; folder: string; partners: SyncPartnerView[] }[];
  /** A path for "Use the suggested folder" ('' on Android, where the folder is always picked). */
  suggested: string;
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
  autoAccept?: boolean;
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
  /** With allowUploads: their sends land without asking. */
  autoAccept?: boolean;
}

export interface AppState {
  /** addrs: this device's LAN IPv4 addresses (what another device types to add it). */
  self: { deviceId: string; alias: string; port: number; addrs?: string[] };
  mode: 'serving' | 'client-only';
  hub: {
    role: 'hub' | 'member' | 'provisional' | 'none'; online: boolean; version: number; members: number; urls: string[]; ingressPort: number;
    /** The link is on the main hub, or on a relay hub while the main one is away. */
    linkedTo?: 'main' | 'relay' | null;
    /** This device runs a relay hub. */
    relayHub?: boolean;
  };
  /** Relay hubs of the mesh (M9): devices fail over to them while the main hub is off. */
  relays?: { deviceId: string; alias: string; urls: string[] }[];
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
  /** Photo backup (Android): new camera photos and videos go to a PC on the same Wi-Fi. */
  backup?: { target: string; permission: boolean; running: boolean; count: number; lastAt?: number; error?: string };
  /** Folder sync (absent where the platform has none yet). */
  sync?: SyncView;
  /** LAN guests (absent where the platform has no guest server). */
  guest?: GuestView;
  /** Internet guest links (present on the hub PC). */
  links?: LinkView[];
  /** Internet access of the hub PC. */
  reach?: ReachView;
  /** M10: notifications forwarded from phones (newest first). */
  phoneNotes?: PhoneNote[];
  /** M10: battery, storage and signal of reachable devices, by device id. */
  deviceStatus?: Record<string, DeviceStatus>;
  /** M10: this device is ringing (Find my device), until stopped. */
  ringing?: boolean;
  /** M10: why remote input does not work on this PC (absent: it does, or nobody tried yet). */
  inputError?: string;
  /** Android: notification access is granted (needed to forward notifications). */
  notifyAccess?: boolean;
  /** M10b: live streams (PC sound to a phone; a phone's camera or microphone used here; sound between devices). */
  streams?: { id: string; kind: StreamKind; peer: string; alias?: string }[];
  /** M14: this PC searches for Bluetooth devices while a stream goes over the Bluetooth link, which breaks it up. */
  btScanning?: boolean;
  /** M13 handoff: the PC's browser extension is connected, and the page it last saw. */
  handoff?: { extension: boolean; page?: { title: string; url: string } };
  /** M12 watch parties this device hosts (or, on a phone, made on a PC). */
  watch?: { code: string; name: string; people?: number; playing?: string; links: string[]; hostToken?: string }[];
  /** M11 room mode: the shared drop board (desktop). */
  room?: { active: boolean; url?: string; qrSvg?: string; title?: string; expiresAt?: number; posts: { id: string; name: string; size: number; by: string; at: number; image: boolean }[] };
  /** M11: sends waiting for their time. */
  scheduled?: ScheduledView[];
  /** M10b Android: what this phone streams now. */
  casting?: { audioFrom?: string; cameraTo?: string; cameraBack?: boolean; micTo?: string; soundTo?: string; /** Android: the PC this phone's sound plays on as Bluetooth audio (A2DP). */ a2dpTo?: string };
  /** M14 No Wi-Fi hotspots (absent where this device cannot host or join one). */
  noWifi?: NoWifiView;
}

/** M14: the hotspot this device hosts or joined, one offered by a Bluetooth-linked device, the tether guard. */
export interface NoWifiView {
  hotspot?: { role: 'host' | 'joined'; ssid: string; psk?: string; qrSvg?: string };
  /** A device shared its hotspot over Bluetooth (joined on its own when this device's Wi-Fi was free). */
  offer?: { from: string; alias?: string; ssid: string; psk: string; hosts: string[]; joining?: boolean; error?: string };
  /** Desktop: the joined phone hotspot, when it carries no internet for this PC right now (tetherNoData). */
  guarded?: string[];
}

/**
 * A live stream on this PC: 'audio' this PC's sound played on a phone (the phone pulls it), 'camera' /
 * 'mic' a phone's camera or microphone used here, 'sound' another device's sound out of these
 * speakers, 'sound-out' this PC's sound sent to another device.
 */
/** bt-audio: a phone plays its sound here as Bluetooth audio (A2DP), like earbuds. */
export type StreamKind = 'audio' | 'camera' | 'mic' | 'sound' | 'sound-out' | 'bt-audio';

/** A notification forwarded from a phone (M10). */
export interface PhoneNote {
  from: string;
  fromAlias?: string;
  key: string;
  app: string;
  title: string;
  text: string;
  time: number;
  /** It has a reply action (messages, SMS): the PC can answer it. */
  replyable: boolean;
}

/** Battery, storage and signal a device reports (M10). */
export interface DeviceStatus {
  at: number;
  battery?: { level: number; charging: boolean };
  storage?: { free: number; total: number };
  signal?: { level: number; type?: string };
}

/** Pointer, keyboard and laser events the Remote page sends to a PC (M10 "input"). */
export type RemoteEvent =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'button'; b: 'left' | 'right' | 'middle'; down: boolean }
  | { t: 'click'; b: 'left' | 'right' | 'middle' }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'text'; s: string }
  | { t: 'key'; k: string; mods?: string[] }
  | { t: 'laser'; x: number; y: number; on: boolean };

/**
 * M1/M2 Wi-Fi module (Android). A network the user saved into MeshDrop. The passphrase stays sealed on
 * the device and is never sent to the UI — only `hasPassword` says whether one is stored.
 */
export interface WifiProfileView {
  id: string;
  ssid: string;
  security: 'open' | 'wpa2' | 'wpa3';
  hasPassword: boolean;
  /** Lowercase AP MAC this network is pinned to (band lock), or null for any AP. */
  lockBssid?: string | null;
  /** '2.4' | '5' | '6': the pinned AP's band, or null when not pinned. */
  band?: string | null;
  fallback: boolean;
  hidden: boolean;
  priority: number;
  updatedAt: number;
  /** M3: an 802.1X / eduroam profile (reserved; not yet editable). */
  enterprise: boolean;
}

/** M1: the fields the Wi-Fi tab sends to add or edit a network. */
export interface WifiProfileInput {
  /** Omit to add a new network; set to edit an existing one. */
  id?: string;
  ssid: string;
  security: 'open' | 'wpa2' | 'wpa3';
  /** The passphrase; leave blank when editing to keep the stored one. */
  password?: string;
  /** Lowercase AP MAC to pin to (band lock); omit for any AP. */
  lockBssid?: string | null;
  band?: string | null;
  fallback?: boolean;
  hidden?: boolean;
  priority?: number;
}

/** M2: the live Wi-Fi connection on this device. */
export interface WifiStatusView {
  enabled: boolean;
  connected: boolean;
  ssid?: string | null;
  bssid?: string;
  freq?: number;
  band?: string;
  channel?: number;
  rssi?: number;
  linkMbps?: number;
  /** The current AP is one MeshDrop pinned (band lock in effect). */
  locked: boolean;
}

/** M2: one access point seen in a scan, for picking a BSSID to pin. */
export interface WifiScanAp {
  ssid: string;
  bssid: string;
  freq: number;
  band: string;
  channel: number;
  rssi: number;
  secure: boolean;
  wpa3: boolean;
}

/** M2: the result of applying the saved networks as system suggestions. */
export interface WifiApplyResult {
  profiles: number;
  suggestions: number;
  /** Pinning a band needs Android 11 (API 30); false below that — the network still connects, unpinned. */
  canLock: boolean;
}

export interface DesktopApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  /** M10: an app message (remote input, ring, status, reply, open-url) to a paired device: its answer. */
  appSend(deviceId: string, msg: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** M10: stops this device's own ringing. */
  ringStop(): Promise<void>;
  /** M10b: ends a live stream (desktop: by id from state.streams; Android: 'audio' | 'camera' | 'mic'). */
  streamStop(id: string): Promise<void>;
  /** M10b: 'audio' plays a PC's sound here (Android); 'camera' / 'mic' send this phone's to a PC; 'sound' sends this device's sound to another device. */
  streamStart?(deviceId: string, kind: 'audio' | 'camera' | 'mic' | 'sound', camera?: 'front' | 'back'): Promise<void>;
  /**
   * M14: hosts a hotspot and offers it to Bluetooth-linked devices. When the Wi-Fi is on a network it
   * fails with "wifi-busy:<network>" unless `leaveNetwork` (the UI asks first).
   */
  hotspotStart?(leaveNetwork?: boolean): Promise<void>;
  /** M14: joins a hotspot (from an offer or typed in); `hosts` (ip:port) are tried as devices on it. "wifi-busy:<network>" as for hotspotStart. */
  hotspotJoin?(ssid: string, psk: string, hosts?: string[], leaveNetwork?: boolean): Promise<void>;
  /** M14: ends the hotspot this device hosts or leaves the joined one; drops an open offer. */
  hotspotStop?(): Promise<void>;
  /** M10: forgets one forwarded phone notification (or all with no key). */
  noteDismiss(key?: string): Promise<void>;
  pickFiles(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pickSavePath(defaultName: string): Promise<string | null>;
  pickOpenPath(): Promise<string | null>;
  pathForFile(file: File): string;
  send(targets: string[] | 'all', items: SendItemInput[], opts?: SendOptions): Promise<void>;
  /**
   * PC: sets up every phone plugged in with USB debugging (keep-alive settings and permissions, through
   * adb). Absent on Android.
   */
  setupPhones?(): Promise<{ serial: string; model: string; status: 'done' | 'unauthorized' | 'not-installed' | 'offline' | 'failed'; steps: { label: string; ok: boolean }[]; hint?: string }[]>;
  /** M11 phone as scanner (Android): a photo of a page, as a one-page PDF to send (null: cancelled). */
  scanDocument?(): Promise<SendItemInput | null>;
  /** M13 handoff. PC: send the browser's current page to a phone. Phone: open the PC's current page here. */
  handoffSend?(deviceId: string): Promise<void>;
  handoffPull?(): Promise<string | null>;
  /** PC: puts the browser extension in a folder your browser can load (returns the folder). */
  handoffExtension?(): Promise<string>;
  /** M12 watch party: host a room (here, or on a PC from a phone); returns its code and links. */
  /** `qrSvgs[i]` is the QR code of `links[i]`; `qrSvg` is the first one (older phones send only that). */
  watchCreate?(name: string): Promise<{ code: string; links: string[]; hostToken: string; qrSvg: string; qrSvgs?: string[] }>;
  /** The link to open for a code (this device's rooms, the hub, PCs on this network); null: not found. */
  watchResolve?(code: string): Promise<string | null>;
  /** Opens the player: a window on the PC, the browser on a phone. */
  watchOpen?(url: string): Promise<void>;
  watchEnd?(code: string): Promise<void>;
  /** PC: plays a video file from this PC in the room (no upload). */
  watchPlayLocal?(code: string, path: string): Promise<void>;
  /** M11 room mode. */
  roomStart?(minutes: number, title: string): Promise<void>;
  roomEnd?(): Promise<void>;
  roomPost?(paths: string[]): Promise<void>;
  roomSave?(id: string): Promise<string>;
  /** M11: cancels a scheduled send. */
  scheduleCancel(id: string): Promise<void>;
  /** M11 voice notes: saves recorded bytes (base64) as a file to send; returns its path. */
  saveBlob(name: string, base64: string): Promise<string>;
  sendClipboard(targets: string[] | 'all'): Promise<void>;
  resumeOutbox(): Promise<void>;
  removeOutbox(sessionId: string): Promise<void>;
  /** Looks at the device at host:port without trusting it; `code` is the pairing code both screens show. */
  pairProbe(host: string, port: number): Promise<{ deviceId: string; alias: string; code: string }>;
  /** `expectDeviceId`: the device whose pairing code the user checked; another one answering is refused. */
  addByAddress(host: string, port: number, alias: string, expectDeviceId?: string): Promise<void>;
  scanSubnet(): Promise<number>;
  hubInit(urls: string[]): Promise<void>;
  setHubUrls(urls: string[]): Promise<void>;
  /** Main hub: the members that run a relay hub, with their public wss:// addresses. */
  relaysSet(relays: { deviceId: string; urls: string[] }[]): Promise<void>;
  /** `group`: one QR any of your devices can scan (up to 20, 15 min); default single use (5 min). */
  createInvite(group?: boolean): Promise<{ uri: string; qrSvg: string; expiresAt: number }>;
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
  /** Adds or changes a synced folder; `previousName` renames that one. */
  syncPut(name: string, folder: string, partners: string[], previousName?: string): Promise<void>;
  syncRemove(name: string): Promise<void>;
  /** A round now for one folder, or (no name) all of them. */
  syncNow(name?: string): Promise<void>;
  /** Android: photo backup to `target` ('' = off); `includeExisting`: also the photos already on the phone. */
  backupSet?(target: string, includeExisting: boolean): Promise<void>;
  backupPermission?(): Promise<void>;
  /** Desktop: shows the sync folder in the file manager. */
  openSyncFolder?(name: string): Promise<void>;
  openInbox(): Promise<void>;
  reveal(path: string): Promise<void>;
  /** Unpairs a manually paired device (it shows as nearby again: Pair re-pairs it). */
  unpair(deviceId: string): Promise<void>;
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
  /** M1/M2 Android: the user's saved Wi-Fi networks (band lock). Absent on desktop. */
  wifiList?(): Promise<WifiProfileView[]>;
  /** Adds a new network (no id) or edits one; returns the saved view (never the passphrase). */
  wifiSave?(input: WifiProfileInput): Promise<WifiProfileView>;
  wifiDelete?(id: string): Promise<void>;
  /** Registers system suggestions for the given ids (or all when omitted) and applies the band lock. */
  wifiApply?(ids?: string[]): Promise<WifiApplyResult>;
  /** Removes every suggestion MeshDrop registered (undoes the lock). */
  wifiForget?(): Promise<void>;
  wifiStatus?(): Promise<WifiStatusView>;
  /** Scans for access points (optionally one SSID) so the user can pick a BSSID to pin. */
  wifiScan?(ssid?: string): Promise<WifiScanAp[]>;
}

declare global {
  interface Window {
    meshdrop: DesktopApi;
  }
}
