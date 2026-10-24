# MeshDrop

Send files, folders, text and your clipboard between your own devices: an Ubuntu PC and Android phones,
end-to-end encrypted. Devices on the same Wi-Fi talk directly. Away from home, they go through a hub that
runs on your own PC (reachable through Tailscale Funnel, a Cloudflare tunnel or a forwarded port). No
account and no third-party server.

Status: the core engine (M1), the hub (M2), the Ubuntu desktop app (M3) and the Android app (M4: the local
network, then joining the mesh by QR and sending through the hub) are done. The wire protocol is in
[docs/protocol.md](docs/protocol.md).

## Install (Ubuntu)

Build the package (Node 24 and pnpm 10):

```bash
pnpm install
pnpm --filter @meshdrop/desktop dist
```

Then install it:

```bash
sudo apt install ./apps/desktop/dist-deb/meshdrop_0.1.0_amd64.deb
```

The package installs the app (MeshDrop in the app grid, `/opt/MeshDrop`) and the `meshdrop` command line
in `/usr/bin`.

## First run

1. Open MeshDrop. Your PC appears under its host name (change it in Settings).
2. To link your devices through this PC: Mesh → **Create a mesh on this PC**, then **Invite a device** and
   scan the QR code with the phone app (or paste the link into another PC's Mesh page).
3. Devices on the same network also show up under Nearby. You can add one by address
   (`192.168.1.20:53318`) on both sides to pair it without a mesh.
4. Devices: tick one or more devices (or **All devices**), drop files or folders, press **Send**. Received
   files land in `~/Downloads/MeshDrop`.

Closing the window keeps MeshDrop running in the tray, so it keeps receiving. Settings has autostart at
login and a GNOME keyboard shortcut (default Ctrl+Alt+C) that sends your clipboard.

## Android

Android 10 or newer. Build the signed APK (needs the Android SDK in `~/Android/Sdk` and Gradle 8.11.1):

```bash
bash apps/android/scripts/release.sh
```

It writes `apps/android/dist-apk/MeshDrop-0.1.0.apk` (the signing key is created once in `~/.android`;
keep it, every update must be signed with it). Install it from the phone's file manager (MIUI blocks
`adb install`).

1. Open MeshDrop. It starts a background service with a small notification, so it keeps receiving.
2. Settings → "Keep MeshDrop alive": allow the battery exemption and notifications; on Xiaomi and Tecno
   phones also the Autostart steps.
3. Pair with the PC: on Devices, "Add by address" with the PC's address (shown in MeshDrop on the PC),
   and on the PC add the phone the same way.
4. Send from Devices (Add files / Add folder / Text), from any app's Share menu, or send the clipboard
   with the notification's "Send clipboard" button or the quick-settings tile. Received files land in
   `Download/MeshDrop`.
5. Away from home: join the mesh. On the PC, Mesh → "Invite a device" shows a QR code. Scan it with the
   phone's camera (or Google Lens): it opens MeshDrop's Mesh page with the invite filled in; tap Join.
   You can also paste the invite there. The phone then keeps a link to the hub and reaches your other
   devices through it when they are not on the same Wi-Fi; files for a device that is off wait on the
   hub until it comes back. Creating the mesh, inviting, revoking and recovery stay on the PC.

## Guests

Let a friend send you files from their phone's browser, no app needed. On the PC, open Guests →
"Show a guest QR code" and let them scan it on the same Wi-Fi. Their browser gets a page where they can
send you files and a message, and download files you offer ("Offer files…"). They see nothing else.

- Every send asks you first: you see the names, sizes and photo thumbnails, then Accept or Decline.
  Nothing is saved before you accept; accepted files land in your inbox.
- The link works for one browser only, for 1 hour by default (Settings → "A guest link works for",
  5 minutes to 24 hours). "End" stops it at once.
- The page is plain HTTP on your network (browsers reject self-signed certificates), so use it on Wi-Fi
  you trust.

**Internet links** (on the hub PC): Guests → Internet links → choose files, how long the link works
(1 hour to 30 days), an optional password and download limit, and whether they may send files back.
The files are encrypted on your PC; the key is the part of the link after `#`, which browsers never
send to a server, so the hub's disk and any tunnel only see ciphertext. "Remove" ends a link at once.
The link uses the hub's internet address (Mesh → Hub address); setting up a tunnel comes with M5c.
From a terminal: `meshdrop link create FILE... [--days N] [--passphrase-file F] [--max-downloads N]
[--allow-uploads]`, `meshdrop link list`, `meshdrop link revoke ID`.

From a terminal: `meshdrop guest [--share FILE]... [--minutes N] [--accept-all]`.

## Command line

```text
meshdrop id                         this device's id
meshdrop listen                     receive until Ctrl-C (or run it as a service, see docs/protocol.md)
meshdrop pair <host[:port]> <name>  trust a device by address (both sides)
meshdrop send <device|all> <path…>  send files or folders (--text "..." for text)
meshdrop outbox / resume            unfinished sends
meshdrop guest                      a guest QR link for a browser on this network
meshdrop hub init / invite / join / members / hub revoke / hub recovery-export
```

Every command takes `--home DIR` to use another config folder. `meshdrop --help` lists all options.

## Development

```bash
pnpm test               # core + desktop unit tests
pnpm typecheck
pnpm desktop:e2e        # builds the app and runs the Playwright Electron tests
pnpm desktop:dev        # build and start the app
cd apps/android && ~/.local/opt/gradle-8.11.1/bin/gradle --offline :engine:test   # Java engine + Node interop
bash apps/android/scripts/emulator-e2e.sh   # the APK on the emulator against the Node engine
```

License: GPL-3.0-only.
