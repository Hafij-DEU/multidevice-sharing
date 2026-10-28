# MeshDrop "No Wi-Fi" mode — design

Date: 2026-10-28. Branch: `m14-no-wifi`. Status: approved by the owner (relayed by the main session:
"if everything final, and all the thing like remote, file transfer etc work, then start").

## Why

The owner is often somewhere with no Wi-Fi router. Today MeshDrop devices only find each other on a
shared LAN or over the internet (hub relay, Tailscale Funnel). The owner wants the PC and phones to keep
working together with no router, and without spending mobile data.

## Goals

1. **Bluetooth links.** Paired devices (paired once in the system Bluetooth settings) talk over
   Bluetooth RFCOMM when no network path exists. Every existing feature that fits the bandwidth works
   unchanged: files, clipboard, app messages (remote input, media keys, notifications + reply, find my
   device, PC actions, phone status), handoff, receipts.
2. **Sound over Bluetooth** with Opus (PC sound to a phone, phone sound to the PC, phone mic to the PC,
   PC to PC). Raw PCM (1.5 Mbit/s) does not fit.
3. **Automatic choice.** Per device: Auto (default), Wi-Fi only, Bluetooth only. A global switch
   "Everything over Bluetooth". Auto order is LAN, then Bluetooth, then the hub (internet). Auto falls
   back to Bluetooth by itself when the LAN path is gone and switches back when the LAN returns.
4. **Hotspot from the app** for full speed (camera, fast files): a phone starts a local-only hotspot
   (or the PC starts one); credentials go to the other devices over the Bluetooth link, or by a Wi-Fi QR,
   or by typing. Devices then use the normal LAN path.
5. **Never use mobile data.** The local-only hotspot shares no internet. The PC never routes internet or
   DNS through a phone hotspot or USB tether (setting, on by default). Phones that join a MeshDrop
   hotspot keep their own mobile data for everything else.
6. **Gates, not silent failures.** A feature that cannot fit Bluetooth (camera) says so.

## Non-goals

- Bluetooth pairing inside MeshDrop (system settings do it; MeshDrop links to them).
- Bluetooth Low Energy, Wi-Fi Direct groups, A2DP audio routing.
- Phone-to-phone live sound (does not exist on Wi-Fi either: only the Node mesh server serves streams).
- Webcam QR scanning on the PC (typed password is the fallback).

## Anti-goals

- Any path where a Bluetooth stranger gets more than the unauthenticated `GET /mesh/v1/info`.
- Mobile data spent by MeshDrop's no-Wi-Fi features.
- Breaking the LAN or hub paths.

## Design

### 1. Bluetooth link = byte-stream tunnel (transport-agnostic)

A link is one RFCOMM socket between two devices carrying a small multiplexer ("btmux v1"). Each side
exposes a local TCP listener on `127.0.0.1:<ephemeral>` per link. A TCP connection to it becomes a mux
stream; the far side connects that stream to its own mTLS mesh port. All existing code (pinned mTLS,
HTTP, HPKE) runs unchanged inside the tunnel, so identity and trust stay exactly as on the LAN.

Security: the mesh port trusts only the TLS client certificate (checked: no loopback/LAN exemption on
the mesh port). The tunnel only ever forwards to the mesh port, never to the guest, LocalSend, hub
ingress or handoff ports. RFCOMM sockets are the secure (authenticated + encrypted) kind, so only
bonded devices connect.

Frame (big-endian): `u8 type | u32 stream | u32 len | payload[len]`, len <= 16384.

| type | name | payload |
|---|---|---|
| 0 | HELLO | JSON `{"v":1,"id":"<deviceId>"}` (each side once, first frame) |
| 1 | OPEN | `u8 flags` (bit0 = priority) |
| 2 | DATA | bytes |
| 3 | END | empty (half-close: no more data from the sender; the stream is gone once both sides sent END) |
| 4 | CREDIT | `u32` bytes the receiver consumed |
| 5 | PING / 6 PONG | empty |
| 7 | RESET | empty (abort the stream at once, both ways) |

