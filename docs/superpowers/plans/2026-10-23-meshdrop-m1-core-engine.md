# MeshDrop M1 — Protocol + Node Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless Node engine plus CLI. Two paired owner devices on one LAN must be able to find each other and send files, folders and text, end-to-end encrypted, resumable, and to several targets at once. Every byte of the wire format is pinned by test vectors, so the Android engine (M4) can be written against them.

**Architecture:**
- A pnpm workspace with one package so far, `packages/core` (TypeScript, ESM, Node 24).
- Transport is HTTPS/1.1 over mutual TLS 1.3. Each side uses its self-signed device certificate and pins the peer's certificate by device ID.
- Content is sealed with HPKE (RFC 9180, auth mode). The same sealed chunks will later travel through the hub (M2) unchanged.
- Discovery is a UDP multicast JSON announce, plus manual add.

**Tech Stack:** Node 24.22 and TypeScript, with `node:crypto`, `node:https`, `node:tls` and `node:dgram`. Tests use vitest. The only dependencies are ones already in the offline pnpm store: `typescript` and `vitest`. M2/M3 will add `ws`, `vite` and `electron-builder`.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`

This is plan 1 of 7. The milestone roadmap is at the end; each later milestone gets its own plan when it starts.

## Global Constraints

- **Runtime:** Node `v24.22.0`. Use ESM (`"type": "module"`) and TypeScript `strict: true`. Run the engine with `node` (native type stripping) or compile with `tsc`, and do not use TS enums or parameter properties.
- **Package manager:** `pnpm@10.33.4`, pinned in the root `package.json` `packageManager` field. Install with `pnpm install --offline`.
- **Dependencies:** only the cached `typescript` and `vitest`. Any new dependency needs a written justification in the task.
- **Crypto:** every primitive comes from `node:crypto`: ECDH P-256, ECDSA P-256/SHA-256, AES-256-GCM, HMAC-SHA256, SHA-256 and randomBytes. Nothing in the code implements a primitive. HPKE and HKDF are compositions of HMAC and are pinned by RFC test vectors.
- **Device ID:** the lowercase hex SHA-256 of the device certificate's DER encoding (64 chars). The short display form is its first 8 chars.
- **Ports:**
  - mesh HTTPS: TCP `53318`;
  - announce: UDP multicast `224.0.0.168:53318`;
  - `53317` stays free for LocalSend (M6).
- **Chunk size:** `4 * 1024 * 1024` bytes of plaintext, with an AES-GCM tag of 16 bytes per chunk.
- **HPKE suite:**
  - mode_auth `0x02`;
  - KEM DHKEM(P-256, HKDF-SHA256) `0x0010`;
  - KDF HKDF-SHA256 `0x0001`;
  - AEAD AES-256-GCM `0x0002`.
- **Config dir:** `$MESHDROP_HOME`, otherwise `$XDG_CONFIG_HOME/meshdrop`, otherwise `~/.config/meshdrop`.
- **Inbox:** `~/Downloads/MeshDrop/`, overridable per engine.
- **TLS:** `minVersion: 'TLSv1.3'` everywhere.
- **Commits:** `git -c user.name=Hafij-BGE -c user.email=mdhafijur.rahman@ogr.deu.edu.tr commit …`. Repo licence GPL-3.0.

## Review Focus

1. **Hostile paths in a manifest** (`../x`, `/etc/x`, `C:\x`, `a/../../b`, NUL, `CON.txt`, empty segments). These must be rejected, or reduced to a safe name inside the inbox; nothing is ever written outside it. Tested in Task 4.
2. **Name collisions.** If `photo.jpg` already exists in the inbox, the new file lands as `photo (1).jpg`, then `photo (2).jpg`. Nothing is ever overwritten. Tested in Task 4.
3. **A write failure mid-transfer** (disk full or EACCES). The session reports an error, the partial file and manifest stay on disk for resume, and no half-written file appears under its final name. Tested in Task 6.
4. **Boundary sizes:**
   - 0-byte files have 0 chunks and still arrive;
   - files of exactly N×4 MiB have no empty trailing chunk;
   - empty folders are recreated.

   Tested in Tasks 3 and 7.
5. **One target dies during a multi-send.** The other targets finish. The dead one reports `failed` and can be resumed later from the chunks it already has. Tested in Task 7.

---

## File Structure

```
meshdrop/
  package.json                  # workspace root, packageManager pin, scripts: test, typecheck
  pnpm-workspace.yaml           # packages: ["packages/*"]
  tsconfig.base.json            # strict, ES2023, module NodeNext
  LICENSE                       # GPL-3.0
  .gitignore                    # node_modules, dist, .vitest-tmp
  docs/protocol.md              # wire spec v1 (written incrementally, finished in Task 9)
  protocol/vectors/
    hpke-auth-p256.json         # RFC 9180 vectors subset (Task 2)
    chunk-v1.json               # frozen seal/open + seq vectors (Task 3)
    x509-v1.json                # frozen cert + deviceId vector (Task 1)
  packages/core/
    package.json  tsconfig.json  vitest.config.ts
    src/
      paths.ts                  # config dir / inbox resolution
      x509.ts                   # minimal DER builder for a self-signed EC cert
      identity.ts               # load-or-create device key + cert, deviceId
      crypto/hkdf.ts            # RFC 5869 extract/expand over HMAC-SHA256
      crypto/hpke.ts            # RFC 9180 mode_auth, DHKEM P-256, seal/open at arbitrary seq
      chunk.ts                  # chunk math, seq formula, manifest + chunk seal/open
      sanitize.ts               # safe relative path + collision naming
      inbox.ts                  # partial files, resume manifest, finalize
      trust.ts                  # trusted device store (M2 swaps in signed membership)
      tls.ts                    # pinned mTLS server options + connectPinned()
      api/server.ts             # receiver HTTP routes
      transfer/send.ts          # one-target send session with resume
      transfer/multisend.ts     # fan-out to N targets
      discovery.ts              # UDP multicast announce + peer table
      engine.ts                 # facade + typed events
      cli.ts                    # `meshdrop` CLI
    test/                       # one *.test.ts per src module + e2e.test.ts
