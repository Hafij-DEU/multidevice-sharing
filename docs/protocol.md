# MeshDrop wire protocol (v1)

This is the normative description of protocol v1, as implemented by the Node engine in `packages/core/src`.
A second engine (the M4 Android/Java engine) must follow it and reproduce the frozen vectors in
`protocol/vectors/` byte for byte. Contents: identity and device id, TLS rules, HPKE suite and chunk
sealing, manifest schema, endpoints, sender/resume algorithm, announce packet, M1 pairing, test vectors.

## Identity and device id

Implemented in `identity.ts` and `x509.ts`.

- Every device has one long-term **ECDSA P-256** key pair and a **self-signed X.509 v3 certificate** for it:
  signature ECDSA-with-SHA256, subject = issuer = `CN=meshdrop-<first 8 hex of SHA-256(SPKI DER)>`, a 16-byte
  random positive serial, validity notBefore `200101000000Z` (UTCTime, as RFC 5280 requires before 2050) to
  notAfter `99991231235959Z` (GeneralizedTime), and one critical
  `basicConstraints` extension with `cA` FALSE. The same key is used for TLS, ECDSA and HPKE (static DH key).
- **Device id** = lowercase hex SHA-256 of the certificate **DER** (64 characters). The short display form is
  its first 8 characters. Ids are never taken from a JSON field when the certificate is available: on the
  wire the id is always recomputed from the certificate the peer presented.