- Stream ids: the side that dialled the RFCOMM link uses odd ids, the other even ids.
- Flow control: each stream may have 256 KiB unacknowledged; the receiver returns CREDIT as its local
  socket drains. A slow consumer stalls only its own stream.
- Fair writer: one writer queue; priority streams (live sound) are sent before others; data is cut
  into <= 4 KiB DATA frames so sound interleaves with a running file transfer.
- Keepalive: PING every 15 s; link closed after 45 s silence.
- HELLO `id` is a claim, used only to map the Bluetooth address to a device; the TLS inside proves the
  identity. A link whose HELLO names an untrusted device is closed.
- Wire vectors in `protocol/vectors/btmux-v1.json`; Node and Java both test against them.

Each link exposes two local ports: normal and priority. Live streams dial the priority port.

### 2. Link manager (Node core + Java engine, same logic)

Platform interface: `bonded()` (paired phones/computers that offer the MeshDrop service UUID
`6d657368-6472-6f70-0001-000000000001`), `dial(address)`, `onIncoming(cb)`. Address-to-device map is
learned from HELLO and saved (`bt-peers.json`).

Policy per trusted device, mode = settings `allBluetooth ? 'bt' : deviceLinks[id] ?? 'auto'`, and only
when `bluetooth` (master switch, default on) is true:

- `wifi`: never Bluetooth.
- `bt`: keep a Bluetooth link up; route always uses it (never LAN). If no link, the send waits/queues
  as for an offline device.
- `auto`: when the device is not seen on the LAN, dial Bluetooth (backoff 10 s to 2 min, devices of
  audio/peripheral class skipped). When the LAN returns, new traffic goes LAN at once and the idle
  Bluetooth link closes after 60 s.

`route()` order: LAN (unless mode `bt`) -> Bluetooth link (unless mode `wifi`) -> on-demand Bluetooth dial
(up to 8 s, auto/bt) -> hub relay/held (unless mode `bt`) -> unreachable. A Bluetooth route is
`{kind:'lan', host:'127.0.0.1', port, via:'bt'}` so every caller works. `devices()` reports reach
`'bt'`. Sync, membership pull and other LAN-only extras stay LAN-only.

### 3. Platforms

- **Ubuntu PC:** Python helper (`python3-gi`, already a recommended dependency) registers a BlueZ
  `ProfileManager1` profile with the MeshDrop UUID (RequireAuthentication), dials with
  `Device1.ConnectProfile`, and relays each connection's fd to a Unix socket owned by the Electron main
  process. Control is JSON lines on stdio. No sudo.
