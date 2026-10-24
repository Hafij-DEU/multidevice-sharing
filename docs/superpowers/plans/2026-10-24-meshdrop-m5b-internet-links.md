# MeshDrop M5b: Internet Guest Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner shares files with anyone on the internet through a link. The link has an expiry, an optional password and a download cap, and the owner can revoke it. A link can also let the visitor send files back. The hub, and any tunnel in front of it, sees only ciphertext: the key lives in the URL fragment, and the visitor's browser decrypts with WebCrypto.

**Architecture:**
- **Link store:** a new hub-side store at `<home>/hub/links/<id>/` (`packages/core/src/links/`).
  - The owner's engine encrypts each file in 4 MiB chunks with AES-256-GCM under a random 32-byte link key, plus an encrypted manifest (names, sizes).
  - It writes the ciphertext, and a `link.json` with the expiry, the password hash (scrypt), the download count and cap, and the upload flag.
- **Routes:** the hub's existing loopback ingress (`127.0.0.1:53319`, which tunnels point at) gains plain-HTTP routes under `/l/`:
  - a static page;
  - an API that hands out ciphertext after the password/cap checks;
  - an upload API, where the browser encrypts slices with the link key and the hub, being the owner's PC, decrypts and feeds them to the M5a `GuestUploads`, so the same accept prompt applies.
- **App:** the desktop Guests page gains an "Internet links" section.
- **Reachability:** tunnel setup is M5c. Until then the link uses the first hub URL from the membership list, or says one is needed.

**Tech Stack:** as M5a. Browser crypto is WebCrypto (AES-GCM, SHA-256) only. The ingress origin is HTTPS behind a tunnel, and `http://127.0.0.1` in tests: both are secure contexts. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`:
- §3 goal 12 (internet guest links with an expiry, a password and a download cap; the key in the fragment; the hub stores and relays only ciphertext);
- §8 "Guest tier → Internet guests" (the owner can revoke; uploads land in the owner's inbox and need the accept prompt);
- §8 "Held files" (a directory that can be backed up).

## Global Constraints

- **Branch:** `m5b-internet-links`, cut from `m5a-lan-guests`.
- **Commits:** identity `Hafij-BGE <mdhafijur.rahman@ogr.deu.edu.tr>`; every message ends with the Co-Authored-By line.
- **Link id:** 16 random bytes, base64url (22 characters).
- **Link key:** 32 random bytes, base64url, only ever in the URL fragment `#k=` and in the owner's memory while the link is created.
  - The key is never written to disk on the hub; `link.json` holds `SHA-256(key)`, used only to check uploads.
  - The owner's app keeps the full URL in `<home>/hub/links/<id>/owner-url` (mode 0600), so it can show the link again. That file is on the owner's PC, never served.
- **Chunk format (per file):**
  - `nonce = 4-byte file index ‖ 8-byte chunk index` (big endian), which is unique per key because files and chunks are numbered;
  - `AAD = utf8("meshdrop-link-v1") ‖ 0x00 ‖ linkId ‖ 0x00 ‖ u32be(fileIdx) ‖ u64be(chunkIdx) ‖ u8(last)`;
  - each chunk is the plaintext encrypted with AES-256-GCM, ciphertext followed by the 16-byte tag.
- **Manifest:** the JSON `{v:1, files:[{name, size, type?}], text?}`, encrypted as file index `0xffffffff`, chunk 0, last 1.
- **Expiry:** from 1 hour to 30 days, default 7 days.
- **Password:** optional. The hub stores `scrypt(N=2^15, r=8, p=1, 32 B)` with a 16-byte salt.
  - `POST /l/<id>/api/open {password?}` answers `{session}`: a random 32-byte token, valid 1 h.
  - It allows 5 wrong tries per link per 10 minutes, then `429`.
- **Download cap:** none, or 1..1000. Each successful `open` counts once; when the count reaches the cap, further opens get `410 {"error":"used-up"}`.
- **Revoke:** deletes the directory; afterwards everything answers `404`.
- **Expiry handling:** on access, and on an hourly prune that deletes expired links.
- **Quotas:** total link storage defaults to 10 GiB (Settings later); a link larger than the remaining quota is refused at creation.
- **Uploads (when the link allows them):**
  - the browser sends the M5a offer JSON encrypted as file index `0xfffffffe`;
  - slices are encrypted with file index = the offer's file index plus `0x80000000`, and the chunk index = the slice index;
  - the hub decrypts with the key, which the browser presents once as `X-Link-Key` on `open`, checked against `SHA-256(key)` and held in memory for that session only;
  - limits as in M5a; the owner gets the same accept prompt.
- **Headers:** as M5a (CSP `default-src 'self'`, no inline script), plus `Strict-Transport-Security` only when the request came through a tunnel (`X-Forwarded-Proto: https`).

## Review Focus

1. **A wrong or missing key in the fragment.** Expected: decryption fails with a clear message on the page, and the hub never learns the key from a download. Test: Task 4 (browser) and Task 1 (vectors).
2. **Password brute force and cap races.** Two browsers opening at the same time must never exceed the cap; wrong passwords are throttled. Test: Task 2.
3. **Expiry and revoke during a download.** Expected: in-flight chunk requests after a revoke get `404`, and the page says the link is gone. Test: Task 3.
4. **Hostile uploads through a link.** A bad AAD, a reordered chunk, a slice bigger than declared, or an upload without a key all fail; nothing reaches the inbox before the owner accepts. Test: Task 3.
5. **The hub's disk.** Quota at creation, pruned when expired, and no plaintext left on the hub besides what the owner already had. Test: Task 2.

---

### Task 1: Link crypto (Node) and vectors

