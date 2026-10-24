# MeshDrop M5a: LAN Guests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A friend's phone scans a QR code shown by MeshDrop on the PC and gets a browser page. On that page the friend can send files and text to the PC, after the owner accepts them, and can download the files the owner offers. The friend sees nothing else.

**Architecture:** A new guest module in the Node engine (`packages/core/src/guest/`) with three parts:
- a guest book: one-time tokens, browser binding, expiry;
- an upload store: pending offers, accept/reject, offset-resumable writes into the inbox;
- a plain-HTTP server on its own port, which serves a small static page (vanilla JS, no framework) and a JSON/bytes API.

The Engine owns one guest server and emits `guest` events. The desktop app adds a Guests page: a QR code, the offered files, and an accept prompt with a preview. Internet guest links are M5b; tunnels and port-forward are M5c.

**Tech Stack:** Node 24 (`node:http`, `node:crypto`), React renderer, Electron, vitest, Playwright for Electron. No new dependencies; the QR code uses the `qrcode` package that is already a dependency.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`:
- §2 "Guest tier";
- §3 goals 3 (accept prompt with a preview) and 5 (guest QR → browser page);
- §5 anti-goal (a guest never sees other devices or files);
- §8 "Guest tier": LAN guests use plain HTTP gated by a one-time token.

## Global Constraints

- **Branch:** `m5a-lan-guests`, cut from `m4b-android-mesh`.
- **Commits:** identity `Hafij-BGE <mdhafijur.rahman@ogr.deu.edu.tr>`; every message ends with the Co-Authored-By line.
- **Port:** the guest port defaults to `53320`, set by `EngineOptions.guest.port`; tests use `0`. It binds all interfaces, and plain HTTP is accepted only for this LAN guest tier.
- **Token:** 16 random bytes as base64url (22 characters), compared in constant time.
  - The first browser to open `/g/<token>` claims it: the server sets an `HttpOnly; SameSite=Strict` cookie `mdg=<32-byte base64url>`.
  - Any later request with that token but without the cookie gets `410 {"error":"used"}`.
  - The session expires after 1 hour; the owner can end it at any time.
  - At most one live guest session per engine.
- **Guest API:** everything lives under `/g/`. Any other path gets 404. Every response carries:
  - `Cache-Control: no-store`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: no-referrer`;
  - `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'`.
- **Limits:**
  - an offer has at most 1000 files and a text of at most 64 KiB;
  - names are sanitized as relative paths with `safeRelPath`;
  - a thumbnail is a `data:image/(png|jpeg|webp);base64,` URL of at most 48 KiB;
  - an upload request body is at most 4 MiB, written at `?offset=` and never past the declared size;
  - at most 4 pending (unanswered) offers per session.
- **Received files** land in the engine's inbox root under unique names (`uniqueName`), exactly like device transfers. Partial data stays in `<home>/guest-partial/` until a file is complete, then moves into place.
- **The guest never sees** device ids, aliases of other devices, the inbox listing, or anything the owner did not offer.

## Review Focus

1. **A second browser with the same QR link.** Expected: `410 used`, no access to offers or uploads. Test: Task 1 and Task 3.
2. **A hostile name or size** (`../x`, an absolute path, NUL, more bytes than declared, an offset past the end). Expected: refused (`400`) or clamped; never a write outside the inbox. Test: Task 2.
3. **An upload cut mid-file, then resumed.** Expected: `GET /g/api/offers/<id>` reports bytes per file, the page continues from that offset, and the final file is byte-identical. Test: Task 2 (store) and Task 7 (browser).
4. **The owner rejects, or ends the session, mid-upload.** Expected: partial data is deleted, further PUTs get `410`, and nothing lands in the inbox. Test: Task 2.
5. **A token after expiry, or after the owner ends the session.** Expected: `410 {"error":"expired"}`; the page says so. Test: Task 3.

---

### Task 1: Guest book