```

## Shared Types (defined in `chunk.ts`, used everywhere)

```ts
export interface FileEntry { fileId: number; path: string; size: number; mime: string; sha256: string } // sha256 = plaintext hex
export interface DirEntry  { path: string }            // empty folders
export interface Manifest  { v: 1; sessionId: string; from: string; to: string; createdAt: number;
                             files: FileEntry[]; dirs: DirEntry[]; text?: string }
export interface Offer     { v: 1; sessionId: string; from: string; to: string; enc: string /*b64*/; sealedManifest: string /*b64*/ }
export interface HaveMap   { [fileId: number]: number[] } // chunk indices already verified by receiver
```

---

### Task 1: Workspace scaffold + device identity

**Files:**
- Create: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `LICENSE`, `.gitignore`, `packages/core/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/core/src/paths.ts`, `src/x509.ts`, `src/identity.ts`
- Test: `packages/core/test/identity.test.ts`, `protocol/vectors/x509-v1.json`

**Interfaces:**
- Produces:
  - `configDir(): string`
  - `buildSelfSignedCert(opts: { publicKey: KeyObject; privateKey: KeyObject; commonName: string; serial: Buffer }): Buffer`, returning DER. It is ECDSA-with-SHA256, v3. Validity runs from `20200101000000Z` to `99991231235959Z` (GeneralizedTime). There is one extension, basicConstraints CA:false.
  - `interface Identity { deviceId: string; privateKey: KeyObject; publicKey: KeyObject; certDer: Buffer; certPem: string; keyPem: string }`
  - `loadOrCreateIdentity(dir = configDir()): Promise<Identity>`. Files are `identity/key.pem` (PKCS8, mode 0600) and `identity/cert.der`.
  - `deviceIdOf(certDer: Buffer): string`

- [ ] **Step 1:** `git init`. Write the root and package scaffolding (scripts: `test` = `vitest run`, `typecheck` = `tsc -p packages/core --noEmit`). Run `pnpm install --offline`. Expected: it succeeds with no network.
- [ ] **Step 2: Write failing tests** in `identity.test.ts`:
  - `cert parses and self-verifies`: `new X509Certificate(der).verify(publicKey) === true`, `.subject` contains `CN=meshdrop-`, and `.ca === false`.
  - `deviceId is sha256 of DER`: `deviceIdOf(der) === createHash('sha256').update(der).digest('hex')`, and it matches `/^[0-9a-f]{64}$/`.
  - `identity persists`: two `loadOrCreateIdentity(tmp)` calls return the same `deviceId`, and `key.pem` has mode `0o600`.
  - `frozen vector`: a fixed key from `x509-v1.json` plus a fixed serial gives cert bytes whose TBSCertificate equals the stored hex. The ECDSA signature itself is randomized, so compare only the TBS and verify the signature.
  - `node TLS accepts it`: start a `tls.createServer` with the cert and connect with `rejectUnauthorized:false`. The handshake completes on TLSv1.3.
- [ ] **Step 3:** Run `pnpm test`. Expected: it fails because the modules don't exist yet.
- [ ] **Step 4:** Implement `x509.ts` as a small DER encoder (SEQUENCE, INTEGER, OID, BIT STRING, UTF8String, GeneralizedTime, context tags). The SubjectPublicKeyInfo comes from `publicKey.export({type:'spki',format:'der'})`, and the signature from `crypto.sign('sha256', tbs, privateKey)`. Then implement `identity.ts` and `paths.ts`. Generate `x509-v1.json` once and freeze it.
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 6:** Commit with the message `feat(core): workspace + device identity with self-signed P-256 cert`.

### Task 2: HPKE (RFC 9180 mode_auth, DHKEM P-256)

**Files:**
- Create: `src/crypto/hkdf.ts`, `src/crypto/hpke.ts`, `protocol/vectors/hpke-auth-p256.json`
- Test: `test/hpke.test.ts`

**Interfaces:**
- Produces:
  - `hkdfExtract(salt: Buffer, ikm: Buffer): Buffer`
  - `hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer`
  - `interface HpkeContext { key: Buffer; baseNonce: Buffer; exporterSecret: Buffer; aead: 'aes-128-gcm'|'aes-256-gcm' }`
  - `setupAuthS(pkR: KeyObject, info: Buffer, skS: KeyObject, opts?: { aead?, skE?: KeyObject }): { enc: Buffer; ctx: HpkeContext }`. `skE` is only for tests.
  - `setupAuthR(enc: Buffer, skR: KeyObject, info: Buffer, pkS: KeyObject, opts?: { aead? }): HpkeContext`
  - `sealAt(ctx, seq: bigint, aad: Buffer, pt: Buffer): Buffer`, returning ct‖tag.
  - `openAt(ctx, seq: bigint, aad: Buffer, ct: Buffer): Buffer`. It throws `HpkeOpenError` on tag failure.
  - The nonce is `baseNonce XOR I2OSP(seq, 12)`. `seq` must be `< 2^96`.

- [ ] **Step 1:** Download the CFRG vectors once from `https://raw.githubusercontent.com/cfrg/draft-irtf-cfrg-hpke/master/test-vectors.json`. Keep the entries with `mode==2 && kem_id==16 && kdf_id==1 && aead_id in (1,2)` and save them as `hpke-auth-p256.json` (fields: info, skEm, pkEm, skRm, pkRm, skSm, pkSm, enc, key, base_nonce, exporter_secret, encryptions[]). If no `aead_id==2` entry exists, keep `aead_id==1` only. Our AEAD choice is a parameter, so the AES-128 vector still pins KEM, KDF and nonce logic.
- [ ] **Step 2: Write failing tests:**
  - `RFC 5869 case 1` for HKDF: IKM `0x0b`×22, salt `000102…0c`, info `f0…f9`, L=42, which gives OKM `3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865`.
  - `RFC 9180 auth vectors`: for each vector, `setupAuthS` with fixed `skE` gives exactly `enc`, `key`, `base_nonce` and `exporter_secret`. Each `encryptions[i]` seals with `seq=i` to the stored `ct` and opens back to `pt`.
  - `round trip at sparse seq`: `sealAt` at seq `2n**40n + 7n`, then `openAt`, returns the same bytes.
  - `tamper fails`: flipping one ct byte makes `openAt` throw `HpkeOpenError`.
  - `wrong sender key fails`: `setupAuthR` with a different `pkS` produces a context that can't open.
