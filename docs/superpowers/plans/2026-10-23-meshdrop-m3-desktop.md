# MeshDrop M3: Ubuntu Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship MeshDrop on Ubuntu as an Electron desktop app (`.deb`). It owns the device's engine and gives the owner a window, a tray icon, notifications and clipboard sharing over everything M1 and M2 built: devices, sending, transfers, inbox, the mesh, and settings. It also closes the items deferred to M3.

**Architecture:**
- **Monorepo layout.** A new workspace package `apps/desktop` holds:
  - an **Electron main process** that runs one `Engine` from `packages/core` through an Electron-free `AppController`;
  - a **preload** that exposes a typed, narrow API over IPC;
  - a **React + Vite renderer**.
- **One engine per device.** The app is this device's `meshdrop listen` and uses the same config home, so the CLI and the app share identity, trust and mesh. If a CLI or systemd listener already runs on that home, the app runs client-only and says so.
- **Pure logic is testable without Electron.** Logic lives in plain TS modules covered by vitest. The Electron shell is thin and covered by Playwright `_electron` smoke tests.
- **First part: core changes.** Tasks 1–5 change `packages/core` (deferred items, clipboard, subnet scan, auto-resume, hardening).
- **Second part: the app.** Tasks 6–11 build the app.

**Tech Stack:**
- Electron `42.1.0` and electron-builder `26.15.3`;
- Vite `8.3.4`;
- React and React DOM `19.3.0`;
- `@playwright/test` `1.64.0` with `_electron`;
- vitest and TypeScript, as in M1/M2.

All of these are in the offline pnpm store; see Global Constraints.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`. This plan builds:
- §2 (owner tier);
- §3 goals 7, 9 and 14 in the UI;
- §6 (Ubuntu 26.04 first);
- §7 (one UI codebase; Electron `.deb`);
- §8 "Clipboard", "Multi-send", "Received files";
- the M3 roadmap row in the M1 plan;
- the items M1 and M2 deferred to M3.

**Wire spec:** `docs/protocol.md`. Task 1 adds the optional manifest field `clipboard`, documented there.

This is plan 3 of 7. The Android app (M4) will reuse the renderer bundle in a WebView. Keep the renderer free of Node and Electron imports: it talks only to `window.meshdrop` (`DesktopApi`).

## Global Constraints

- **Runtimes and tooling.**
  - Node `v24.22.0` for tooling and tests; Electron `42.1.0` at runtime. Main and preload are bundled to CommonJS with Vite library mode: no TS at runtime, no `.ts` imports in the bundle.
  - `pnpm@10.33.4`.
  - Dependencies are installed with `pnpm add --offline`. If the pnpm metadata for a cached tarball is missing (as happened with `ws` in M2), one online install of that exact version is allowed and must be noted in the report.
  - No dependencies beyond the Tech Stack list, `ws` and `qrcode` (already used by core). Anything else needs a written justification.
- **Electron security.**
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
  - CSP `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`.
  - `setWindowOpenHandler` denies everything, and navigation away from the app is blocked.
  - The renderer never renders network-sourced strings as HTML: React text nodes only, no `dangerouslySetInnerHTML`. The QR is an SVG string produced by `qrcode` in main and shown as `<img src="data:image/svg+xml;base64,…">`.
- **Identity.**
  - App id `io.github.hafijbge.meshdrop`, product name `MeshDrop`, executable `meshdrop-desktop`.
  - `.deb` maintainer `Hafij-BGE <mdhafijur.rahman@ogr.deu.edu.tr>`, credit "Md Hafijur Rahman", licence GPL-3.0.
- **Shared state with the CLI.** The config home is the same as the CLI's (`configDir()`) and the inbox defaults to `~/Downloads/MeshDrop`. The app writes `<home>/listen.pid` (`{pid, port}`) like `meshdrop listen`, and refuses to bind if a live listener owns it.
- **Look.**
  - Clean and modern, with no clutter. Light/dark follows the system (`nativeTheme`) and the accent colour is `#3b82f6`.
  - GNOME-like spacing; system UI font stack (`Cantarell, "Ubuntu", system-ui, sans-serif`).
  - The window minimum is 720×520.
- **UI events.** Progress events reach the renderer throttled to at most 10 per second per device and session.
- **Commits.** `git -c user.name=Hafij-BGE -c user.email=mdhafijur.rahman@ogr.deu.edu.tr commit`, each message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `m3-desktop`.

## Review Focus

1. **App started next to a running `meshdrop listen` or the systemd unit on the same home.**
   - Expected: the app does not fight it (no port clash, no 4409 hub-link flapping). It runs client-only and shows "Receiving is handled by the MeshDrop background service" in the status bar.
   - Tested in Task 7.
