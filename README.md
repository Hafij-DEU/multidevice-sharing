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
   (`192.168.1.20:53318`) on both sides to pair it without a mesh. Both screens then show the same
   6-digit pairing code: pair only if they match (a different code means another device is in between).
4. Devices: tick one or more devices (or **All devices**), drop files or folders, press **Send**. Received
   files land in `~/Downloads/MeshDrop`.

Closing the window keeps MeshDrop running in the tray, so it keeps receiving. Settings has autostart at
login and a GNOME keyboard shortcut (default Ctrl+Alt+C) that sends your clipboard. The shared clipboard
carries text, copied images and copied files.

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
   and on the PC add the phone the same way. Check that both show the same pairing code.
4. Send from Devices (Add files / Add folder / Text), from any app's Share menu, or send the clipboard
   with the notification's "Send clipboard" button or the quick-settings tile. Received files land in
   `Download/MeshDrop`.
5. Away from home: join the mesh. On the PC, Mesh → "Invite a device" shows a QR code. Scan it with the
   phone's camera (or Google Lens): it opens MeshDrop's Mesh page with the invite filled in; tap Join.
   You can also paste the invite there. The phone then keeps a link to the hub and reaches your other
   devices through it when they are not on the same Wi-Fi; files for a device that is off wait on the
   hub until it comes back. Creating the mesh, inviting, revoking and recovery stay on the PC.

## LocalSend

People using the LocalSend app on the same Wi-Fi show up on Devices as "LocalSend". You can send them
files and text; their app asks them first. When they send to this PC, MeshDrop asks you (Accept or
Decline) before saving anything. MeshDrop speaks LocalSend protocol v2 on port 53317 (HTTPS, multicast
224.0.0.167). If the LocalSend app itself runs on this PC, it keeps that port and MeshDrop leaves
LocalSend to it. Android support for LocalSend comes later.

## Reach your PC from anywhere

On the hub PC: Mesh → Internet access. "Check my connection" tells you whether your provider gives you a
public address or shares it (CGNAT), and suggests a way in:

- **Tailscale Funnel**: free account, no domain. Install Tailscale, run `sudo tailscale up`, allow Funnel
  for this PC in the Tailscale admin console, then pick it here.
- **Cloudflare tunnel**: needs a domain in your Cloudflare account. Install `cloudflared`, run
  `cloudflared tunnel login` once, then enter a hostname such as `drop.example.com`.
- **Port forwarding**: only with a public IP (not behind CGNAT). Make a free name at duckdns.org and
  enter it with its token. MeshDrop gets a Let's Encrypt certificate (DNS check through DuckDNS, so
  no port 80 needed), and asks your router to forward port 443 (UPnP or NAT-PMP). Or tick "I forwarded
  the port myself" and forward TCP 443 to the port it shows.

The address it gets becomes the hub's internet address: your devices use it when they are away, and
internet links point at it. From a terminal: `meshdrop hub reach detect`, `meshdrop hub reach tailscale`,
`meshdrop hub reach cloudflare HOST`, `meshdrop hub reach port-forward NAME --token-file F [--manual]`,
`meshdrop hub reach off` (applied by the running `meshdrop listen`).

### A hub that is always on (relay hubs)

When the hub PC is off, a **relay hub** keeps things going: sends over the internet, files waiting for an
offline device, and internet links. A relay hub is one of your mesh devices that is always on, such as a
cheap VPS or a second PC, reachable at a public `wss://` address.

1. On the always-on machine: `meshdrop join <invite>` (an invite from the hub PC), then run
   `meshdrop listen` as a service. Put a TLS proxy or tunnel in front of its loopback port 53319
   (`--ingress-port N` to change it), for example Caddy with `reverse_proxy 127.0.0.1:53319`.
2. On the hub PC: Mesh → Relay hubs, enter that device's address (`wss://relay.example.com/mesh/v1/hub`),
   Save. Or `meshdrop hub relays <device-id-prefix>=wss://relay.example.com/mesh/v1/hub`.

Every device gets the list (signed by the hub PC). While the hub PC is away they link to the relay; they
move back to the hub PC within 5 minutes after it returns, and fetch anything the relay held for them.
A relay never holds the mesh key: adding or removing devices still needs the hub PC.

## Folder sync and photo backup

**More → Sync** keeps folders the same on your devices whenever they are on the same Wi-Fi. Add as many folders as you like (the PC suggests `~/MeshDrop Sync`; on the phone you pick them), not your working folders. Folders match by name: give a folder the same name on each device (it starts as the folder's own name). Tick the devices to sync each folder with, on both devices.

- Adds, edits and deletes travel both ways. A file that changed on both sides keeps both versions: the newer one keeps the name, the other becomes "name (conflict from <device> <time>)".
- A file deleted or replaced on another device is kept in that synced folder's `Deleted` folder (same path), so an accidental deletion loses nothing. `Deleted` is not synced; empty it yourself.
- Sync never goes through the hub: only on the LAN.

**Photo backup** (Android, on the same page): new camera photos and videos go to your PC by themselves while both are on the same Wi-Fi. They land in `~/Pictures/MeshDrop Backup/<phone name>/` on the PC.

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

**Internet links**: Guests → Internet links → choose files, how long the link works
(1 hour to 30 days), an optional password and download limit, and whether they may send files back.
The files are encrypted on your PC; the key is the part of the link after `#`, which browsers never
send to a server, so the hub's disk and any tunnel only see ciphertext. "Remove" ends a link at once.
The link uses the hub's internet address (see "Reach your PC from anywhere"). Phones and other member
devices make links too: the files are encrypted on that device and the hub PC (or a relay hub, while
the PC is off) keeps only the ciphertext. Links made on a member cannot take files back.
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
meshdrop hub init / invite / join / members / hub revoke / hub relays / hub recovery-export
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