- [ ] **Step 3:** Run `pnpm vitest run test/hpke.test.ts`. Expected: it fails.
- [ ] **Step 4:** Implement per RFC 9180 §4.1 (DHKEM: ExtractAndExpand, `suite_id = "KEM"‖I2OSP(0x0010,2)`, `kem_context = enc‖pkRm‖pkSm`, DH = `crypto.diffieHellman` and its concatenation for auth) and §5.1 (KeySchedule with `mode=0x02`, empty psk/psk_id, `suite_id="HPKE"‖kem‖kdf‖aead`). Keys are serialized as uncompressed 65-byte points (`ecdh` raw or JWK x/y).
- [ ] **Step 5:** Run it again. Expected: it passes.
- [ ] **Step 6:** Commit with the message `feat(core): HPKE auth mode over node:crypto, pinned by RFC 9180 vectors`.

### Task 3: Chunk codec + manifest sealing

**Files:**
- Create: `src/chunk.ts` (with the shared types above), `protocol/vectors/chunk-v1.json`
- Test: `test/chunk.test.ts`

**Interfaces:**
- Consumes: the HPKE functions from Task 2.
- Produces:
  - `CHUNK_SIZE = 4194304`
  - `chunkCount(size: number): number`, which is `ceil(size/CHUNK_SIZE)`, so 0 gives 0.
  - `chunkSeq(fileId: number, index: number): bigint`, which is `(BigInt(fileId)+1n) << 32n | BigInt(index)`. The manifest uses seq `0n`.
  - `sessionInfo(sessionId: string): Buffer`, which is `utf8("meshdrop/v1 " + sessionId)`.
  - `chunkAad(sessionId, fileId, index): Buffer`, which is `utf8(sessionId)‖u32be(fileId)‖u32be(index)`. The manifest AAD is `utf8(sessionId)`.
  - `sealManifest(ctx, m: Manifest): Buffer` and `openManifest(ctx, sessionId, ct): Manifest`. Both validate the `v===1` shape.
  - `sealChunk(ctx, sessionId, fileId, index, pt): Buffer` and `openChunk(…, ct): Buffer`
  - `newSessionId(): string`, giving 16 random bytes as base64url.
  - `createOffer(id: Identity, peerPub: KeyObject, m: Manifest): { offer: Offer; ctx: HpkeContext }`
  - `acceptOffer(id: Identity, senderPub: KeyObject, o: Offer): { manifest: Manifest; ctx: HpkeContext }`. It throws if `o.to !== id.deviceId` or `manifest.sessionId !== o.sessionId`.
  - `exportCtx(ctx): string` and `importCtx(s): HpkeContext`, for persisting resume state.