2. **Closing the window, or quitting during a transfer.**
   - Expected: closing keeps receiving (close-to-tray).
   - Expected: quitting pauses sends (`cancelled`, resumable), and they resume automatically when the device is next reachable.
   - Tested in Tasks 4 and 10.
3. **A huge folder drop (thousands of files).**
   - Expected: the UI stays responsive, with progress throttled and file lists rendered as counts, not 10,000 rows.
   - Tested in Task 7 (throttle) and Task 8 (summary rendering).
4. **Hostile names and text from peers** (bidi overrides, control characters, `<script>`).
   - Expected: shown as inert text.
   - Expected: received clipboard text is only placed on the clipboard with a notification, never typed or opened.
   - Tested in Tasks 7 and 8.
5. **Settings that cannot work** (inbox set to a non-writable or missing path, port in use).
   - Expected: the change is refused with a clear message and the old value is kept.
   - Tested in Task 6 (store) and Task 7 (controller).

---

## File Structure

```
packages/core/src/
  chunk.ts, transfer/send.ts      # T1: manifest `clipboard` flag; path precheck in prepareItems
  discovery.ts                    # T2: isTrusted option, manual addresses sticky, trusted admitted when full
  inbox.ts                        # T3: top-level folder vs existing file → unique dir
  engine.ts                       # T1/T4: devices(), sendClipboard(), auto-resume, scanSubnet(), resume progress, manual-only routing
  hub/server.ts, hub/client.ts, hub/held.ts, transfer/transport.ts   # T5: hardening
apps/desktop/
  package.json  electron-builder.yml  vite.renderer.config.ts  vite.main.config.ts  tsconfig.json  playwright.config.ts
  src/shared/api.ts               # DesktopApi + view types (renderer ↔ main contract)
  src/main/settings.ts            # SettingsStore (pure, JSON file)
  src/main/history.ts             # HistoryStore: received/sent records (pure, capped)
  src/main/controller.ts          # AppController: owns Engine, maps events to view state, throttles (no Electron imports)
  src/main/desktop.ts             # autostart file, gsettings shortcut commands (pure builders)
  src/main/main.ts                # Electron: window, tray, IPC wiring, single instance, notifications, clipboard
  src/main/preload.ts             # contextBridge → window.meshdrop
  src/renderer/index.html, main.tsx, App.tsx, styles.css
  src/renderer/pages/{Devices,Transfers,Inbox,Mesh,Settings}.tsx
  src/renderer/components/{DeviceCard,DropZone,ProgressRow,QrInvite,Toast,ClipboardPicker}.tsx
  test/*.test.ts                  # vitest (main-side pure modules + controller with real engines)
  e2e/*.spec.ts                   # Playwright _electron
packaging/icon/make_icon.py       # PIL-drawn icon → apps/desktop/build/icons/{512,256,128,64}x….png
packaging/systemd/meshdrop.service  # T11: ExecStart prefers /usr/bin/meshdrop
```

## Shared Types (`apps/desktop/src/shared/api.ts`, Task 7; renderer and main use only these)

```ts
export type Reach = 'lan' | 'hub' | 'offline';
export interface DeviceView { deviceId: string; alias: string; role: 'hub' | 'member' | 'paired' | 'nearby';
  trusted: boolean; reach: Reach; deviceType?: string; lastSeen?: number; self: false }
export interface SendItemInput { kind: 'file' | 'dir' | 'text'; path?: string; text?: string }
export interface TransferView { key: string /* `${deviceId}:${sessionId||startedAt}` */; direction: 'out' | 'in';
  deviceId: string; alias: string; files: number; bytes: number; sent: number;
  status: 'preparing' | 'sending' | 'receiving' | 'done' | 'held' | 'failed' | 'cancelled'; error?: string; startedAt: number }
export interface ReceivedRecord { at: number; from: string; alias: string; files: string[]; text?: string; clipboard?: boolean }
export interface Settings { alias: string; inbox: string; port: number; discovery: boolean; autostart: boolean;
  startHidden: boolean; closeToTray: boolean; clipboardReceive: boolean; notifications: boolean }
export interface AppState { self: { deviceId: string; alias: string; port: number }; mode: 'serving' | 'client-only';
  hub: { role: 'hub' | 'member' | 'provisional' | 'none'; online: boolean; version: number; members: number; urls: string[]; ingressPort: number };
  devices: DeviceView[]; transfers: TransferView[]; outbox: { sessionId: string; deviceId: string; alias?: string; files: number; bytes: number }[];
  received: ReceivedRecord[]; settings: Settings }
export interface DesktopApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  pickFiles(): Promise<string[]>; pickFolder(): Promise<string | null>; pickSavePath(defaultName: string): Promise<string | null>;
  send(targets: string[] | 'all', items: SendItemInput[]): Promise<void>;
  sendClipboard(targets: string[] | 'all'): Promise<void>;
  resumeOutbox(): Promise<void>; removeOutbox(sessionId: string): Promise<void>;
  addByAddress(host: string, port: number, alias: string): Promise<void>; scanSubnet(): Promise<number /* found */>;
  hubInit(urls: string[]): Promise<void>; setHubUrls(urls: string[]): Promise<void>;
  createInvite(): Promise<{ uri: string; qrSvg: string; expiresAt: number }>; join(uri: string): Promise<'member' | 'provisional'>;
  revoke(deviceId: string): Promise<void>;
  exportRecovery(path: string, passphrase: string): Promise<void>; importRecovery(path: string, passphrase: string): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;   // rejects with a user-readable Error on invalid values
  openInbox(): Promise<void>; reveal(path: string): Promise<void>;
  registerClipboardShortcut(binding: string): Promise<void>;  // GNOME custom shortcut via gsettings
}
```