- **Android:** `BluetoothAdapter.listenUsingRfcommWithServiceRecord` / `createRfcommSocketToServiceRecord`
  in the app module, behind the engine's platform interface. Permission `BLUETOOTH_CONNECT` (API 31+,
  asked when the user turns Bluetooth links on), legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` up to API 30.

### 4. Sound over Bluetooth (Opus)

When the stream route is Bluetooth, sound uses Opus in RTP, framed per RFC 4571 (u16 length + RTP
packet, payload type 96, 48 kHz clock, 20 ms frames). Content type `audio/opus-rtp; channels=N`.
Bitrates: stereo 96 kbit/s, mic mono 32 kbit/s. GET `/mesh/v1/stream/audio?codec=opus` asks the PC to
send Opus.

- PC encode/decode: `gst-launch-1.0` (`opusenc ! rtpopuspay ! rtpstreampay` / `rtpstreamdepay !
  rtpopusdepay ! opusdec`) as a transform between the existing raw PCM capture/sinks, so the
  live-latency trimming (`liveAudio`) still applies.
- Android: `MediaCodec` Opus encoder/decoder (API 29+); RTP/RFC 4571 framing in the engine (pure Java,
  unit tested). If the phone lacks an Opus encoder, sending sound over Bluetooth is refused with a
  message.
- Camera over Bluetooth is refused: "Camera needs Wi-Fi or a hotspot - this device is connected over
  Bluetooth." Watch party stays LAN-only (unchanged).

### 5. Hotspot

- **Phone hosts:** "Start hotspot" (More -> No Wi-Fi) calls `WifiManager.startLocalOnlyHotspot` (no
  internet sharing) while MeshService runs. The screen shows a Wi-Fi QR (`WIFI:T:WPA;S:..;P:..;;`), the
  SSID and password. The phone sends app message `{type:'hotspot', ssid, psk, hosts:[ip:port]}` to every
  device it has a Bluetooth link to. Permissions: `NEARBY_WIFI_DEVICES` (API 33+) or fine location
  (API 29-32), `CHANGE_WIFI_STATE`.
- **PC hosts:** "Start hotspot" runs `nmcli device wifi hotspot` (only when the PC Wi-Fi is not
  connected to a network, else it asks first) with a random SSID/password, shows the QR, sends the same
  message.
- **PC joins** (on the message, or by picking an SSID and typing the password): `nmcli connection add`
  a private (`connection.permissions user:<me>`), non-autoconnect profile with
  `ipv4/ipv6.never-default yes` and `ignore-auto-dns yes`, then `up`. It does not leave a connected
  Wi-Fi without asking.
- **Phone joins** (on the message after a prompt, or by scanning the QR in MeshDrop):
  `WifiNetworkSpecifier` request (system dialog), then MeshDrop binds its own process to that network
  so other apps keep mobile data.
- **Discovery:** multicast works as usual; the handoff also carries `hosts`, which the joiner probes
  (manual peer) in case the hotspot isolates multicast.

### 6. No mobile data on the PC (`tetherNoData`, default on)

The desktop polls NetworkManager every 10 s (and on `nmcli monitor` events). A device is a phone link
when NM reports `GENERAL.METERED` = `yes (guessed)` (Android DHCP hint), or its driver is
`rndis_host`/`cdc_ncm`/`cdc_ether`/`ipheth`, or its connection is MeshDrop's own hotspot profile. For
such a device MeshDrop runs `nmcli device modify <dev> ipv4.never-default yes ipv6.never-default yes
ipv4.ignore-auto-dns yes ipv6.ignore-auto-dns yes` (runtime only, the saved profile is untouched) and
shows a note. Turning the setting off runs `nmcli device reapply <dev>` for every device it changed.

### 7. Settings and UI

New settings (desktop and Android): `bluetooth` (default true), `allBluetooth` (false), `deviceLinks`
(`{[deviceId]: 'auto'|'wifi'|'bt'}`, default `{}`); desktop only: `tetherNoData` (true).

- Device lists show "Bluetooth" reach.
- More -> Devices: per-device "Connection: Auto / Wi-Fi only / Bluetooth only".
- Settings -> "No Wi-Fi": Bluetooth links, Everything over Bluetooth, Don't use phone data (PC),
  Start hotspot / Join hotspot, and help: pair once in Bluetooth settings; USB tethering and
  Bluetooth tethering already give an IP link with no setup in MeshDrop.
- Remote page streams list includes Bluetooth devices; the camera button is disabled there with the
  gate message.

## Testing

- Node: btmux codec vs vectors, flow control/fairness, bridge end-to-end (two engines whose links run
  over a local socket pair instead of RFCOMM: file send, app message, stream), route policy table,
  RFC 4571 framing, nmcli command builders, settings validation.
- Java: btmux vectors, bridge loopback, policy, RTP framing, settings.
- Builds: `pnpm -r test`, `pnpm typecheck`, gradle `:engine:test`, `assembleRelease`.
- Hardware: the PC's BlueZ profile registration can be checked locally. PC <-> phone and phone <-> phone
  Bluetooth, hotspot and Opus playback need the APK on the phones (no installs without the owner's OK).

## Calls made by the builder (not discussed with the owner)

- Opus for every Bluetooth sound direction instead of A2DP for phone->PC: one code path, keeps
  MeshDrop's start/stop and consent, and works PC->phone where Android has no A2DP sink.
- PC can host the hotspot too (no phone data involved at all).
- No webcam QR on the PC; typed password instead.
- Hub relay stays allowed in Auto after Bluetooth fails; "Bluetooth only" never uses LAN or hub.
- Sync folders and membership pulls stay LAN-only.