- [ ] **Step 1: Write failing tests:**
  - `chunkCount`: 0→0, 1→1, 4194304→1, 4194305→2, `3*4194304`→3.
  - `seq layout`: `chunkSeq(0,0) === 1n<<32n`, and `chunkSeq(2,5) === (3n<<32n)|5n`.
  - `offer round trip`: a manifest with 2 files, 1 empty dir and text `"hi"` survives `createOffer` → `acceptOffer` deep-equal.
  - `offer to wrong device rejected`.
  - `chunk bound to position`: a chunk sealed at (f0,i1) fails to open at (f0,i2) and at (f1,i1).
  - `frozen vectors`: with fixed keys and skE from `chunk-v1.json`, `enc`, `sealedManifest` and chunk 0 of a 10-byte file equal the stored hex. The test generates the file when it is missing (`UPDATE_VECTORS=1`) and asserts otherwise.
- [ ] **Step 2:** Run it. Expected: it fails.
- [ ] **Step 3:** Implement `chunk.ts`.
- [ ] **Step 4:** Run it with `UPDATE_VECTORS=1` once, then without it. Expected: it passes. Commit `chunk-v1.json`.
- [ ] **Step 5:** Commit with the message `feat(core): manifest/chunk sealing with frozen cross-engine vectors`.