---

## Part A: core (`packages/core`)

### Task 1: Clipboard messages, resume progress, sender-side path precheck

**Files:**
- Modify: `src/chunk.ts` (Manifest), `src/transfer/send.ts` (prepareItems / SendItem), `src/engine.ts` (`sendClipboard`, resume progress), `docs/protocol.md`.
- Test: `test/chunk.test.ts`, `test/send.test.ts`, `test/engine.test.ts`.

**Interfaces:**
- `Manifest` gains optional `clipboard?: true`. It is valid only together with `text`, and there are no files and no dirs.
  - Canonical serialization puts it after `text`.
  - It is absent when false, so every existing vector stays byte-identical.
  - `ReceiverEvent 'received'` gains `clipboard?: true`.
- `SendItem` gains `kind: 'text'` with an optional `clipboard: true`.
- `Engine.sendClipboard(deviceIds: string[] | 'all', text: string): Promise<SendResult[]>`. The text is capped at 1 MiB, matching `MAX_MANIFEST_TEXT_BYTES`.
- `prepareItems` runs `safeRelPath` on every manifest path it builds. A path that is rejected or rewritten throws `LocalPathError(path, reason)`, so the sender sees the problem locally instead of the receiver's `422`.
- `Engine.resumePending()` emits `{source:'sender', type:'progress', deviceId, …}` exactly like `send()`.

- [ ] **Step 1: Write the failing tests.**
  - `chunk.test.ts`:
    - A manifest with `clipboard:true` and text round-trips through `createOffer`/`acceptOffer`.
    - `clipboard` with files, or without text, is rejected.
    - The frozen `chunk-v1.json` still matches unchanged.
  - `send.test.ts`:
    - A directory containing a 33-level-deep path makes `sendTo` return `failed` with error `local-path` before any request; count server requests and expect 0.
  - `engine.test.ts`:
    - `A.sendClipboard([B], 'hello')` makes B emit `received` with `{text:'hello', clipboard:true}`.
    - `resumePending()` after an aborted send emits at least one sender `progress` event.
- [ ] **Step 2:** Run `pnpm vitest run test/chunk.test.ts test/send.test.ts test/engine.test.ts`. Expected: the new tests fail.
- [ ] **Step 3:** Implement. Add a "Clipboard messages" paragraph to `docs/protocol.md` under Manifest schema.
- [ ] **Step 4:** Run `pnpm test`. Expected: all green, and every vector test unchanged.
- [ ] **Step 5:** Commit with the message `feat(core): clipboard messages, resume progress, local path precheck`.

### Task 2: Discovery that respects trust

**Files:** Modify `src/discovery.ts` and `src/engine.ts` (pass `isTrusted`). Test: `test/discovery.test.ts`.

**Interfaces:**
- `DiscoveryOptions.isTrusted?: (deviceId: string) => boolean`.
- **Manual entries keep their address.** An announce for a manual peer refreshes `lastSeen` only; host and port stay as probed (they were certificate-verified).
- **Trusted devices are always admitted.** When the table holds `MAX_PEERS` (256) and a new id is trusted, the oldest non-manual untrusted entry is evicted (emitting `'lost'`). An untrusted newcomer is still ignored.
- [ ] **Step 1: Write the failing tests.**
  - A forged announce for a manual peer's id from another host leaves `host`/`port` unchanged.
  - The table is filled with 256 untrusted ids. A trusted id's announce is admitted, one untrusted entry is evicted, and `'lost'` is emitted for it. An untrusted 257th id is ignored.
- [ ] **Step 2:** Run `pnpm vitest run test/discovery.test.ts`. Expected: it fails.
- [ ] **Step 3:** Implement. The engine passes `isTrusted: (id) => trustSource.isTrusted(id)`.
- [ ] **Step 4:** Run the discovery tests 3×, then `pnpm test`. Expected: green.
- [ ] **Step 5:** Commit with the message `fix(core): discovery keeps verified addresses and always admits trusted devices`.

### Task 3: Incoming folder vs an existing file of the same name