- Stored as `<config>/identity/key.pem` (PKCS#8, mode 0600) and `<config>/identity/cert.der`. Config dir:
  `$MESHDROP_HOME`, else `$XDG_CONFIG_HOME/meshdrop`, else `~/.config/meshdrop`. On load the certificate must
  verify under the stored key. If only one of the two files exists, loading fails with an error naming the
  missing file; the engine never regenerates half an identity (that would silently change the device id).
  A new identity is written to a temporary directory and renamed into place, so a crash cannot leave half of one.
- A device id stays valid as long as the certificate DER is unchanged; re-issuing the certificate (even for
  the same key) is a new device id and needs re-pairing.

## TLS rules

Implemented in `tls.ts`.

- **TLS 1.3 only** (`minVersion: 'TLSv1.3'`) on every connection: server, pinned client, probe.
- **Server** (TCP 53318 by default): presents the device certificate, requests a client certificate but
  accepts any (self-signed peers cannot pass CA validation). The application decides trust: the client's
  device id (SHA-256 of its certificate DER) must be in the TrustStore for every route except `GET info`.
- **Pinned client** (every transfer request): presents its own certificate, disables CA and hostname
  validation, and on `secureConnect` checks that SHA-256(server certificate DER) equals the expected device
  id. On a mismatch (or no certificate) the socket is destroyed before any application byte is written
  (`pin-mismatch`, never retried). Each request uses a fresh connection.
- **Probe / pairing** (`GET info`, pairing): TLS 1.3 without pinning and **without a client certificate**,
  so a scan does not reveal who is scanning. The result is only trusted as far as the certificate goes: the
  device id is the hash of the presented certificate, and an `info.deviceId` that disagrees fails the probe.
- The trust store (`<config>/trust.json`, mode 0600) holds `{deviceId, alias, publicKeyPem (SPKI, EC P-256
  only), addedAt}` per device; anything else (a private key PEM, a certificate PEM, another curve) is refused.

## HPKE suite and chunk sealing

Implemented in `crypto/hpke.ts` (RFC 9180 over `node:crypto`) and `chunk.ts`.

| Parameter | Value |
|---|---|
| mode | `mode_auth` `0x02` (sender authenticated by its static key) |
| KEM | DHKEM(P-256, HKDF-SHA256) `0x0010` |
| KDF | HKDF-SHA256 `0x0001` |
| AEAD | AES-256-GCM `0x0002` (16-byte tag appended to the ciphertext) |
| `info` | UTF-8 `"meshdrop/v1 " + sessionId` |
| `enc` | uncompressed SEC1 point (65 bytes), base64 in the Offer |

- One HPKE context per **(session, target)**. The sender runs `SetupAuthS(pkR = receiver's static key,
  info, skS = sender's static key)`; the receiver runs `SetupAuthR(enc, skR, info, pkS)` with `pkS` taken from
  its **trust store**, never from the offer.
- Messages are sealed at an explicit sequence number (random access, so chunks can be resent in any order):
  nonce = `base_nonce XOR I2OSP(seq, 12)` (RFC 9180 section 5.2).

| Message | seq | AAD |
|---|---|---|
| manifest | `0` | UTF-8(`sessionId`) |
| chunk `(fileId, index)` | `((fileId + 1) << 32) \| index` (u64; `fileId`, `index` are u32) | UTF-8(`sessionId`) ‖ u32be(`fileId`) ‖ u32be(`index`) |

  Sequence numbers never repeat within a context, and every ciphertext is bound to its session and position.
- **Chunks:** `CHUNK_SIZE` = 4 194 304 bytes (4 MiB) of plaintext; chunk `i` of a file covers bytes
  `[i * CHUNK_SIZE, min(size, (i + 1) * CHUNK_SIZE))`. A file has `ceil(size / CHUNK_SIZE)` chunks (a 0-byte
  file has none). A sealed chunk is at most `CHUNK_SIZE + 16` bytes. Different plaintext must never be sealed
  under a seq already used in the same context (see Sender algorithm, step 5).
- **Session id:** 16 random bytes, base64url without padding (22 characters `[A-Za-z0-9_-]`).
- **Offer** (the body of `POST offer`):

  ```json
  {"v":1,"sessionId":"<22 chars>","from":"<sender device id>","to":"<receiver device id>","enc":"<base64>","sealedManifest":"<base64>"}
  ```

  `enc` and `sealedManifest` are standard base64 with padding. The receiver opens the manifest and requires
  `manifest.sessionId`, `manifest.from` and `manifest.to` to equal the offer's `sessionId`, `from` and its own
  device id; `offer.from` must also equal the TLS peer's device id.

## Manifest schema

The manifest is the HPKE plaintext at seq 0: UTF-8 JSON, serialized **compactly with keys in this fixed
order** (byte-exactness matters only to the sealing side; receivers may parse with any JSON parser). String
escaping is ECMAScript `JSON.stringify`'s: only `"`, `\`, control characters below U+0020 and lone surrogates
are escaped; everything else is raw UTF-8.

```text
Manifest  = { v: 1, sessionId: string(22), from: deviceId, to: deviceId, createdAt: uint (epoch ms),
              files: FileEntry[], dirs: DirEntry[], text?: string }      // text omitted when absent
FileEntry = { fileId: u32, path: string, size: uint (<= 2^53-1), mime: string, sha256: hex64 (plaintext) }
DirEntry  = { path: string }                                             // empty directories only
```

Rules enforced by the receiver (`422 bad-offer` otherwise): `v` is 1; `fileId`s unique; at most 100 000 files
and 100 000 dirs; `text` at most 1 MiB of UTF-8. Paths are `/`-separated and relative; the receiver
sanitizes every path (`sanitize.ts`): absolute paths, drive letters, NUL and `..` segments are rejected; `\` also
splits segments; empty and `.` segments are dropped; `<>:"|?*`, control characters and lone surrogates become `_`;
Windows-reserved stems (`con`, `nul`, `com1`, ...) get a `_` prefix; at most 32 segments, 240 UTF-8 bytes per
segment (longer names are truncated, keeping an extension of up to 16 bytes) and 3072 bytes in total. A name that
already exists in the inbox becomes `stem (n).ext`; nothing is ever overwritten. The sender numbers files
`0..n-1`; `sha256` is checked by the receiver on `complete` (`422 integrity`).

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
| POST | `complete/:sessionId/:fileId` | none | `200 {path}` (idempotent; `path` is where the file landed, relative to the receiver's inbox root, `/`-separated, e.g. `photos/a (1).jpg`) | 403; 404; 409 `incomplete` (chunks missing) or `range` (unknown file); 422 `integrity` (SHA-256 mismatch; the received data is discarded so the file restarts from scratch); 500 |
| POST | `finish/:sessionId` | none | `200 {files: [path]}` (inbox-relative, as for `complete`); creates the manifest's empty directories, writes the tombstone, emits `received` (with `text` if any), drops the partial session state. Retryable: on a finished session it returns the same `files` with no second `received` | 403; 404; 409 `incomplete` (some manifest file was not completed; session kept); 500 |
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
- **Abandoned sessions.** A receiver deletes partial sessions whose state (session dir, `state.json`, progress
  log) was last touched more than 30 days ago when it starts (configurable), and tombstones older than 7 days.
  Senders normally clean up earlier by posting `cancel` (see Sender algorithm, step 7).
- **Paths on the wire** (`complete`, `finish`, `offer` `{done, files}`, and the tombstone) are always relative
  to the receiver's inbox root with `/` separators; a receiver never reveals its absolute directory layout.
- **Receiver events** (not on the wire): `offer`, `progress {fileId, chunks, total}`, `file {fileId, path}`,
  `received {files, text?}`, `error {code}`, `cancelled`, each carrying `sessionId` and `from`. Event paths are
  absolute local paths.

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
   A session that can never complete is cancelled on the receiver: after a terminal failure (`source-changed`,
   including `422 integrity`, and any 4xx such as `409 session-conflict`), and when an outbox entry is superseded
   by a new session (step 5) or removed by the user, the sender posts `cancel/:sessionId` once, best effort (one
   attempt, 3 s connect and request timeout, every error ignored). Transient failures (network, 5xx) and pause
   never post `cancel`, since those sessions stay resumable.
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

## M1 pairing and the engine

Implemented in `engine.ts` (`Engine`) and `cli.ts` (`meshdrop`). Not part of the wire protocol; recorded here so
other engines behave the same.

- **Manual pairing** (`pairManual(host, port, alias)`, CLI `meshdrop pair <host[:port]> <alias>`) is the M1
  trust bootstrap; M2 replaces it with QR pairing plus hub membership. It opens an unpinned TLS 1.3 connection
  without a client certificate, takes the device id (SHA-256 of the certificate DER) and the certificate's
  public key (stored as SPKI PEM) from what the peer presented, then probes `GET info` (which must agree) and
  adds the device to the trust store under the user-chosen alias. Pairing with one's own device id is refused.
  Pairing is one-directional: the other device must pair back before it accepts our offers. The address is
  remembered in `<config>/manual-peers.json` and re-probed (2 s timeout) on every engine start, so manually
  paired devices are present without multicast.
- **First contact is unauthenticated (trust on first use).** Pairing trusts whatever certificate answers at
  `host:port`: an active man-in-the-middle during `pair` would be trusted in place of the real device, and every
  later pinned connection would faithfully pin the attacker. `meshdrop pair` therefore prints both devices' full
  ids; users should compare them out of band (run `meshdrop id` on the other device and check it shows the id
  `pair` printed, and vice versa) before relying on the pairing. M2's QR pairing carries the id in the QR code
  and removes this step.
- **Targets.** A target is given as a unique prefix (at least 4 hex characters, case-insensitive) of a trusted
  device id; an unknown, ambiguous or malformed prefix is an error before anything is sent. `all` means every
  trusted device currently present in the peer table (empty: nothing is sent, the CLI exits non-zero). A trusted
  device that is not present fails with `offline`. Host and port come from the peer table, the HPKE recipient
  key from the trust store.
- **Outbox.** Every engine send is persisted in `<config>/outbox/` (see Sender algorithm), so a send interrupted
  by `stop()` or a crash is `cancelled`/`failed` and resumable. Nothing resumes automatically on start;
  `resumePending()` (CLI `meshdrop resume`) resumes every entry whose device is trusted and present.
- **Who runs discovery.** Only an engine that runs the receiver server announces and listens for multicast.
  A client-only engine (the CLI's `pair`, `send`, `peers`, `resume`, which run next to a `listen` on the same
  config dir) never announces, since it would advertise a server it does not run; it reaches trusted devices at
  their recorded manual addresses.
- **Trust changes across processes.** A running engine re-reads `trust.json` when the file changes on disk, so a
  device paired by a separate `meshdrop pair` process is accepted by a running `meshdrop listen` at once.
- **Ctrl-C.** The first SIGINT/SIGTERM stops the engine gracefully: hashing of the items is abandoned and
  in-flight sends end `cancelled` (resumable, no `cancel` posted). A second signal exits at once (130 for
  SIGINT, 143 for SIGTERM).
- **Defaults.** Port 53318, inbox `~/Downloads/MeshDrop`, alias = host name (at most 64 characters),
  device type `desktop`.

## Test vectors

Frozen files in `protocol/vectors/`; a conforming engine must reproduce them byte for byte.

| File | Pins | Checked by |
|---|---|---|
| `hpke-auth-p256.json` | RFC 9180 test vectors for mode_auth with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM and AES-256-GCM: shared secret, key schedule (key, base_nonce, exporter secret) and sealed messages at successive seqs | `packages/core/test/hpke.test.ts` |
| `chunk-v1.json` | MeshDrop sealing: fixed sender/receiver/ephemeral scalars, `info`, the exact manifest JSON bytes, `enc`, the sealed manifest (seq 0), one sealed chunk (seq/AAD layout above) | `packages/core/test/chunk.test.ts` |
| `x509-v1.json` | Device certificate: the TBSCertificate bytes for a fixed key, serial and CN (the ECDSA signature is randomized, so only the TBS is pinned) and the device-id rule | `packages/core/test/identity.test.ts` |