**Files:** `packages/core/src/guest/book.ts`; test `packages/core/test/guest-book.test.ts`.
- **API:**
  - `class GuestBook { constructor(now?: () => number) }`;
  - `open(ttlMs = 3_600_000) → { token, expiresAt }`, which replaces any live session;
  - `claim(token, cookie?: string) → { ok: true, cookie, fresh: boolean } | { ok: false, error: 'unknown' | 'used' | 'expired' }`;
  - `check(token, cookie) → 'ok' | 'unknown' | 'used' | 'expired'`;
  - `end()`;
  - `current() → { token, expiresAt, claimed: boolean } | null`.
- **Test:**
  - a fresh token claims once and returns a cookie;
  - the same cookie re-claims with `fresh: false`;
  - a second claim without the cookie gives `used`;
  - a wrong token gives `unknown`;
  - the clock moved past `expiresAt` gives `expired`;
  - after `end()`, the token gives `expired`;
  - a second `open()` makes the first token `expired`.
- **Commit:** `feat(core): guest sessions with one-time tokens`.

### Task 2: Guest uploads

**Files:** `packages/core/src/guest/uploads.ts`; test `packages/core/test/guest-uploads.test.ts`.
- **API:**
  - `class GuestUploads { constructor(partialDir, inboxRoot, onEvent) }`;
  - `offer({files: {name, size, type?, thumb?}[], text?}) → { id, status: 'pending' }`, which throws `GuestError(400 | 429, code)`;
  - `status(id) → { status: 'pending' | 'accepted' | 'rejected' | 'done', files: {name, size, received}[] }`;
  - `accept(id)`;
  - `reject(id)`;
  - `write(id, fileIdx, offset, body: Readable) → received`;
  - `cancelAll()`.
- **Events:**
  - `{type:'guest-offer', id, files, text?}`;
  - `{type:'guest-file', id, path}`;
  - `{type:'guest-received', id, files: string[], text?}`.
- **Rules:**
  - writes must start exactly at the current received offset; anything else gives `409 {"error":"offset", received}`;
  - a write past the size gives `400 too-large`;
  - a file is moved into the inbox under `uniqueName` once complete;
  - zero-byte files complete on accept;
  - text-only offers complete on accept;
  - reject or `cancelAll` deletes the partial data.
- **Test:**
  - offer → pending → accept → two writes → byte-identical file in the inbox, and a `guest-received` event;
  - a resume after a cut write at the reported offset;
  - a wrong offset gives `409`;
  - a write past the size gives `400`;
  - `../evil`, `/abs`, `a\0b` and an over-long thumbnail give `400`;
  - a 5th pending offer gives `429`;
  - reject mid-upload deletes the partial and later writes give `410`;
  - a name collision lands as `x (1).txt`.
- **Commit:** `feat(core): guest uploads with an accept step and resumable writes`.

### Task 3: Guest HTTP server and downloads

**Files:** `packages/core/src/guest/server.ts`; test `packages/core/test/guest-server.test.ts`.
- **Routes:**
  - `GET /g/<token>`: claims the token, sets the cookie and serves the page;
  - `GET /g/app.js`, `GET /g/app.css`: the static page assets;
  - `GET /g/api/session`: `{ expiresAt, owner: alias }`;
  - `GET /g/api/shared`: `[{id, name, size}]`;
  - `GET /g/api/shared/<id>`: the file, with `Content-Disposition: attachment; filename*=UTF-8''…` and single-range `Range` support;
  - `POST /g/api/offers`: a JSON offer;
  - `GET /g/api/offers/<id>`;
  - `PUT /g/api/offers/<id>/<fileIdx>?offset=N`.
- **Auth:** the API takes the token in the `X-Guest-Token` header plus the cookie.
- **API:** `createGuestServer({ book, uploads, shared: () => SharedFile[], alias }) → http.Server`, with `SharedFile = { id, name, size, path }`.
- **Test:**
  - claim, then a cookie-less second client gets `410 used`;
  - the API without the cookie gets `410`;
  - an expired session gets `410 expired`;
  - the security headers are on every response;
  - a download plus a ranged download;
  - an unknown path gets `404`;
  - the full offer → accept → upload cycle over HTTP.
- **Commit:** `feat(core): guest HTTP server`.

### Task 4: Guest page

