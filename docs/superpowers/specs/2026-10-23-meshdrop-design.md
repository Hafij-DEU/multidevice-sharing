# MeshDrop — design

Date: 2026-10-23. Status: draft for approval. "MeshDrop" is a working name (Claude's call); rename freely.

## 1. Intent

The owner (Md Hafijur Rahman) wants one connected system for moving files between any of his devices, at home or away, without ads, accounts, caps or a third-party cloud. It is more than an app: his Linux PC also acts as the server ("hub") that lets devices reach each other over the internet. Family and friends join without installing anything by scanning a QR code that opens a browser page.

No existing app covers this combination. LocalSend is LAN-only, KDE Connect has no internet path or guest tier, PairDrop is browser-only and weak on big files, Syncthing syncs folders rather than sending files, and AirDroid/SHAREit carry ads, paywalls and a record of security flaws.

## 2. Users and tiers

- **Owner tier (app):** today one Ubuntu PC and three Android phones (stock Android, Tecno HiOS, Xiaomi MIUI/HyperOS). The devices are paired once and stay a trusted group. They can send to each other directly with no prompt.
- **Guest tier (browser):** family or friends scan a QR code shown on any owner device. A web page opens where they can send files to that owner device and download files the owner offers. The guest sees nothing else: no other devices and no files.

## 3. Goals for v1

Numbers refer to the feature menu agreed in chat.

1. **LAN discovery and direct encrypted transfer** between owner devices.
2. **Pair-once device mesh.** Pairing is done by QR code. A device's identity is the hash of its own certificate, and peers pin it (Syncthing model).
3. **Auto-accept from own devices.** Anything else (guests, LocalSend peers) needs an accept prompt that shows a preview: file names, sizes and a thumbnail where possible.
4. **Internet path through the hub** (the owner's PC). The PC is reachable in one of two ways, chosen in Settings:
   - (a) a tunnel that gives an HTTPS URL, with no router changes;
   - (b) port forwarding on the router, when the ISP gives a public IP.

   The app should detect which of these works and suggest it.
5. **Guest QR → browser page** to send and receive. The QR carries a one-time session secret.
6. **Resumable transfers** using chunked files with a per-chunk SHA-256. Resume works after a network drop, an app restart, or a switch between LAN and internet paths.
7. **Folders, multi-file and text messages** (text shows up as a copyable message).
8. **LocalSend protocol v2 compatibility on the LAN.** LocalSend users show up as untrusted peers and can send to the owner, and the owner can send to them.
9. **Clipboard sharing** between owner devices, within the platform limits in §8.
11. **Held files on the hub.** The owner can send to a device that is offline. The hub keeps the file and delivers it when that device reconnects.
12. **Internet guest links** with an expiry, an optional password and a download-count limit. The decryption key sits in the URL fragment, so the hub stores and relays only ciphertext.
14. **Multi-send.** The owner picks devices or "All devices". The file goes to each of them in parallel, with separate progress, and a failure on one does not stop the others.

## 4. Non-goals for v1 (later)

The following are not in v1:
- notification mirroring (menu item 10);
- remote file browsing (menu item 13);
- continuous folder sync;
- hotspot or Wi-Fi Direct with no router;
- Quick Share interop;
- iOS and macOS;
- a VPS hub.

The hub code should not assume it runs on the owner's PC, so it can later be deployed to a VPS unchanged.

Direct device-to-device connections over the internet (hole punching) are also out of v1. Over the internet, traffic always passes through the hub. This is Claude's call, made because Node/Java hole punching is a large, fragile piece of work. The protocol should leave room to add it later.

## 5. Anti-goals

The system fails, even if it technically works, if any of these happen:
- ads, an account system, size caps, or telemetry;
- home-made crypto. Use standard TLS, standard AEAD such as AES-GCM via platform APIs, and a standard PAKE or random token for pairing;
- a guest gaining any view of the owner's other devices or files;
- the phone app being silently killed in the background by MIUI/HyperOS or Tecno, so devices "disappear";
- a big transfer (several GB of video) failing or restarting from zero after a hiccup.

## 6. Platforms

Priority order:

1. **Ubuntu 26.04 LTS** (the owner's PC; GNOME on Wayland).
2. **Android:**
   - stock Android;
   - Tecno HiOS;
   - Xiaomi MIUI / HyperOS.

   minSdk 26, targetSdk 35, matching the owner's other apps.
3. **Windows 11.** Not a priority now. The design must not block it, and the code must not use Linux-only APIs in shared paths without an abstraction.

## 7. How it is built (decided)

These choices are Claude's calls. They follow the toolchain the owner already uses: Vite/TS → Electron .deb, and a plain-Java WebView APK built offline with Gradle 8.11.1 and AGP 8.7.3. The NDK is not installed.

- **One UI codebase** (Vite + TypeScript), used in three places:
  - the Electron desktop renderer;
  - the Android WebView, talking to Java through a JS bridge;
  - a trimmed **guest build** that the device showing the QR serves to browsers.
- **Desktop engine** in Node, inside the Electron main process. It covers:
  - discovery;
  - transfers;
  - the LocalSend v2 server and client;
  - the **hub**: relay, held-file store, guest-link store, and the device directory with online state and current addresses.

  The hub is a separable module. It can run headless (`meshdrop --headless`, systemd user service) as well as inside the GUI app.
- **Android engine** in plain Java (no Kotlin, no NDK), running in a foreground service. It has the same responsibilities as the desktop engine, minus the hub.
- **One written protocol spec** (`docs/protocol.md`), implemented by both engines. A shared set of JSON/binary test vectors is run against both. The spec is written before either engine.
- **Distribution:**
  - Linux .deb via electron-builder (maintainer Hafij-BGE as in other projects).
  - A signed APK with its own key in `~/.android`.
  - Listed in the owner's App Hub (Linux) and App Hub Android catalog, so MIUI's adb-install restriction doesn't matter.
  - Windows NSIS later.
  - Repo `Hafij-DEU/meshdrop`, GPL-3.0 (Claude's call, matching Astra). No GPL code is copied from PairDrop or KDE Connect; they are used as references only.

## 8. Behaviour details (decided)

**Identity and pairing**
- Each device generates a long-lived key pair and a self-signed certificate on first run. Its device ID is the SHA-256 of the certificate.
- To pair, the existing device shows a QR code with: hub URL(s), LAN address, its device ID, and a one-time pairing secret (128-bit random, 5-minute expiry). The new device scans it, both sides exchange certificates under that secret, and each pins the other.
- **Membership authority (Claude's call):** the hub PC holds a mesh root key, and the membership list is a versioned list signed by that root key.
  - Any owner device can show a pairing QR, but the new device becomes a full member only once the hub signs it in. Until then, it can talk only to the device that paired it, over the LAN.
  - Only the hub can revoke a device. The owner revokes a lost phone from the PC.
  - Every device caches the latest signed list and rejects peers that are not on it.
  - A revoked device learns of its revocation on its next hub contact. Other devices learn as soon as they fetch the new list version.
- **Root key backup:** on first run, the hub offers to export an encrypted recovery file protected by a passphrase. With it, a reinstalled hub restores the same mesh. Without it, every device must pair again, and the app says so plainly.

**End-to-end encryption between owner devices (Claude's call)**
- The hub and any tunnel provider must never see owner file contents. Cloudflare terminates TLS at its edge, and a future VPS hub should not need to be trusted, so TLS alone is not enough.
- Each pair of owner devices agrees on keys with ECDH P-256 using their pinned device keys. P-256 is chosen because X25519 is not available on Android API 26.
- Each chunk is encrypted with AES-256-GCM before it leaves the sender, on both LAN and hub paths. Resume and integrity checks use hashes of the ciphertext chunks.
- Held files are stored encrypted to the target device, so the hub keeps only ciphertext.
- Hub authentication:
  - Owner devices authenticate to the hub with a signed challenge from their device key. This works the same behind a tunnel's public certificate.
  - On the LAN or in port-forward mode, devices also pin the hub's own certificate.
  - In tunnel mode, devices accept the tunnel's public certificate and rely on the signed challenge plus E2E encryption.

**Hub connection while away (Claude's call)**
- Phones on Wi-Fi or mobile data keep one WSS connection to the hub, held by the same foreground service that listens on the LAN.
- The connection sends a heartbeat about every 4 minutes, with backoff on failure. The hub pushes "incoming transfer" over this connection, so sending to a phone that is out is live whenever its service is alive.
- There is no FCM or other Google push. It would put a third-party cloud in the path and needs Play services.
- Held files are used only when the target is truly unreachable.

**LAN discovery** uses three methods, combined:
- mDNS/DNS-SD;
- UDP multicast announce (LocalSend-compatible on 224.0.0.167:53317 for LocalSend peers);
- the hub's directory, which knows each device's last LAN address.

For networks that block multicast, there is a fallback: a manual IP and a "scan subnet" button. Android must take a `WifiManager.MulticastLock` while discovering.

**Transport**
- Owner-to-owner traffic uses mutual TLS with pinned certificates on both sides.
- Files move as chunks (4 MiB default) with a SHA-256 per chunk.
- The receiver keeps a resume manifest, and senders ask "what do you have?" before sending.
- Over the internet the path is: device → hub (HTTPS/WSS) → device, or device → hub store when the target is offline.
- Chunked uploads are required anyway, because Cloudflare limits proxied request bodies to 100 MB on its free plan.

**Path choice:** LAN when both devices are on it; otherwise the hub. Switching paths mid-transfer resumes from the last verified chunk.

**Held files**
- Files are stored under a configurable hub directory.
- Default expiry is 7 days, with a total quota setting.
- Held files are delivered the next time the target device connects to the hub.

**Guest tier**
- **LAN guests:** the page is served over plain HTTP, because browsers reject self-signed certificates. Access is gated by the one-time token in the QR. This is the same trade-off LocalSend and Xender make, and it is accepted.
- **Internet guests:**
  - Links go through the hub's HTTPS URL, with the key in the URL fragment and AES-GCM via WebCrypto in the browser.
  - Each link has an expiry, an optional password and a download cap.
  - The owner can revoke links.
  - Uploads from guests land in the owner device's inbox, and the owner is prompted to accept them.

**Clipboard** (platform limits are real):
- Android 10+ forbids background clipboard reads. Sending the phone's clipboard is therefore an explicit action: a quick-settings tile, a notification button, or "Share → MeshDrop". Receiving into the phone's clipboard works in the background.
- GNOME on Wayland does not let unfocused apps read the clipboard. On Ubuntu, sending is explicit: a tray action plus a global shortcut where available. Receiving works.

**Multi-send:** one session per target, all running in parallel. The UI shows a per-device progress row and per-device retry.

**Received files**
- Android: `Download/MeshDrop/` via MediaStore on API 29+, or legacy storage permission on API 26–28.
- Desktop: `~/Downloads/MeshDrop/`.
- Both locations can be changed in Settings.

**Hub reachability**
- **Tunnel mode:** the app manages a tunnel client (cloudflared or Tailscale Funnel; see open questions).
- **Port-forward mode:** the hub listens on a configurable port. UPnP/NAT-PMP is tried first, then manual. The app also needs a stable name (a dynamic-DNS name) and a real certificate for guest browsers (Let's Encrypt). Owner devices do not need a real certificate, because they pin the hub's own certificate.
- Both modes can be enabled at the same time, and devices try each URL they know.

## 9. Android OEM constraints

Stock Android, HiOS and HyperOS all kill background apps. The aim is that devices stay reachable.

- **Foreground service** with a persistent, low-priority notification. Android 15 caps `dataSync` foreground services at 6 h per 24 h for targetSdk 35. The always-listening service must therefore use a type that has no such cap (likely `connectedDevice`, which needs `CHANGE_WIFI_MULTICAST_STATE` / `CHANGE_NETWORK_STATE`). Active transfers may use a separate type. The builder must verify both choices on API 35.
- **First-run "Keep MeshDrop alive" checklist**, which detects the ROM and deep-links into the right screens:
  - Battery optimization: request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
  - MIUI/HyperOS: Autostart toggle, Battery saver → "No restrictions", and "lock app in recents".
  - Tecno HiOS: the Phone Master / auto-start manager and the background-freeze whitelist.

  Each entry has a fallback text guide for when an intent fails.
- **Reconnect when Wi-Fi changes**, using a `ConnectivityManager` network callback.
- **Hub as the backstop.** When the service has been killed, the phone reconnects to the hub on next launch, and the hub delivers anything held. Nothing is lost; it is only delayed.

## 10. Testing

- **Protocol test vectors** run in CI against both engines.
- **Node engine:** unit and integration tests, including an end-to-end run of two desktop engines plus a hub on localhost.
- **Android:**
  - an emulator smoke test in GitHub Actions (the pattern used in astra-player-android);
  - real-device checks on the three phones, done by the owner. Claude must ask before installing to an attached device.
- **Interop:** a test against a real LocalSend client.

## 11. Left to the builder

- Library choices within the stack. Prefer dependencies already cached offline; any new dependency must be justified.
- Exact wire format details beyond what is fixed above.
- UI layout and visual style. Keep it clean and modern, with no clutter.
- Chunk-size tuning.
- Database or storage format for the hub, provided it is a single file or directory that can be backed up.

## 12. Owner answers (2026-10-23)

1. **Tunnel provider:** support both providers, chosen in Settings.
   - **Tailscale Funnel:** free account, stable `*.ts.net` URL, no domain needed.
   - **Cloudflare named tunnel:** needs a Cloudflare account and a domain the owner owns.

   Quick tunnels (random URL on every restart) are not offered, because the URL change breaks paired devices. The app drives the installed `tailscale` or `cloudflared` CLI. It does not bundle them.
2. **Public IP:** the owner doesn't know whether the ISP gives a public IPv4 address. The hub detects it by comparing its router or UPnP WAN address with its public IP as seen from outside. If it finds CGNAT, it tells the owner that port-forward mode cannot work. Mode (b) is still built in full: UPnP/NAT-PMP or a manual port, dynamic DNS (DuckDNS first), and Let's Encrypt for guest browsers.