**Files:** Modify `src/inbox.ts`. Test: `test/inbox.test.ts`.

**Interfaces:**
- `Inbox.begin` assigns each session a mapping `topLevel → localName`. When the inbox already has a non-directory entry named like an incoming top-level folder, the folder gets `uniqueName` (for example `Photos (1)`) for the whole session.
- The mapping is persisted in `state.json`, so resume after a restart uses the same folder.
- `finalize`/`finalizeDirs` apply it. A top-level name that is an existing directory is merged into as before, file by file with collision naming.
- [ ] **Step 1: Write the failing tests.**
  - The inbox has a file `Photos`. An incoming `Photos/a.jpg` and the empty dir `Photos/empty` land in `Photos (1)/`, and the file `Photos` is untouched.
  - The same session after a `new Inbox(root)` restart still uses `Photos (1)`.
  - An incoming folder whose name is an existing directory merges into it.
- [ ] **Step 2:** Run the inbox tests. Expected: they fail with ENOTDIR or the wrong layout.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: green.
- [ ] **Step 5:** Commit with the message `fix(core): incoming folder never collides with an existing file`.

### Task 4: Engine views, auto-resume, subnet scan, routing

**Files:** Modify `src/engine.ts`. Test: `test/engine-views.test.ts` (new), `test/engine-hub.test.ts`.

**Interfaces:**
- `Engine.devices(): EngineDevice[]`, where `EngineDevice = { deviceId; alias; role: 'hub'|'member'|'paired'|'nearby'; trusted: boolean; reach: 'lan'|'hub'|'offline'; deviceType?: string; lastSeen?: number }`.
  - Sources: mesh members, manual trust and discovery peers. This device is excluded.
  - Precedence: the mesh alias wins over the manual alias, which wins over the announce alias.
  - `reach`: `lan` if discovery has the device. Otherwise `hub` if the directory says it is online and this device's hub link is up. Otherwise `offline`.
- **Auto-resume.** Option `EngineOptions.autoResume?: boolean`, default `true` when serving.
  - The trigger is a `'peer'` discovery event, or a hub `directory` push in which a device is online.
  - On a trigger, entries of that device in the outbox whose last result was `failed` with a transient error, or `cancelled`, resume. Each device is resumed at most once per 30 s.
  - The outbox records the last result per entry, which needs a new `lastError` field in the entry file. `source-changed` and 4xx entries are never auto-resumed.
- `Engine.scanSubnet(opts?: { timeoutMs?: number; concurrency?: number }): Promise<number>`.
  - It probes every host in the /24 of each non-internal IPv4 interface on `DEFAULT_MESH_PORT` and on the engine's port, at most 512 addresses in total.
  - Defaults: 400 ms per probe, 32 concurrent.
  - It returns how many new peers were found. Found devices appear as `nearby` (untrusted) until paired or in the mesh.
- **Routing.** A device that is trusted only by manual pairing (not in the mesh list) is routed LAN-only, never through the hub. Unreachable gives `failed: offline`.
- [ ] **Step 1: Write the failing tests** in `engine-views.test.ts`, using engines with `discovery:false` and ephemeral ports.
  - `devices()` merges a mesh member, a manually paired device and a probed stranger with the expected `role`/`trusted`/`reach`, and never lists self.
  - Auto-resume:
    1. A sends to B; B's server is stopped mid-transfer and the send fails transiently.
    2. B restarts and is probed (a `'peer'` event).
    3. The entry completes without calling `send` or `resumePending`, and B's sha256 matches.
  - Auto-resume skips a `source-changed` entry.
  - `scanSubnet` against a listener on 127.0.0.1 (test override `subnets: ['127.0.0.0/30']`) finds it, and returns 0 when nothing listens.
  - A manual-only trusted device that is not on the LAN gives `failed: offline` with no hub request made (spy on `RelayTransport.request`).
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement. `scanSubnet` reuses `Discovery.probe`.
- [ ] **Step 4:** Run `pnpm test`. Expected: green.
- [ ] **Step 5:** Commit with the message `feat(core): device view, auto-resume, subnet scan, LAN-only manual devices`.

### Task 5: Hub and link hardening (M2 deferred minors)

**Files:** Modify `src/hub/server.ts`, `src/hub/client.ts`, `src/hub/held.ts`, `src/transfer/transport.ts`, `src/mesh/join.ts`. Test: `test/hub-server.test.ts`, `test/hub-client.test.ts`, `test/held.test.ts`, `test/transport.test.ts`.

**Interfaces and values:**
- **Pre-auth caps.**
  - At most 64 unauthenticated sockets per hub; the next one is closed `4429`.
  - A pre-auth message over 16384 bytes closes `4401`.