**Files:** `packages/core/src/guest/page/index.html`, `app.js`, `app.css` (shipped as static files and read at startup); test `guest-page.test.ts`.
- **Behaviour:**
  - shows the owner's alias and the time left;
  - a picker for files (multiple) plus a text box;
  - builds image thumbnails with a canvas at 96 px, as JPEG, kept only if at most 48 KiB;
  - posts the offer and polls its status every 1 s;
  - on accept, uploads each file in 4 MiB slices, resuming from the reported `received`;
  - shows progress, and "Declined" / "Expired" states;
  - lists the shared files as download links.
- **Code rules:** no inline script or style (CSP), and DOM text set with `textContent` only.
- **Test:** the page assets are served with the right content types, and `app.js` has no `innerHTML`.
- **Commit:** `feat(core): guest web page`.

### Task 5: Engine and CLI

**Files:** `engine.ts`, `cli.ts`; tests in `engine-guest.test.ts`.
- **Engine API:**
  - `guestStart() → { url, qrSvg, expiresAt }`, where the URL uses the first LAN address: `http://<lan>:<port>/g/<token>`;
  - `guestEnd()`;
  - `guestShare(paths: string[])`, `guestUnshare(id)`;
  - `guestState() → { active, expiresAt, url, shared, offers }`;
  - `guestAccept(id)`, `guestReject(id)`.
- **Events:** `{source:'guest', type:'offer' | 'received' | 'ended', …}`.
- **Lifecycle:** the guest server starts with `start()` (`guest.port`, default 53320; `false` disables it) and closes with `stop()`.
- **CLI:** `meshdrop guest [--share <path>]...` prints the URL and QR, asks `accept? [y/N]` per offer on a TTY (or `--accept-all`), and runs until Ctrl-C.
- **Test:** start, then a guest uploads over HTTP, the owner accepts and the file is in the inbox; then `guestEnd()` gives `410`.
- **Commit:** `feat(core): guest sessions in the engine and CLI`.

### Task 6: Desktop: Guests page and accept prompt

**Files:**
- `controller.ts`: guest methods, a `guest` state slice, notifications;
- `shared/api.ts`: `guestStart`, `guestEnd`, `guestShare(paths)`, `guestUnshare`, `guestAccept`, `guestReject`; `AppState.guest`;
- `preload.ts`, `main.ts` (IPC);
- renderer `pages/Guests.tsx` and `components/GuestOffer.tsx` (the prompt: names, sizes, thumbnails, text, Accept/Decline);
- `App.tsx`: the page is hidden on Android until the Java port.
- **Tests:** `controller.test.ts` guest cases:
  - start → URL;
  - an offer appears in state and notifies;
  - accept → received history;
  - end → inactive.
- **Commit:** `feat(desktop): Guests page with QR and accept prompt`.

### Task 7: E2E

**Files:** `apps/desktop/e2e/guest.spec.ts`.
- The app starts a guest session.
- A second Electron `BrowserWindow`, standing in for the guest's browser, opens the URL and picks a 9 MiB file and a text.
- The owner accepts in the main window's prompt, and the file lands in the inbox, byte-identical.
- The owner shares a file; the guest window shows it, and its download is byte-identical (checked through `fetch` in the guest window).
- **Commit:** `test(desktop): guest e2e`.

### Task 8: Docs

`README.md` (Guests), and `docs/protocol.md` § "Guest tier (LAN)": the routes, limits, token and cookie rules.

**Commit:** `docs: M5a`.

## Rulings made while planning

- **Guest server on the PC (Node) first.** The Android Java port of the guest server comes later; the Guests page is hidden on Android. Cost if wrong: phones cannot host guests in M5a.
- **The token is claimed by the first browser through a cookie.** "One-time session secret" is read as: one browser per QR, for at most 1 h. Cost if wrong: a guest who switches browsers needs a new QR.
- **Accept before upload.** The owner sees names, sizes and browser-made thumbnails before any byte is stored. Cost if wrong: no content-based preview of non-images.
- **No new dependencies.** The page is vanilla JS. Cost if wrong: more hand-written UI code.
