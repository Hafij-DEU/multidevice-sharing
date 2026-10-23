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
