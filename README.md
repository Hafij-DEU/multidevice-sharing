# MeshDrop

Send files, folders, text and your clipboard between your own devices: an Ubuntu PC and Android phones,
end-to-end encrypted. Devices on the same Wi-Fi talk directly. Away from home, they go through a hub that
runs on your own PC (reachable through Tailscale Funnel, a Cloudflare tunnel or a forwarded port). No
account and no third-party server.

Status: the core engine (M1), the hub (M2) and the Ubuntu desktop app (M3) are done; the Android app (M4)
is next. The wire protocol is in [docs/protocol.md](docs/protocol.md).

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

## Command line

```text
meshdrop id                         this device's id
meshdrop listen                     receive until Ctrl-C (or run it as a service, see docs/protocol.md)
meshdrop pair <host[:port]> <name>  trust a device by address (both sides)
meshdrop send <device|all> <path…>  send files or folders (--text "..." for text)
meshdrop outbox / resume            unfinished sends
meshdrop hub init / invite / join / members / hub revoke / hub recovery-export
```

Every command takes `--home DIR` to use another config folder. `meshdrop --help` lists all options.

## Development

```bash
pnpm test               # core + desktop unit tests
pnpm typecheck
pnpm desktop:e2e        # builds the app and runs the Playwright Electron tests
pnpm desktop:dev        # build and start the app
```

License: GPL-3.0-only.