### Task 4: Path sanitizing + inbox storage with resume state

**Files:**
- Create: `src/sanitize.ts`, `src/inbox.ts`
- Test: `test/sanitize.test.ts`, `test/inbox.test.ts`

**Interfaces:**
- Produces:
  - `safeRelPath(p: string): string`. It splits on `/` and `\` and drops empty and `.` segments. It throws `UnsafePathError` on `..`, a leading `/` or a drive letter, NUL, or more than 32 segments. In each segment it replaces `<>:"|?*` and control characters with `_`, and prefixes Windows reserved stems (CON, PRN, AUX, NUL, COM1-9, LPT1-9) with `_`.
  - `uniqueName(dir: string, name: string): Promise<string>`, which follows the `stem (n).ext` pattern.
  - `class Inbox { constructor(root: string) }` with these methods:
    - `begin(sessionId, manifest, ctxExport): Promise<void>` writes `<root>/.meshdrop-partial/<sessionId>/state.json`.
    - `have(sessionId): Promise<HaveMap>`
    - `writeChunk(sessionId, fileId, index, pt: Buffer): Promise<void>` uses a positional write into `<fileId>.part`, and records the chunk in state only after an fsync.
    - `finalize(sessionId, fileId): Promise<string>` verifies the whole-file plaintext SHA-256 against the manifest, moves the file to `uniqueName(root/dirOf(safeRelPath(path)), base)`, and returns the final path.
    - `finalizeDirs(sessionId)`
    - `drop(sessionId)`
    - `load(sessionId): Promise<{ manifest; ctxExport } | null>`

- [ ] **Step 1: Write failing tests:**
  - `sanitize`: `"a/b.txt"`→`"a/b.txt"` and `"a\\b.txt"`→`"a/b.txt"`.
  - `../x`, `/etc/x`, `C:\\x`, `a/../../b` and `"a\u0000b"` each throw.
  - `CON.txt`→`_CON.txt` and `a:b?.txt`→`a_b_.txt`.
  - `collision`: with `photo.jpg` already present, two finalizes yield `photo (1).jpg` and `photo (2).jpg`, and the original bytes are unchanged.
  - `resume state survives restart`: write chunks 0 and 2 of 3, then build a new `Inbox` on the same root. `have()` returns `{0:[0,2]}`.
  - `hash mismatch`: `finalize` throws `IntegrityError`, and no file exists at the final path.
  - `0-byte file`: finalize with no chunks creates an empty file.
  - `empty dir`: `finalizeDirs` creates it.
  - `write failure keeps partial`: inject an fs whose write throws `ENOSPC` on the second chunk. `writeChunk` rejects, `have()` still lists the first chunk, and no final file exists.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement. The fs is injected through a constructor option `{ fs?: typeof import('node:fs/promises') }` so that tests can wrap it.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(core): safe inbox with resumable partial files`.

### Task 5: Trust store + pinned mutual TLS

**Files:**
- Create: `src/trust.ts`, `src/tls.ts`
- Test: `test/tls.test.ts`

**Interfaces:**
- Consumes: `Identity`.
- Produces:
  - `interface TrustedDevice { deviceId: string; alias: string; publicKeyPem: string; addedAt: number }`
  - `class TrustStore { constructor(file: string); list(); get(deviceId); add(d); remove(deviceId); isTrusted(deviceId): boolean }`. The file is `trust.json`, written atomically via tmp + rename.
  - `serverTlsOptions(id: Identity): tls.TlsOptions`, with `requestCert:true`, `rejectUnauthorized:false` and `minVersion:'TLSv1.3'`.
  - `peerDeviceId(sock: tls.TLSSocket): string | null`
  - `connectPinned(host: string, port: number, id: Identity, expectedDeviceId: string): Promise<tls.TLSSocket>`. It rejects with `PinMismatchError` before any application byte is sent.
  - `pinnedRequest(sock, method, path, body?: Buffer|Readable, headers?): Promise<{ status: number; json?: unknown; body: Buffer }>`, which uses `http.request({ createConnection: () => sock })`.

- [ ] **Step 1: Write failing tests:**
  - `mutual pin ok`: A serves and B connects expecting A's ID. The server sees `peerDeviceId === B.deviceId`.
  - `wrong pin rejected`: B expects device C while A answers, so the call rejects with `PinMismatchError`.
  - `trust store atomic`: `add` then a new `TrustStore` on the same file lists the device, and the tmp file is gone.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(core): pinned mTLS transport and trust store`.

