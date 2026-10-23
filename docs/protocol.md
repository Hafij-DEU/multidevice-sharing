# MeshDrop wire protocol

Written incrementally during M1; completed in Task 9. This file currently covers the receiver HTTP API.

## Endpoints (v1)

Transport: HTTPS/1.1 over mutual TLS 1.3 on TCP 53318. All paths are under `/mesh/v1/`. Every route except
`GET info` requires the peer's certificate to hash (SHA-256 of the DER) to a trusted device id, otherwise the
response is `403 {"error":"untrusted"}`. Error bodies are JSON `{"error": "<code>"}`; 500 never carries
exception text. A session belongs to the device named in its manifest (`from`); any other peer gets
`403 {"error":"forbidden"}` on `chunk`, `complete`, `finish` and `cancel`.

| Method | Path | Request body | Success | Error statuses |
|---|---|---|---|---|
| GET | `info` | none | `200 {v:1, deviceId, alias, deviceType}` | none (open to any peer) |
| POST | `offer` | `Offer` JSON (`{v, sessionId, from, to, enc, sealedManifest}`), at most 64 MiB | `200 {have: HaveMap}`, or `200 {done: true, files: [path]}` if the session was already finished (see Tombstones) | 400 malformed JSON; 403 `untrusted`, or `offer.from` is not the peer, or the session belongs to someone else; 409 `session-conflict`; 413 body too large; 422 `bad-offer` (malformed offer or manifest, unsafe path, not addressed to this device, wrong sender key); 507 `no-space`; 500 |
| PUT | `chunk/:sessionId/:fileId/:index` | raw sealed chunk (ciphertext + 16-byte tag), at most `CHUNK_SIZE + 16` bytes | `204` | 400 non-numeric `fileId`/`index`; 403; 404 `unknown-session`; 409 `range` (unknown file, index out of range, wrong plaintext length); 413 body too large (checked on `Content-Length` and while streaming; the connection is closed); 422 `decrypt` (authentication failed, nothing recorded); 507 `no-space` (disk full; partial data kept, `error` event emitted); 500 |
| POST | `complete/:sessionId/:fileId` | none | `200 {path}` (idempotent) | 403; 404; 409 `incomplete` (chunks missing) or `range` (unknown file); 422 `integrity` (SHA-256 mismatch; the received data is discarded so the file restarts from scratch); 500 |
| POST | `finish/:sessionId` | none | `200 {files: [path]}`; creates the manifest's empty directories, writes the tombstone, emits `received` (with `text` if any), drops the partial session state. Retryable: on a finished session it returns the same `files` with no second `received` | 403; 404; 409 `incomplete` (some manifest file was not completed; session kept); 500 |
| POST | `cancel/:sessionId` | none | `204` (idempotent; unknown session is also 204) | 403 |

Notes:

- **Resume.** Repeating `offer` with the same `sessionId` and the same sealed offer returns the current have
  map (`{fileId: [chunk indices]}`) without touching stored data. A repeat whose HPKE context differs from the
  stored one is `409 session-conflict`; an existing session is never re-begun or wiped.
- **Tombstones.** After `finish`, the receiver keeps a record `{from, files}` of the delivered session for at
  least 7 days (it survives restarts). While it exists, `finish` is idempotent (200, same files, no second
  `received`) and a re-`offer` of that `sessionId` (which must still be a valid offer from the same peer; any
  other peer gets 403) answers `200 {done: true, files}` instead of creating a new session, so a lost `finish`
  response can never cause the files to be received twice. Order inside `finish`: create dirs, write tombstone,
  emit `received`, drop partial state.
- **Error events.** Any failure carrying an errno-style code (ENOSPC, EACCES, EIO, ...) emits an `error`
  event with that code; the HTTP reply stays generic (507 `no-space` for ENOSPC, 500 `internal` otherwise).
- **Session ids** are 22 base64url characters; anything else in a path is `404 unknown-session`.
- **Receiver events** (not on the wire): `offer`, `progress {fileId, chunks, total}`, `file {fileId, path}`,
  `received {files, text?}`, `error {code}`, `cancelled`, each carrying `sessionId` and `from`.

## Sender algorithm / resume

Implemented in `packages/core/src/transfer/send.ts` (`sendTo`, `Outbox`) and `multisend.ts` (`multiSend`).

1. **Manifest.** Items are walked and every file is hashed (SHA-256 of the plaintext) with positional reads;
   each source's `size` and `mtimeMs` are recorded, plus a SHA-256 of every `CHUNK_SIZE` plaintext chunk
   (sender-side only, never on the wire). A `file` item is sent under its base name (an explicitly
   chosen symlink is followed). A `dir` item is walked under its base name with `/`-separated paths; inside the
   walk symlinks and special files are skipped silently (never followed), and every directory that ends up
   with no entries is listed in `dirs`. At most one `text` item per send. `fileId`s are 0..n-1.
