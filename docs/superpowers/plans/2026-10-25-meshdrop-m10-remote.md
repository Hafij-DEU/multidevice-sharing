# MeshDrop M10: Phone as Remote, Phone Status, Find My Phone, Link Handoff

> Lean mode, owner asleep ("check if you add all the things i asked, if not add all of them"). Native execution; GitHub CI checks the pushed branch `m10-remote`.

**Owner's list (2026-10-24):**
- phone as remote: touchpad, keyboard, media keys, volume;
- presenter mode: next/previous slide, laser dot;
- run PC actions: lock, sleep, shut down, open an app;
- phone notifications on the PC, and replying to them (SMS too);
- battery, signal and storage of the phone on the PC;
- find my phone (rings on silent);
- webcam + mic from the phone; audio cast PC → phone;
- link handoff both ways;
- screen mirror / second monitor: launch **Extendo**, do not build it.

## Transport: app messages

One route on the mesh API, `POST /mesh/v1/app`, with a JSON body `{kind, ...}` of at most 256 KiB. It is open only to trusted devices (paired or in the mesh), over the pinned LAN link or the hub's signed envelopes. The core engines only carry the messages (`appSend(deviceId, msg)` and `setAppHandler`). The apps decide what each kind does, per device.

| kind | to | body | answer |
|---|---|---|---|
| `input` | PC | `events: [{t:'move',dx,dy} \| {t:'button',b,down} \| {t:'click',b} \| {t:'scroll',dx,dy} \| {t:'text',s} \| {t:'key',k,mods?} \| {t:'laser',x,y,on}]` | `{ok}`; 403 `remote-off`; 503 `input-unavailable` |
| `action` | PC | `a: 'lock' \| 'sleep' \| 'shutdown' \| 'restart' \| 'open'`, `app?` | `{ok}`; 403 `remote-off` |
| `apps` | PC | — | `{apps:[{id,name}]}`; 403 `remote-off` |
| `ring` | any | `on: boolean` | `{ok}` |
| `status` | any | — | `{battery?:{level,charging}, storage?:{free,total}, signal?:{level,type}}` |
| `notify` | PC | `key, app, title, text, time, replyable` | `{ok}` |
| `notify-removed` | PC | `key` | `{ok}` |
| `reply` | phone | `key, text` | `{ok}`; 404 `gone` |
| `open-url` | any | `url` (http/https) | `{ok}`; 403 `handoff-off` |

`b` is `left`, `right` or `middle`. `k` is a key name from the list in `apps/desktop/src/main/keys.ts`. `x` and `y` are 0..1 of the screen.

## Decisions

- **PC input goes through the XDG RemoteDesktop portal**, which works on GNOME Wayland. The calls go from a Python GI helper (`apps/desktop/resources/meshdrop-input.py`, JSON lines on stdin).
  - The first use shows GNOME's "Allow remote interaction" dialog once. The portal's restore token is kept in `<home>/input-token` so it does not ask again.
  - Cost if wrong: there is no input on X11 sessions without the portal, and the UI says so.
- **Opt-in per device.** The PC lists the devices allowed to control it: Settings `remoteFrom: string[]`, empty by default. Ring, status, notifications and open-url work for every trusted device.
  - Open-url can be turned off: Settings `openLinks`, default on, http and https only.
  - Notifications on the PC: Settings `phoneNotifications`, default on.
- **Laser dot:** a transparent, click-through, always-on-top Electron window draws a red dot at (x, y).
- **Notifications:** an Android NotificationListenerService that the user turns on.
  - It forwards to the PCs picked in Settings (`notifyTo`).
  - Replies use the notification's own RemoteInput action. This covers SMS (Messages app) and chat apps, with no SMS permission needed.
- **Find my phone:** the phone plays the alarm sound at full alarm volume (USAGE_ALARM ignores silent mode) until Stop, or for at most 60 s.
- **Status:** battery from BatteryManager, storage from StatFs, signal from TelephonyManager when it is allowed. The PC asks every 60 s while the device is reachable.
- **Link handoff:**
  - PC → phone: the Send page's Text box gets "Open on device" when it holds a URL.
  - Phone → PC: Share a link to MeshDrop, then "Open on PC".
- **Extendo:** the phone's More → "Second screen (Extendo)" opens `io.github.hafijbge.extendo`, or its download page when it is not installed.
- **Deferred within M10 (own milestone M10b):** audio cast PC → phone, and webcam + mic from the phone. Both need a streaming channel (not request/answer), and a virtual camera needs v4l2loopback (root).

## Tasks

1. Core: app route and `appSend` / `setAppHandler` in both engines. Tests: Node ↔ Node; Java ↔ Node via the CLI.
2. Desktop: the input helper, a key map, the controller app handler (all PC kinds), settings, the laser window, and More → Remote ("Devices that may control this PC", "Ring", phone status, phone notifications with Reply).
3. Shared renderer: the Remote page (pick a device; touchpad, keyboard, media, volume, presenter, PC actions) and Find my device.
4. Android: ring, status, open-url, reply handlers; notification listener + settings; Extendo button.
5. Docs; push the branch.