- **Client liveness.** If no `pong` or other traffic arrives for `2 × pingMs`, the client terminates the link and reconnects.
- **Held quota.** `HeldStore` serializes new offers (one global lock) so `#used()` and reservation are atomic.
- **TLS on hub URLs.** Unpinned `wss://` hub URLs use `minVersion: 'TLSv1.3'`.
- **Hub `500 internal`.** `RelayTransport` accepts a hub-signed `500 internal` and maps it to a transient error.
- **Hub URL validation.** `setUrls`/`hubInit` accept only `wss://` URLs, plus `ws://127.0.0.1|localhost|[::1]` when the engine option `allowLoopbackHubUrls` is set (tests). Invites never carry loopback URLs unless that option is set.
- [ ] **Step 1: Write the failing tests:**
  - 65 raw sockets that never authenticate: the 65th gets close `4429`.
  - A 20000-byte pre-auth message gives `4401`.
  - A fake hub that stops answering pings (but keeps the TCP connection) makes the client reconnect within `2×pingMs + 500 ms`, using `pingMs: 200`.
  - Two concurrent held offers whose combined `holdBytes` exceed the quota: exactly one gets `507 hub-quota`.
  - A hub-signed 500 is retried by the sender (attempt count 2 with `retryDelaysMs:[10]`).
  - `setHubUrls(['http://x'])` rejects. `setHubUrls(['ws://127.0.0.1:1/mesh/v1/hub'])` rejects without the option.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement. Update the existing tests that rely on loopback URLs to pass `allowLoopbackHubUrls: true`.
- [ ] **Step 4:** Run `pnpm test` 3×. Expected: green each time.
- [ ] **Step 5:** Commit with the message `fix(hub): pre-auth caps, client liveness, quota lock, TLS 1.3 on wss, URL validation`.

## Part B: the desktop app (`apps/desktop`)

### Task 6: Scaffold, build and settings store

**Files:**
- Create:
  - `apps/desktop/{package.json,tsconfig.json,vite.renderer.config.ts,vite.main.config.ts,playwright.config.ts}`
  - `src/main/settings.ts`, a minimal `src/main/main.ts` and `src/main/preload.ts`
  - `src/renderer/{index.html,main.tsx,App.tsx,styles.css}`
  - `test/settings.test.ts`, `e2e/launch.spec.ts`
- Modify: root `pnpm-workspace.yaml` (add `apps/*`) and root `package.json` scripts (`desktop:dev`, `desktop:build`, `desktop:e2e`).

**Interfaces:**
- `class SettingsStore { constructor(file: string, defaults: Settings); get(): Settings; set(patch: Partial<Settings>): Settings }`.
  - The file is `<home>/desktop-settings.json`, written atomically at mode 0600.
  - `set` validates every field and throws `SettingsError(message)`:
    - alias 1–64 characters with no control characters;
    - inbox an existing writable directory, or creatable;
    - port 1024–65535 or 0;
    - the rest are booleans.
  - An invalid patch changes nothing.
- **Build.**
  - `vite.main.config.ts` builds `src/main/main.ts` and `src/main/preload.ts` to `dist/main/*.cjs` (CJS). `electron` and Node builtins are external. `packages/core` is bundled in; `ws` and `qrcode` stay external, as runtime dependencies of `apps/desktop`.
  - `vite.renderer.config.ts` builds the renderer to `dist/renderer/`.
- **E2E launch.**
  - `e2e/launch.spec.ts` uses `_electron.launch({ args: ['dist/main/main.cjs', '--hidden-test'], env: { MESHDROP_HOME: tmp, MESHDROP_INBOX: tmp2, MESHDROP_TEST: '1' } })`.
  - Under `MESHDROP_TEST` the window is created with `show:false`, so tests do not pop windows on the user's screen.
  - In CI, the e2e job runs under `xvfb-run`.
- [ ] **Step 1: Write the failing tests:**
  - `settings.test.ts`:
    - defaults on a missing file;
    - persist and reload;
    - `set({inbox:'/proc/forbidden'})` throws and the old inbox is kept;
    - alias `'‮evil'` is rejected;
    - port `80` is rejected.
  - `launch.spec.ts`: the app starts, the window title is `MeshDrop`, and the renderer shows the text `Devices`.