### Task 6: Receiver HTTP API

**Files:**
- Create: `src/api/server.ts`
- Modify: `docs/protocol.md` (endpoint table)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `Inbox`, `TrustStore`, `acceptOffer`, `openChunk`, `serverTlsOptions` and `peerDeviceId`.
- Produces `createMeshServer(opts: { id: Identity; trust: TrustStore; inbox: Inbox; onEvent: (e: ReceiverEvent) => void }): https.Server`. Every route is under `/mesh/v1/`. A peer that isn't trusted gets `403 {"error":"untrusted"}` on every route except `info`.
  - `GET  info` returns `200 {v:1, deviceId, alias, deviceType}`.
  - `POST offer` takes an `Offer` JSON. The sender must equal `o.from`, otherwise it gets 403. It returns `200 {have: HaveMap}`. A repeat offer with the same sessionId returns the current have map, which is how resume works.
  - `PUT  chunk/:sessionId/:fileId/:index` takes a raw body of at most `CHUNK_SIZE+16` bytes and returns 204. It returns 413 if the body is too big, 422 if open fails, 404 for an unknown session, and 409 if the index is out of range.
  - `POST complete/:sessionId/:fileId` returns `200 {path}` or `422 {"error":"integrity"}`.
  - `POST finish/:sessionId` finalizes dirs and text. It emits `received` and returns `200`.
  - `POST cancel/:sessionId` drops the session and returns 204.
  - `type ReceiverEvent = {type:'offer'|'progress'|'file'|'received'|'error'|'cancelled', sessionId, from, …}`. `progress` carries `{fileId, chunks, total}`.

- [ ] **Step 1: Write failing tests**, driving the server with `connectPinned` and `pinnedRequest`:
  - `untrusted 403`.
  - `full upload`: an offer, 2 chunks, complete and finish leave a file byte-equal to the source in the inbox, and the events arrive in order.
  - `resume via re-offer`: after chunk 0 only, a re-offer returns `{have:{0:[0]}}`.
  - `bad chunk 422`: a tampered ciphertext gets 422 and is not recorded.
  - `oversize 413`.
  - `ENOSPC propagates`: an inbox with the failing fs from Task 4 makes the chunk PUT return `507` and emits an `error` event. The partial file is kept.
  - `text only`: a manifest with only `text` emits `received` carrying `text`.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement with the plain `node:https` request handler, not a framework.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(core): receiver API with resume and integrity checks`.

### Task 7: Sender sessions + multi-send

**Files:**
- Create: `src/transfer/send.ts`, `src/transfer/multisend.ts`
- Test: `test/send.test.ts`, `test/e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5 and 6.
- Produces:
  - `interface SendItem { kind: 'file'|'dir'|'text'; srcPath?: string; text?: string }`. A dir is walked recursively, its files keep relative paths, and its empty subdirs go into `dirs`.
  - `buildManifest(items: SendItem[], from: string, to: string): Promise<{ manifest: Manifest; sources: Map<number,string> }>`. It hashes each file's plaintext while walking.
  - `interface Target { deviceId: string; host: string; port: number; publicKey: KeyObject }`
  - `sendTo(id: Identity, t: Target, items: SendItem[], opts?: { onProgress?: (p:{fileId:number;sent:number;total:number})=>void; signal?: AbortSignal; outbox?: Outbox; concurrency?: number /*default 3 chunks in flight*/ }): Promise<SendResult>`
  - `type SendResult = { deviceId: string; status: 'done'|'failed'|'cancelled'; sessionId: string; error?: string }`
  - `class Outbox { constructor(dir) }` persists `{ sessionId, target, manifest, sources, ctxExport }` under `<config>/outbox/`, so a send can resume after an app restart. It has `resumeAll(id, resolveTarget): Promise<SendResult[]>`.
  - `multiSend(id, targets: Target[], items, opts?): Promise<SendResult[]>`. It runs one `sendTo` per target concurrently, and one rejection never rejects the whole. Results come back in target order.