2. **Session.** A fresh `sessionId` and HPKE context per target (`createOffer`). With an outbox, the entry
   `{sessionId, target, itemsKey, offer, manifest, sources (path, size, mtimeMs, chunk hashes), ctxExport}` is written to
   `<config>/outbox/<sessionId>.json` atomically with mode 0600 (it holds key material) before any request.
3. **Offer.** `POST offer` with the stored Offer, byte-identical on every resume (a different `enc` would be
   `409 session-conflict`). `200 {have}` gives the chunks to skip; `200 {done: true}` means the receiver already
   finished the session (lost `finish` reply), which is treated as done.
4. **Chunks.** Each missing chunk is read at offset `index * CHUNK_SIZE` (never the whole file), sealed at its
   fixed `(fileId, index)` seq and PUT; 3 in flight by default. A file is `complete`d as soon as its last missing
   chunk is acknowledged (files with nothing missing, including 0-byte files, are completed directly). Then
   `finish`. A file of exactly N × 4 MiB has exactly N chunks; a 0-byte file has none.
5. **Source changes.** Before the session starts and before every chunk read, each source's size and mtime
   are compared with the recorded values, and every chunk read is checked against its recorded SHA-256 before
   it is sealed; any difference fails the session with `source-changed`. Different plaintext must never be
   sealed under an already-used seq (AES-GCM nonce reuse), and size + mtime alone miss in-place rewrites that
   keep both (`cp -p`, `rsync -t`, `touch -r`, coarse FAT/exFAT/FUSE timestamps). `422 integrity` from
   `complete` is also terminal `source-changed` (the receiver has discarded that file; it is never resealed).
   If only chunks the receiver already holds were rewritten, the resume still completes and the receiver keeps
   the original snapshot the manifest hash describes. Calling `sendTo` again with
   the same items after a source changed supersedes the stale outbox entry with a brand-new session.
6. **Retries.** Network errors, timeouts and any 5xx (including 507) are retried 3 times after 0.5 s, 1 s and
   2 s. 4xx (403/404/409/413/422), TLS pin mismatch and malformed replies (a 2xx with invalid JSON, an
   oversized body) fail at once; `error` carries
   `http-<status> <code>` (e.g. `http-409 session-conflict`), `pin-mismatch`, `bad-response`, `source-changed`
   or the network error message. Each request uses a fresh pinned connection; offer/chunk requests have a 30 s
   idle timeout, `complete`/`finish` 10 min (the receiver hashes whole files before answering).
7. **Outcome.** `done` deletes the outbox entry. `failed` keeps it. Aborting the caller's `AbortSignal` means
   *pause*: the result is `cancelled`, nothing is posted to the receiver (no `cancel`), and the entry is kept
   so `sendTo` with the same items, or `Outbox.resumeAll`, continues from the receiver's have map.
   `resumeAll(id, resolveTarget)` resumes all entries concurrently; entries whose device cannot be resolved are
   kept and reported as `failed` / `target-unresolved`.
8. **Multi-send.** Items are hashed once; each target gets its own session, keys and outbox entry, all run
   concurrently. One target failing never affects the others; results come back in target order.

## Announce packet

Implemented in `packages/core/src/discovery.ts` (`Discovery`).

Transport: UDP multicast to `224.0.0.168:53318` (TTL 1, link-local), sent every 5 s from every non-internal IPv4
interface (or one chosen interface). Payload: one JSON object, at most 1024 bytes, UTF-8:

```json
{"v":1,"deviceId":"<64 lowercase hex>","alias":"<string, at most 64 chars>","deviceType":"desktop|mobile|headless","port":53318}
```

`port` is the TCP port of the mesh HTTPS server (integer 1-65535). Receivers validate every field strictly and
silently drop anything else (non-JSON, non-object, `v` other than 1, bad `deviceId`/`alias`/`deviceType`/`port`,
oversized). Unknown extra fields are ignored. Packets carrying the receiver's own `deviceId` are ignored.

- **An announce is an unauthenticated hint.** Anyone on the LAN can forge one. Trust is never taken from it:
  the sender is pinned by certificate (device id = SHA-256 of the cert DER) at connect time and must be in the
  TrustStore for any route other than `GET info`.
- **Host.** A peer's address is the UDP source address of the packet, never a field of the payload.
- **Peer table.** Keyed by `deviceId`, at most 256 entries; when full, announces from unknown device ids are
  ignored (live peers are never evicted). `peer` is emitted for a new peer or when host/port/alias/deviceType
  changes, not on a plain refresh. An announced peer not heard from for `ttlMs` (15 s) is dropped with `lost`. Peers added by `probe` are
  `manual`: exempt from expiry (an announce for the same id refreshes them but keeps them manual) until
  `forget(deviceId)` (emits `lost`) or `stop()`.
- **Probe** (manual add, later subnet scan): `GET /mesh/v1/info` over TLS 1.3 without pinning and without a
  client certificate. The peer's device id is the hash of the certificate it presented; if `info.deviceId`
  differs, or `v`/`alias`/`deviceType` are invalid, the probe fails and nothing is emitted. Default timeout 5 s,
  response body capped at 4 KiB.