**Files:**
- `packages/core/src/links/crypto.ts`;
- `protocol/vectors/link-v1.json` (generated by a script in `packages/core/scripts/`, then checked in);
- test `link-crypto.test.ts`.
- **API:**
  - `newLinkKey()`;
  - `sealChunk(key, linkId, fileIdx, chunkIdx, last, plain)`;
  - `openChunk(...)`, which throws `LinkCryptoError`;
  - `sealManifest` / `openManifest`;
  - `keyHash(key)`.
- **Test:**
  - the vector is byte-exact;
  - a flipped bit, a swapped chunk index, a wrong `last` flag and a wrong link id all fail.
- **Commit:** `feat(core): internet link chunk crypto and vectors`.

### Task 2: Link store

**Files:** `packages/core/src/links/store.ts`; test `link-store.test.ts`.
- **API:**
  - `LinkStore(dir, {quotaBytes, now})`;
  - `create({files: paths[], text?, expiresInMs, password?, maxDownloads?, allowUploads}) → {id, key}`, which encrypts the files into the store;
  - `list() → LinkInfo[]`;
  - `revoke(id)`;
  - `prune()`;
  - `open(id, password?) → {session} | error ('not-found' | 'expired' | 'used-up' | 'bad-password' | 'throttled')`;
  - `chunk(id, session, fileIdx, chunkIdx) → Buffer`;
  - `manifest(id, session)`.
- **Test:**
  - create → open → chunks decrypt to the original;
  - the password is checked, and wrong passwords are throttled after 5;
  - with cap 2, five concurrent opens give exactly 2 sessions;
  - expired links get `expired` and `prune()` removes them;
  - revoke gives `not-found`;
  - the quota is refused at create;
  - no plaintext file names appear anywhere in the store directory.
- **Commit:** `feat(core): internet link store`.

### Task 3: Link routes on the hub ingress

**Files:**
- `packages/core/src/links/server.ts`: a request handler mounted by `HubServer.listenIngress` for `/l/` (the WebSocket upgrade path is unchanged);
- test `link-server.test.ts`.
- **Routes:**
  - `GET /l/<id>`: the page;
  - `GET /l/app.js`, `GET /l/app.css`;
  - `POST /l/<id>/api/open`;
  - `GET /l/<id>/api/manifest`, which returns ciphertext;
  - `GET /l/<id>/api/chunk/<file>/<n>`;
  - `POST /l/<id>/api/offers`, `GET …/offers/<oid>`, `PUT …/offers/<oid>/<i>/<n>`: uploads with the M5a semantics plus decryption.
- **Test:**
  - the full download over HTTP;
  - throttling;
  - a revoke mid-download gives `404`;
  - an upload offer → owner accept → encrypted slices → plaintext in the inbox;
  - a tampered slice gives `400 bad-chunk`;
  - an upload without a key gives `403`.
- **Commit:** `feat(core): internet link routes on the hub ingress`.

### Task 4: Link page

**Files:** `packages/core/src/links/page.ts` (strings, like M5a's).
- **Behaviour:**
  - reads `#k=` (or shows "the link is missing its key");
  - asks for the password when the hub says one is needed;
  - decrypts the manifest and shows the names, sizes and message;
  - downloads each file by decrypting its chunks into a Blob and saving it;
  - optionally sends files: the M5a flow with encrypted slices;
  - says "expired", "no downloads left" or "removed" when the hub does.
- **Test:**
  - the JS passes `node --check`, has no `innerHTML`, and uses `crypto.subtle` with AES-GCM;
  - a Node-side run of the page's decrypt function (exported for tests via `globalThis.__mdLinkTest` when `?test` is set) matches the vector.
- **Commit:** `feat(core): internet link page`.

### Task 5: Engine, CLI, desktop

**Files:**
- `engine.ts`:
  - `linkCreate(opts) → {id, url, qrSvg}`, where the URL is the first hub URL with `/l/<id>#k=…` and hub only;
  - `linkList()`, `linkRevoke(id)`;
  - an event when an upload offer arrives through a link, with the same `guest` events tagged `via: 'link'`.
- **CLI:** `meshdrop link create <path>... [--days N] [--password-file F] [--max-downloads N] [--allow-uploads]`, plus `meshdrop link list` and `meshdrop link revoke <id>`.
- **Desktop:** the Guests page gains "Internet links": create (files, expiry, password, cap, uploads), list (expiry, downloads used, revoke, copy link, QR). It is shown only when this PC is the hub; otherwise it explains why.
- **Test:**
  - controller: create → listed → revoke;
  - e2e: a link created in the app is opened in an Electron window at `http://127.0.0.1:<ingress>/l/<id>#k=…`; the file downloads byte-identical, and an upload is accepted in the prompt.
- **Commit:** `feat: internet guest links in the engine, CLI and desktop app`.

### Task 6: Docs

`README.md` (internet links) and `docs/protocol.md` § "Internet guest links": the formats, routes and limits.

**Commit:** `docs: M5b`.

## Rulings made while planning

- **Links are created on the hub PC only.** A member device would have to upload the ciphertext through the relay; that comes later. Cost if wrong: phones cannot make internet links yet.
- **The password is checked by the hub**, not mixed into the key: "optional password" in the spec. The fragment key alone is enough to decrypt anything leaked from the hub. Cost if wrong: a hub compromise plus a leaked URL bypasses the password.
- **Downloads go through Blobs in memory.** No service-worker streaming. Cost if wrong: very large files (over about 1 GiB) may fail on phones; the page warns above 1 GiB.
- **Uploads decrypt on the hub.** The hub is the owner's PC, so the owner holds the key anyway; the tunnel sees only ciphertext. Cost if wrong: none for a hub that is the owner's own PC.