- Retry policy: a chunk PUT is retried 3 times with backoff of 0.5, 1 and 2 s. After that the session becomes `failed` and the outbox entry is kept.

- [ ] **Step 1: Write failing tests:**
  - `send.test.ts` `exact multiple`: an 8 MiB file sends exactly 2 chunk PUTs, which you assert by counting server events.
  - `e2e.test.ts` uses 3 engines on 127.0.0.1 with distinct ports and `MESHDROP_HOME` tmp dirs, all mutually trusted:
    - `folder + text`: a dir with a nested file, an empty subdir and a 0-byte file arrives with the same structure. The text arrives too.
    - `20 MB resume`: abort via `signal` after 2 chunks, then call `sendTo` again. Only the missing chunks are PUT, and the final sha256 matches.
    - `restart resume`: abort, create a new `Outbox` on the same dir and run `resumeAll`. The send completes.
    - `multi-send isolation`: send to B and C, and close C's server after its first chunk. Expect B `done` and C `failed`, and C's outbox entry still exists. Restart C and `resumeAll` brings C to `done`.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement. The source file is read per chunk with a positional read; the whole file is never loaded.
- [ ] **Step 4:** Run the tests. Expected: they pass, and the whole suite takes under 60 s.
- [ ] **Step 5:** Commit with the message `feat(core): resumable sender and multi-send fan-out`.

### Task 8: LAN discovery

**Files:**
- Create: `src/discovery.ts`
- Test: `test/discovery.test.ts`

**Interfaces:**
- Produces:
  - `interface Announce { v: 1; deviceId: string; alias: string; deviceType: 'desktop'|'mobile'|'headless'; port: number }`
  - `class Discovery extends EventEmitter { constructor(opts: { self: Announce; group?: string /*224.0.0.168*/; port?: number /*53318*/; intervalMs?: number /*5000*/; ttlMs?: number /*15000*/; iface?: string }); start(); stop(); peers(): Array<Announce & { host: string; lastSeen: number }>; probe(host: string, port?: number): Promise<void> }`
  - Events: `'peer'` (new or changed) and `'lost'` (ttl expired).
  - The socket uses `reuseAddr:true` and `addMembership` on every IPv4 non-internal interface.
  - Malformed packets and packets from its own deviceId are ignored.
  - `probe` covers manual add and, later, subnet scan. It calls `GET /mesh/v1/info` over TLS without pinning, reads the deviceId from the certificate, and emits `'peer'` with it.

- [ ] **Step 1: Write failing tests** with two `Discovery` instances on loopback (`iface:'127.0.0.1'`) and `intervalMs:100`, `ttlMs:400`:
  - each emits `'peer'` for the other within 1 s;
  - after one stops, the other emits `'lost'`;
  - a garbage packet causes no throw and no peer;
  - `probe` against a Task 6 server yields a peer with the right deviceId.