- [ ] **Step 2:** Run `pnpm --filter desktop vitest run` and `pnpm desktop:build && pnpm desktop:e2e`. Expected: they fail.
- [ ] **Step 3:** Implement the scaffold with an empty `App` that shows a sidebar (Devices, Transfers, Inbox, Mesh, Settings) and the store.
- [ ] **Step 4:** Rerun both commands. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(desktop): scaffold Electron + Vite + React app with settings store`.

### Task 7: AppController and the IPC contract

**Files:**
- Create: `src/shared/api.ts` (the Shared Types above), `src/main/history.ts`, `src/main/controller.ts`.
- Modify: `src/main/main.ts` (IPC wiring) and `src/main/preload.ts` (`contextBridge.exposeInMainWorld('meshdrop', api)`).
- Test: `test/controller.test.ts`, `test/history.test.ts`.

**Interfaces:**
- `class HistoryStore { constructor(file: string, cap = 500); addReceived(r: ReceivedRecord): void; received(): ReceivedRecord[] }`, stored in `<home>/desktop-history.json`.
- `class AppController extends EventEmitter`:
  - Constructor: `new AppController(opts: { home: string; settings: SettingsStore; history: HistoryStore; platform: Platform; engineOptions?: Partial<EngineOptions> })`.
  - `Platform = { notify(title: string, body: string, onClick?: () => void): void; writeClipboard(text: string): void; readClipboard(): string; openPath(p: string): Promise<void>; revealPath(p: string): void }`. Electron-free, so tests pass a fake.
  - Methods:
    - `start(): Promise<void>` and `stop(): Promise<void>`;
    - `state(): AppState`;
    - every `DesktopApi` method except `pick*`/`onState`/`getState`, which main implements.
  - It emits `'state'` (throttled to 100 ms; progress at most 10 per second per transfer).
- **Start.**
  - If `<home>/listen.pid` names a live process that is not this one, the controller runs the engine with `serve:false` and sets `mode:'client-only'`.
  - Otherwise it serves with `autoResume:true`, writes `listen.pid`, and removes it on stop.
- **Events.**
  - On `received`: add a history record. If `clipboard && settings.clipboardReceive`, call `platform.writeClipboard(text)`.
  - If `settings.notifications`, call `platform.notify`. Clicking the notification reveals the first file.
  - Clipboard text is never opened or executed.
- [ ] **Step 1: Write the failing tests** in `controller.test.ts`, with two controllers on temp homes, a fake platform, discovery off and ephemeral ports.
  - Pair via `addByAddress`, then send a file. A's state shows a `TransferView` with status `done`, and B's `received` has the file with the alias and paths.
  - `sendClipboard`: B's fake platform `writeClipboard` is called with the text. With `clipboardReceive:false` it is not called, but the text still appears in `received`.
  - **Review Focus #1:** a stale `listen.pid` (dead pid) is ignored. A live foreign pid (`process.pid` of the test runner, written as `{pid, port}`) gives `mode:'client-only'`, and no server binds the port.
  - **Review Focus #3:** sending a folder of 2000 tiny files emits at most `ceil(duration_s × 10) + 2` state updates carrying progress for that transfer.
  - **Review Focus #4:** an alias `<img src=x onerror=alert(1)>‮` comes through `state()` unchanged, as data. Rendering is checked in Task 8.
  - **Review Focus #5:** `setSettings({port: <a port in use>})` rejects with a message containing `in use` and keeps the old port.
  - `history.test.ts`: the cap is honoured and the file reloads.
- [ ] **Step 2:** Run `pnpm --filter desktop vitest run`. Expected: it fails.
- [ ] **Step 3:** Implement. Main wires `ipcMain.handle('meshdrop:<method>')` for each API method, validating argument types (strings, arrays of strings, numbers) before calling the controller. The preload exposes exactly `DesktopApi`.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(desktop): app controller, history and typed IPC bridge`.

### Task 8: Devices, Transfers and Inbox UI

**Files:**
- Create: `src/renderer/pages/{Devices,Transfers,Inbox}.tsx` and `src/renderer/components/{DeviceCard,DropZone,ProgressRow,Toast}.tsx`.
- Modify: `App.tsx` and `styles.css`.
- Test: `e2e/send.spec.ts`.

**Behaviour:**
- **Devices.**
  - Cards show alias, a reach badge (`On this network` / `Via hub` / `Offline`), role, and a checkbox. An "All devices" toggle sits at the top.
  - The drop zone accepts files and folders from the file manager (`webUtils.getPathForFile` in preload) plus "Add files", "Add folder" and "Text" buttons.
  - "Send" is enabled when at least one target and at least one item are chosen.
  - "Add by address" (host[:port] + alias) and "Scan network" sit under a "Nearby" section that lists untrusted devices.
- **Transfers.**
  - Active transfers show one `ProgressRow` per device (bytes, percentage, status, error text).
  - The outbox list has Resume and Remove.
  - Below that, a history of the last 100 transfers.