- [ ] **Step 2:** Run the tests. Expected: they fail. If the CI kernel blocks loopback multicast, mark the multicast tests `skipIf(process.env.CI)` and keep the probe test.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(core): UDP multicast discovery + manual probe`.

### Task 9: Engine facade, CLI, protocol doc

**Files:**
- Create: `src/engine.ts`, `src/cli.ts`
- Modify: `docs/protocol.md` (complete it), `packages/core/package.json` (`bin: { meshdrop: "src/cli.ts" }` run via `node`)
- Test: `test/engine.test.ts`

**Interfaces:**
- Produces (consumed by M2's hub and M3's desktop app):
  - `class Engine extends EventEmitter { static create(opts?: { home?: string; inbox?: string; port?: number; alias?: string; deviceType?: Announce['deviceType'] }): Promise<Engine>; start(): Promise<void>; stop(): Promise<void>; readonly identity: Identity; readonly trust: TrustStore; peers(); send(deviceIds: string[] | 'all', items: SendItem[]): Promise<SendResult[]>; pairManual(host: string, port: number, alias: string): Promise<TrustedDevice> }`
  - `pairManual` is the M1-only trust bootstrap; M2 replaces it with QR plus hub membership. It probes the host and adds the device to trust. The other side must also run `pairManual`.
  - `'all'` means every trusted device currently present in `peers()`.
  - It re-emits the ReceiverEvents and the send progress as `'event'`.
- CLI commands:
  - `meshdrop id`
  - `meshdrop listen [--port] [--inbox]`
  - `meshdrop peers`
  - `meshdrop pair <host[:port]> <alias>`
  - `meshdrop send <deviceId-prefix|all> <path…> [--text "…"]`

  The exit code is 0 only when every target is `done`.

- [ ] **Step 1: Write failing tests:**
  - `engine.test.ts`: two engines `pairManual` each other, then `send('all', [file])` delivers the file and resolves to `[{status:'done'}]`.
  - `send to unknown prefix` rejects with `UnknownDeviceError`.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement the engine and CLI. Finish `docs/protocol.md` with: identity and device ID, the TLS rules, the HPKE suite and seq/AAD layout, the manifest JSON schema, the endpoint table with status codes, the resume algorithm, the announce packet, and references to the vector files.
- [ ] **Step 4:** Do a manual LAN check on the real PC. Run `MESHDROP_HOME=$(mktemp -d) node packages/core/src/cli.ts listen --port 53320` alongside a second instance on the default port, pair them, and send a 1 GB file. Expected: `done`, matching `sha256sum` on both copies, and throughput reported.
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck`. Expected: all green.
- [ ] **Step 6:** Commit with the message `feat(core): engine facade, CLI and protocol v1 doc`.

---

## Milestone roadmap (later plans)

| # | Milestone | Delivers | Depends on |
|---|---|---|---|
| M1 | Protocol + Node core | This plan. | – |
| M2 | Hub | Mesh root key and signed membership list. QR pairing with a one-time secret, where a member becomes full once the hub signs it. Revoke. Passphrase recovery file. WSS device link with 4-minute heartbeat. Relay of `offer` and `chunk` to the target. Held-file store (ciphertext, 7-day expiry, quota). Device directory with last LAN address. `--headless` mode and a systemd user unit. | M1 |
| M3 | Desktop app (Ubuntu) | Electron 42 + Vite UI: devices, send with "All devices" or a selection and per-device progress, inbox, settings. Tray, autostart, clipboard send (tray action / shortcut) and receive. QR display. Subnet scan. `.deb` via electron-builder. | M1, M2 |
| M4 | Android app | A Java engine implementing `docs/protocol.md`, passing `protocol/vectors/*`. Key in AndroidKeyStore (its built-in self-signed cert). Foreground service (verify the FGS type on API 35), MulticastLock, network callback, hub WSS. WebView UI reusing the M3 bundle through a JS bridge. MediaStore inbox. Clipboard QS tile and share target. OEM "Keep alive" checklist for stock, HiOS and HyperOS. Signed APK and an emulator smoke test in CI. | M1, M2, M3 UI |
| M5 | Guest tier + internet reach | LAN guest page (HTTP with a one-time token). Internet guest links (WebCrypto AES-GCM, key in the URL fragment, expiry, password, download cap, revoke). Tunnel management for `tailscale funnel` and `cloudflared` named tunnels. Port-forward mode: UPnP/NAT-PMP, DuckDNS, Let's Encrypt, and CGNAT detection. | M2, M3 |
| M6 | LocalSend v2 interop | Multicast on `224.0.0.167:53317` and the `/api/localsend/v2/*` routes. LocalSend peers appear as untrusted and need an accept prompt. Interop test against a real LocalSend. | M1, M3 |
| M7 | Release | GitHub repo `Hafij-DEU/meshdrop`, CI (vitest, Android emulator smoke test), App Hub and App Hub Android catalog entries. A Windows NSIS target is set up but not prioritized. | all |

**Deviation from the spec, to note:** the spec lists mDNS/DNS-SD among the discovery methods. Node has no built-in mDNS and none is cached, so M1 uses UDP multicast announce, manual add and (in M3) subnet scan. M4 can still advertise over mDNS via Android `NsdManager`. Full mDNS is added in M3 only if multicast proves unreliable on the owner's network.