- **Inbox.**
  - Received records, newest first.
  - File count plus the first 5 names, with "and N more" (**Review Focus #3**).
  - The text shown with a Copy button.
  - Open folder / Reveal.
- **Hostile strings.** All peer strings are rendered as text with `dir="auto"` and `unicode-bidi: isolate` (**Review Focus #4**).
- [ ] **Step 1: Write the failing test** `e2e/send.spec.ts`.
  - Two app instances (temp homes and inboxes, ports 0).
  - Under `MESHDROP_TEST`, a test-only IPC `meshdrop:test:setPicked` makes `pickFiles` return given paths.
  - Flow:
    1. In A: "Add by address" with B's port, then the same in B for A.
    2. Select B, "Add files" (one 3 MiB file), Send.
    3. A's Transfers page shows `Done`.
    4. B's Inbox shows the file name.
  - A peer alias `<b>x</b>‮` renders as literal text: `innerText` contains `<b>x</b>` and no `<b>` element exists.
  - The Inbox shows "and 1995 more" for a 2000-file record injected through `MESHDROP_TEST` history seeding.
- [ ] **Step 2:** Run `pnpm desktop:build && pnpm desktop:e2e`. Expected: it fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun 3×. Expected: green each time.
- [ ] **Step 5:** Commit with the message `feat(desktop): devices, transfers and inbox pages`.

### Task 9: Mesh UI

**Files:** Create `src/renderer/pages/Mesh.tsx` and `components/QrInvite.tsx`. Test: `e2e/mesh.spec.ts`.

**Behaviour:**
- **Not in a mesh:** a "Create a mesh on this PC (make it the hub)" button (`hubInit([])`) and a "Join with an invite" box (paste a URI).
- **In a mesh:**
  - Role, list version, hub link status, and the hub URLs (editable by the hub only, validated per Task 5).
  - "Invite a device": a QR image, the URI with a Copy button, and a live 5:00 countdown. When it expires the QR greys out and "New invite" appears.
  - The members list. The hub can Revoke, with a confirmation dialog that names the device.
  - Recovery (hub only): "Export recovery file" (save dialog, passphrase entered twice, minimum 10 characters) and "Import recovery file" (only when this device is in no mesh).
- [ ] **Step 1: Write the failing test** `e2e/mesh.spec.ts`.
  - Two instances. In A: Create mesh, then Invite. Read the URI from the Copy field.
  - In B: Join, paste it. Both Mesh pages show 2 members within 10 s.
  - In A: revoke B and confirm. B's Mesh page shows "Not in a mesh" within 10 s.
  - The QR `<img>` has a `data:image/svg+xml;base64,` source.
  - Under `MESHDROP_TEST_INVITE_TTL_MS=500`, the countdown reaches 0:00 and "New invite" appears.
- [ ] **Step 2:** Run e2e. Expected: it fails.
- [ ] **Step 3:** Implement. Main renders the QR with `qrcode.toString(uri, {type:'svg', margin:1})`.
- [ ] **Step 4:** Rerun 3×. Expected: green each time.
- [ ] **Step 5:** Commit with the message `feat(desktop): mesh page — create, invite QR, join, members, revoke, recovery`.

### Task 10: Tray, background, notifications, clipboard, autostart

**Files:**
- Create: `src/main/desktop.ts`, `src/renderer/components/ClipboardPicker.tsx`, `src/renderer/pages/Settings.tsx`.
- Modify: `src/main/main.ts`.
- Test: `test/desktop.test.ts`, `e2e/tray.spec.ts`.

**Interfaces and behaviour:**
- `autostartFile(execPath: string): string` returns the `~/.config/autostart/io.github.hafijbge.meshdrop.desktop` contents: `Exec=<execPath> --hidden`, `X-GNOME-Autostart-enabled=true`. `setAutostart(on: boolean)` writes or deletes that file.
- `gnomeShortcutCommands(binding: string, execPath: string): string[][]` returns the `gsettings` argv lists that add a custom keybinding `MeshDrop: send clipboard` running `<execPath> --send-clipboard`. The binding defaults to `<Primary><Alt>c`. Existing custom keybindings are kept: the list is read first and appended to.
- **Single instance.** `app.requestSingleInstanceLock()`. A second launch with `--send-clipboard` opens the small always-on-top picker window, which reads the clipboard while focused (GNOME/Wayland only lets a focused window read it). The picker lists online devices, with the last choice preselected; Enter sends and Esc closes. Any other second launch focuses the main window.
- **Tray.** The icon menu has: Open MeshDrop, Send clipboard…, Pause receiving / Resume receiving, Quit.
  - With `closeToTray`, closing the window hides it and the engine keeps running.
  - `--hidden` (autostart) starts with no window.
- **Quit.** "Quit" stops the controller (sends end `cancelled`, kept for auto-resume), then exits.
- **Notifications.** For received files (click reveals), received text/clipboard ("Copied text from <alias>"), held delivered or failed, and revoked.
- **Settings page.** Every `Settings` field, plus "Set up keyboard shortcut" (runs the gsettings commands after a confirm showing the exact binding) and "Open config folder".
- [ ] **Step 1: Write the failing tests:**
  - `desktop.test.ts`:
    - `autostartFile('/opt/MeshDrop/meshdrop-desktop')` contains `Exec=/opt/MeshDrop/meshdrop-desktop --hidden`.
    - `gnomeShortcutCommands` with an existing `['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/']` appends `custom1` and keeps `custom0`.
  - `e2e/tray.spec.ts`:
    - Launch A. Launch a second process with `--send-clipboard` (same `MESHDROP_HOME`). A window titled `Send clipboard` appears in A (assert via `electronApp.windows()`), and the second process exits 0.
    - **Review Focus #2:** with `closeToTray:true`, closing the main window leaves the app running and receiving (a file sent from a CLI peer still lands in the inbox). With a send in progress, `app.quit()` leaves an outbox entry, and after relaunch with the receiver present the entry completes on its own.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter desktop vitest run && pnpm desktop:e2e` 3×. Expected: green each time.
- [ ] **Step 5:** Commit with the message `feat(desktop): tray, background mode, notifications, clipboard picker, autostart`.

### Task 11: Packaging (.deb), CLI in the package, docs

**Files:**
- Create: `apps/desktop/electron-builder.yml`, `packaging/icon/make_icon.py`, `apps/desktop/build/icons/*.png` (generated and committed), `apps/desktop/build/meshdrop` (the CLI wrapper).
- Modify: `packaging/systemd/meshdrop.service`, `docs/protocol.md` ("Running the hub"), and `README.md` (create it if missing: install, first run, CLI).

**Values:**
- `electron-builder.yml`:
  - `appId: io.github.hafijbge.meshdrop`, `productName: MeshDrop`, `linux.target: deb`, `linux.category: Network;FileTransfer`;
  - `linux.executableName: meshdrop-desktop`, `deb.packageName: meshdrop`;
  - maintainer `Hafij-BGE <mdhafijur.rahman@ogr.deu.edu.tr>`, `linux.icon: build/icons`;
  - `extraResources` holds `cli.cjs` (the core CLI bundled by `vite.main.config.ts` as a third entry).
  - `deb.afterInstall` installs `/usr/bin/meshdrop`, a shell wrapper: `ELECTRON_RUN_AS_NODE=1 exec /opt/MeshDrop/meshdrop-desktop /opt/MeshDrop/resources/cli.cjs "$@"`.
- **Icon:** `make_icon.py` uses PIL to draw a rounded square in `#3b82f6` with two white opposing arrows, at 512/256/128/64 px.
- **systemd:** `ExecStart=/usr/bin/meshdrop listen --device-type headless`. Document `%h/.local/bin/meshdrop` for source checkouts.
- [ ] **Step 1: Write the failing verification script** `apps/desktop/scripts/check-deb.sh`. It builds, then asserts all of:
  - `dpkg-deb -c` lists `opt/MeshDrop/meshdrop-desktop`, `opt/MeshDrop/resources/cli.cjs`, `usr/share/applications/meshdrop.desktop` and icons;
  - `dpkg-deb -I` shows `Package: meshdrop` and the maintainer line;
  - `ELECTRON_RUN_AS_NODE=1 <unpacked>/opt/MeshDrop/meshdrop-desktop <unpacked>/opt/MeshDrop/resources/cli.cjs id --home <tmp>` prints `device id:`.
- [ ] **Step 2:** Run `bash apps/desktop/scripts/check-deb.sh`. Expected: it fails (no build config).
- [ ] **Step 3:** Implement. Build into a scratch directory (dpkg-deb dislikes NTFS permissions if the repo moves there; see the Draco notes) and copy the `.deb` to `apps/desktop/dist-deb/`, which is git-ignored.
- [ ] **Step 4:** Run the script. Expected: it passes. Then run `pnpm test`, `pnpm --filter desktop vitest run` and `pnpm desktop:e2e`. Expected: all green.
- [ ] **Step 5:** Commit with the message `feat(desktop): .deb packaging with bundled CLI, icon, docs`.
- [ ] **Step 6 (manual, with the owner):** install the `.deb` (`sudo apt install ./apps/desktop/dist-deb/meshdrop_*.deb`). This needs the owner's approval to run sudo. Then launch from the app grid, create or join the mesh, send to a phone or the CLI, and check the tray, notifications and the clipboard shortcut. Record the results.

---

## Milestone roadmap (updated)

| # | Milestone | Status |
|---|---|---|
| M1 | Protocol + Node core | done |
| M2 | Hub | done (`main` ff77f47) |
| M3 | Ubuntu desktop app | this plan |
| M4 | Android app | Reuses `apps/desktop/src/renderer` + `src/shared/api.ts` in a WebView with a Java `DesktopApi` bridge, implementing `docs/protocol.md` and every vector. |
| M5 | Guest tier + internet reach (tunnels to ingress `127.0.0.1:53319`) | |
| M6 | LocalSend v2 interop | |
| M7 | Release: GitHub repo, CI (vitest + Playwright e2e under xvfb-run + Android smoke), App Hub catalog entries; Windows NSIS target | |
