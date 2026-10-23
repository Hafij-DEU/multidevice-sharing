# MeshDrop M2: Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the owner's PC into the mesh hub. It signs the list of the owner's devices. New devices pair by QR invite. Devices that are not on the same LAN reach each other through a WebSocket relay. Files for an offline device wait on the hub until it connects.

**Architecture:**
- **Mesh root key and membership.** The hub holds a mesh root key (P-256, separate from its device key) that signs a versioned membership list. Every device stores the root public key (its "anchor") and the newest list. The list is the device's trust source, so it replaces the M1 trust store for mesh members.
- **WebSocket link.** Devices keep one WSS link to the hub and authenticate with a mutual signed challenge, which works behind tunnels.
- **Relay.** Over that link, the existing receiver API (`/mesh/v1/*`) is carried as *relay envelopes*. Each envelope is signed by the sending device's key, so the hub can route envelopes but cannot forge them.
- **Held files.** When the target is offline, the hub stores the sender's signed envelopes and replays them to the target when it connects.

**Tech Stack:**
- Node 24, TypeScript, `node:crypto` and vitest, as in M1.
- `ws@8.21.0`, already in the offline pnpm store, for the WebSocket server and client.
- `qrcode` (MIT) for showing invites in the terminal. This is the one new dependency; see Global Constraints.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`. The sections this plan builds are §3 goals 2, 4 (relay part only) and 11, §8 "Identity and pairing", "End-to-end encryption", "Hub connection while away" and "Held files", and §9's reconnect behaviour.

**Wire spec:** this plan extends `docs/protocol.md` with new sections. The M4 Java engine will implement those sections.

This is plan 2 of 7. Tunnel and port-forward management, internet guest links, and the browser guest page are M5. In M2, the hub is reached through:
- a LAN address (pinned TLS);
- a configured public `wss://` URL (CA-validated TLS), which M5's tunnels will point at the loopback ingress port defined here.

## Global Constraints

- All M1 Global Constraints still apply:
  - Node `v24.22.0`, ESM, TS `strict`, `.ts` import extensions, `pnpm@10.33.4`, `pnpm install --offline`.
  - Every primitive comes from `node:crypto`.
  - TLS minimum is `'TLSv1.3'`.
  - Commits use `git -c user.name=Hafij-BGE -c user.email=mdhafijur.rahman@ogr.deu.edu.tr`, and each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Dependencies.**
  - `ws@8.21.0` is cached. Add it with `pnpm add ws@8.21.0 --offline`, plus `@types/ws` if it is cached; otherwise write a local `ws.d.ts` declaring only the API that is used.
  - `qrcode` is the only new network dependency. Justification: invites must be shown as a QR code (spec §3.5 and §8), and M3's UI needs the same encoder. Install it once with `pnpm add qrcode` while online, after which it is cached.
  - Anything else needs a written justification.
- **Signatures.** All are ECDSA P-256 with SHA-256 in **DER** encoding, which is the `crypto.sign` default and Java's `SHA256withECDSA`.
  - Messages are domain-separated by an ASCII prefix that ends in `\0`.
  - Signed JSON is serialized with **canonical JSON** (Task 1).
- **Mesh root key.**
  - It lives in `<home>/hub/root-key.pem` as PKCS8, mode `0600`, in a directory with mode `0700`.
  - The mesh id is the lowercase hex SHA-256 of the root SPKI DER.
- **Device-side mesh state:** `<home>/mesh/anchor.pem` (root SPKI PEM) and `<home>/mesh/membership.json` (the newest signed list). Both are written atomically with mode `0600`.
- **Hub endpoints:**
  - The WebSocket path is `/mesh/v1/hub` on the mesh HTTPS port (`53318`, mTLS, LAN).
  - A loopback plain-HTTP ingress listens on `127.0.0.1:53319` for tunnels (M5). It carries the same WebSocket path, and authentication is application-level only.
  - The WebSocket `maxPayload` is `MAX_OFFER_BODY + 64 KiB`.
- **Timing:**
  - Heartbeat: a ping every `240_000` ms.
  - The hub marks a device offline after `510_000` ms without traffic.
  - Client reconnect backoff: `[1000, 2000, 5000, 10000, 30000, 60000]` ms, capped at the last value.
- **Invites:**
  - The secret is 16 random bytes and expires after `300_000` ms (5 min).
  - Each invite allows at most 5 proof attempts, after which it is burned.
  - Invites are single-use.
- **Held store:**
  - Location: `<home>/hub/held/`.
  - Default quota: `20 * 1024**3` bytes in total.
  - Default TTL: `7 * 24 * 3600 * 1000` ms.
- **Recovery file:** scrypt with `N=131072, r=8, p=1, maxmem=256 MiB`, a 16-byte salt, and AES-256-GCM with a 12-byte nonce.
- **Protocol stability:** the HPKE suite, the chunk format and the M1 endpoints keep working unchanged on the LAN. Every new wire format goes into `docs/protocol.md`, with frozen vectors in `protocol/vectors/`.

## Review Focus

1. **Lost hub connection mid-transfer.** If the hub restarts or the link drops during a relayed transfer, the sender resumes over relay or LAN from the chunks the receiver already has. No duplicate file is produced, and the user does not have to restart the send. Tested in Task 10.
2. **Membership rollback or cross-mesh lists.** An older list that is validly signed, a list from another mesh's root, or a list with a broken signature is rejected, and the device keeps its current list. Tested in Task 2.
3. **Revoked device.** A revoked device must not hot-loop reconnecting. It gets one `revoked` notice, stops its hub client and drops the mesh state; its own identity stays. Its LAN and relay requests are refused everywhere at once. Tested in Task 12.
4. **Full held store.** When the quota is exceeded or the hub disk is full, the sender gets `failed` with `hub-quota` or `hub-no-space`, the outbox entry is kept, and the hub keeps no partial junk for that session. Tested in Task 9.
5. **Clock skew between devices.** Invite expiry and held TTL are judged only on the clock of the device that enforces them (inviter or hub). A joining device whose clock is wrong by a day still joins. Tested in Task 11.

---

## File Structure

```
packages/core/src/
  mesh/canonical.ts      # canonical JSON + domain-separated ECDSA sign/verify helpers
  mesh/membership.ts     # MembershipList type, validate, sign (root), verify (anchor)
  mesh/rootkey.ts        # hub: load/create mesh root key
  mesh/members.ts        # device: MembershipStore (anchor + newest list) + CompositeTrust
  mesh/recovery.ts       # passphrase-encrypted root-key + list export/import
  mesh/envelope.ts       # signed relay envelopes + binary frame codec + replay guard
  mesh/invite.ts         # invite secret, join URI, HMAC proof
  api/handler.ts         # transport-independent receiver handler (extracted from server.ts)
  api/server.ts          # HTTPS adapter over handler.ts + /mesh/v1/join + membership routes
  hub/server.ts          # HubServer: WS auth, registry, directory, authority, relay routing, invites
  hub/held.ts            # HeldStore: on-disk signed envelopes, quota, TTL, replay order
  hub/client.ts          # HubClient: device-side link, auth, reconnect, heartbeat, inbound relay
  transfer/transport.ts  # Transport interface; LanTransport (pinned TLS), RelayTransport (hub)
  transfer/send.ts       # modified: requests go through a Transport; 'held' result
  engine.ts / cli.ts     # integration + commands
packaging/systemd/meshdrop.service   # user unit for headless hub
protocol/vectors/{canonical-v1.json, membership-v1.json, envelope-v1.json, invite-v1.json, recovery-v1.json}
```

## Shared Types (defined in the task named; used later)

```ts
// mesh/membership.ts (Task 2)
export interface Member { deviceId: string; alias: string; publicKeyPem: string; role: 'hub' | 'member'; addedAt: number }
export interface MembershipList { v: 1; mesh: string; version: number; issuedAt: number;
  hub: { deviceId: string; urls: string[] }; members: Member[]; revoked: { deviceId: string; revokedAt: number }[] }
export interface SignedMembership { list: MembershipList; sig: string /* b64 DER over canonical(list) */ }
// api/handler.ts (Task 4)
export interface MeshRequest { peer: string | null; method: string; path: string; headers: Record<string, string>; body: Readable }
export interface MeshResponse { status: number; headers: Record<string, string>; body: Buffer }
export interface TrustSource { isTrusted(deviceId: string): boolean; get(deviceId: string): TrustedDevice | undefined }
// transfer/transport.ts (Task 10)
export interface Transport { readonly kind: 'lan' | 'relay' | 'held';
  request(method: string, path: string, body: Buffer | Readable | undefined, headers: Record<string, string>,
          opts: { timeoutMs: number; signal?: AbortSignal }): Promise<PinnedResponse> }
```

---

### Task 1: Canonical JSON and signing helpers

**Files:** Create `src/mesh/canonical.ts` and `protocol/vectors/canonical-v1.json`. Test: `test/canonical.test.ts`.

**Interfaces:**
- Produces:
  - `canonicalJson(v: unknown): string`. Object keys are sorted by UTF-16 code unit, there is no whitespace, and strings use the escaping of `JSON.stringify`. Numbers must be safe integers; anything else throws `CanonicalError`, as do `undefined`, functions and NaN.
  - `signDomain(domain: string, payload: Buffer | string, key: KeyObject): string` returns base64 DER of the signature over `utf8(domain) ‖ 0x00 ‖ payload`.
  - `verifyDomain(domain, payload, sigB64, pub: KeyObject): boolean` returns false on any malformed input and never throws.
  - `spkiSha256(pub: KeyObject): string` returns hex.

- [ ] **Step 1: Write the failing tests.**
  - `canonicalJson({b:1,a:[{d:2,c:"é\n"}]}) === '{"a":[{"c":"é\\n","d":2}],"b":1}'`
  - `1.5`, `2**53` and `NaN` throw `CanonicalError`.
  - A sign/verify round trip passes; flipping one payload byte, using a different domain, or passing a garbage base64 signature all give `false`.
  - The frozen vector `canonical-v1.json` (inputs and canonical strings) matches. The test regenerates it only when `UPDATE_VECTORS=1`, as in M1.
- [ ] **Step 2:** Run `pnpm vitest run test/canonical.test.ts`. Expected: it fails because the module is missing.
- [ ] **Step 3:** Implement `canonicalJson`, `signDomain`, `verifyDomain` and `spkiSha256` with `crypto.sign(null|'sha256')`.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(mesh): canonical JSON and domain-separated signatures`.

### Task 2: Membership list, root key, MembershipStore

**Files:** Create `src/mesh/membership.ts`, `src/mesh/rootkey.ts`, `src/mesh/members.ts` and `protocol/vectors/membership-v1.json`. Modify `src/api/server.ts`, changing the `trust` option type to `TrustSource`, which is exported from `src/api/handler.ts` in Task 4. Until then, define it in `src/trust.ts` and re-export it. Tests: `test/membership.test.ts` and `test/members.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `MEMBERSHIP_DOMAIN = 'meshdrop-membership-v1'`
  - `validateList(l: unknown): MembershipList`. It checks the shape, that deviceIds are 64-hex and unique, that exactly one member has `role:'hub'` and that it equals `hub.deviceId`, that every `publicKeyPem` is a P-256 SPKI (reuse the trust.ts check), that the version is an integer of at least 1, that no revoked id appears in `members`, and that there are at most 256 members. Errors throw `MembershipError`.
  - `signList(l: MembershipList, rootKey: KeyObject): SignedMembership`
  - `verifySigned(s: SignedMembership, anchor: KeyObject): MembershipList`. It checks the signature and that `list.mesh === spkiSha256(anchor)`, then validates.
  - `loadOrCreateRootKey(home: string): Promise<KeyObject>` and `hasRootKey(home): Promise<boolean>`
  - `class MembershipStore`:
    - `static load(home): Promise<MembershipStore | null>`
    - `static init(home, anchorPub: KeyObject, s: SignedMembership): Promise<MembershipStore>`
    - `readonly anchor`, `current(): SignedMembership`, `list(): MembershipList`
    - `accept(s: SignedMembership): 'updated' | 'same' | 'stale'`. It verifies against the anchor; a lower version gives `'stale'` and changes nothing; the same version with a different signature or list throws `MembershipError('fork')`.
    - `isTrusted(id)` and `get(id): TrustedDevice | undefined`. Members map to `TrustedDevice`. Revoked ids are never trusted. The device's own id is not trusted unless it is a member.
  - `class CompositeTrust implements TrustSource`, constructed as `new CompositeTrust(members: MembershipStore | null, manual: TrustSource)`. It trusts mesh members, plus M1 manual-paired devices that are not revoked in the mesh list. The mesh list wins on alias and key.

- [ ] **Step 1: Write the failing tests.**
  - `sign → verify` round trip.
  - Tampering with a member alias makes `verifySigned` throw.
  - A list signed by a different root key throws.
  - A list whose `mesh` field does not equal the anchor hash throws.
  - **Review Focus #2 tests:**
    - `accept(v3)` gives `'updated'`.
    - `accept(v2)` then gives `'stale'` and the list is still v3.
    - `accept(v3)` with a different body throws `fork`.
    - `accept` of a list signed by a foreign root throws, and the current list is unchanged.
    - Each persisted file is reloaded and checked to still hold the same state.
  - Revoked id: `isTrusted` is false even if a manual TrustStore lists it.
  - `validateList` rejects:
    - two hub-role members;
    - a duplicate deviceId;
    - a non-P-256 key;
    - a revoked id that is also a member;
    - 257 members.
  - `loadOrCreateRootKey` is stable across calls, and the file mode is `0o600`.
  - Frozen `membership-v1.json` holds the fixed root key, the list, its canonical bytes and the signature. Signatures are randomized, so assert `verifySigned` on the stored signature and byte equality of the canonical form.
- [ ] **Step 2:** Run `pnpm vitest run test/membership.test.ts test/members.test.ts`. Expected: they fail.
- [ ] **Step 3:** Implement. Writes use tmp + fsync + rename at `0600`, as in `trust.ts`.
- [ ] **Step 4:** Run the tests, then `pnpm test && pnpm typecheck`. Expected: all green.
- [ ] **Step 5:** Commit with the message `feat(mesh): signed membership list, root key, MembershipStore`.

### Task 3: Recovery file

**Files:** Create `src/mesh/recovery.ts` and `protocol/vectors/recovery-v1.json`. Test: `test/recovery.test.ts`.

**Interfaces:**
- Produces:
  - `exportRecovery(rootKey: KeyObject, s: SignedMembership, passphrase: string): string`. The result is the JSON text `{v:1,kdf:'scrypt',N:131072,r:8,p:1,salt,nonce,ct}`, with base64 fields. The plaintext is `canonicalJson({rootKeyPem, membership: s})`, and the AAD is `utf8('meshdrop-recovery-v1')`.
  - `importRecovery(text: string, passphrase: string): { rootKey: KeyObject; membership: SignedMembership }`. A wrong passphrase or tampering throws `RecoveryError('bad-passphrase-or-corrupt')`. The membership is verified against the root key inside the file.
  - `MIN_PASSPHRASE_CHARS = 10`. A shorter passphrase makes `exportRecovery` throw.

- [ ] **Step 1: Write the failing tests.**
  - A round trip restores the same root SPKI and the same membership.
  - A wrong passphrase throws `RecoveryError`.
  - One flipped `ct` byte throws.
  - A 9-character passphrase throws on export.
  - The frozen vector with a fixed salt and nonce (test-only parameters) decrypts to the expected plaintext.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement with `scryptSync(passphrase, salt, 32, {N, r, p, maxmem: 256 * 1024 ** 2})` and AES-256-GCM.
- [ ] **Step 4:** Run the tests. Expected: they pass. Then run the full suite.
- [ ] **Step 5:** Commit with the message `feat(mesh): passphrase recovery file for the root key and membership`.

### Task 4: Transport-independent receiver handler

**Files:** Create `src/api/handler.ts`. Modify `src/api/server.ts` to become a thin HTTPS adapter. Test: `test/handler.test.ts`. The existing `test/server.test.ts` must pass unchanged.

**Interfaces:**
- Consumes: the M1 server internals (route functions, the error mapping, `withSessionLock`).
- Produces:
  - `createMeshHandler(opts: MeshServerOptions & { trust: TrustSource }): { handle(req: MeshRequest): Promise<MeshResponse>; info(): object }`.
  - Inside, all M1 routes, status codes, body caps and events are unchanged.
  - The caller supplies `peer`: the TLS peer on LAN, the verified envelope `from` on relay.
  - `peer === null` gets only `GET info`. Body caps are enforced while reading `req.body`, and an over-cap body gives 413 `too-large`.
  - `createMeshServer` now builds `MeshRequest` from `IncomingMessage` (with `peer = peerDeviceId(socket)`) and writes the `MeshResponse`. It keeps the 413-then-close behaviour and the `tlsClientError` swallowing.

- [ ] **Step 1: Write the failing tests in `handler.test.ts`, calling the handler with no network:**
  - `peer:null` POST offer gives 403 untrusted.
  - A full offer, chunk, complete and finish sequence with an in-memory `Readable` body gives a file whose bytes equal the source.
  - A chunk body of `MAX_CHUNK_BODY + 1` gives 413.
  - A throwing handler dependency gives 500 `internal` with no detail.
- [ ] **Step 2:** Run `pnpm vitest run test/handler.test.ts`. Expected: it fails.
- [ ] **Step 3:** Move the route logic into `handler.ts`. `server.ts` keeps only the adapter.
- [ ] **Step 4:** Run `pnpm vitest run test/handler.test.ts test/server.test.ts test/e2e.test.ts`. Expected: all pass, with `server.test.ts` unmodified.
- [ ] **Step 5:** Commit with the message `refactor(core): transport-independent receiver handler`.

### Task 5: Relay envelopes

**Files:** Create `src/mesh/envelope.ts` and `protocol/vectors/envelope-v1.json`. Test: `test/envelope.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `ENVELOPE_DOMAIN = 'meshdrop-envelope-v1'`.
  - Types:
    - `EnvelopeHeader = { v:1; kind:'req'|'res'; id: string /*16B b64url*/; from: string; to: string; method?: string; path?: string; status?: number; contentType?: string; bodySha256: string; holdBytes?: number; sig: string }`
    - `Envelope = { header: EnvelopeHeader; body: Buffer }`
  - `sealEnvelope(h: Omit<EnvelopeHeader,'sig'|'bodySha256'>, body: Buffer, key: KeyObject): Envelope`. The signature covers `canonicalJson(header without sig)`.
  - `openEnvelope(e: Envelope, pubOf: (id: string) => KeyObject | undefined): EnvelopeHeader`. It throws `EnvelopeError` on any of:
    - an unknown `from`;
    - a bad signature;
    - a body hash mismatch;
    - a `req` with no method/path, or with a path outside `/mesh/v1/`;
    - a `res` with no status.
  - `encodeFrame(e): Buffer` produces `u32be(headerLen) ‖ utf8(canonicalJson(header)) ‖ body`. `decodeFrame(buf): Envelope` enforces `headerLen ≤ 16384`.
  - `class ReplayGuard { constructor(max = 10_000, ttlMs = 600_000); seen(id: string): boolean }`. It returns true for a repeat within the TTL.
- [ ] **Step 1: Write the failing tests.**
  - A round trip of `req` and `res` works.
  - Each of these throws: a modified path, `to`, `status` or body; an unknown `from`; `headerLen` above 16384; a truncated frame; and `path: '/etc/passwd'`.
  - `ReplayGuard` reports a repeat id as seen, and forgets it after the TTL (use a fake clock option).
  - The frozen vector holds a fixed key, the header, the canonical header bytes, the frame bytes, and a signature that verifies.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(mesh): signed relay envelopes and frame codec`.

### Task 6: HubServer: link, authentication, registry, directory, membership authority

**Files:** Create `src/hub/server.ts`. Test: `test/hub-server.test.ts`.

**Interfaces:**
- Consumes: Tasks 1, 2, 5, `ws`, `Identity`, and `serverTlsOptions`.
- Produces `class HubServer extends EventEmitter`:
  - `constructor(opts: { id: Identity; home: string; rootKey: KeyObject; members: MembershipStore; heartbeatTimeoutMs?: number; now?: () => number })`
  - `attach(server: https.Server): void` handles `upgrade` on `/mesh/v1/hub`.
  - `listenIngress(port = 53319): Promise<number>` is plain HTTP on `127.0.0.1` only.
  - `close(): Promise<void>`
  - `online(): string[]`
  - `directory(): DirectoryEntry[]`, where `DirectoryEntry = { deviceId; online: boolean; lastSeen: number; lanAddrs: {host: string; port: number}[] }`.
  - `addMember(m: Omit<Member,'role'|'addedAt'>): Promise<SignedMembership>`
  - `revoke(deviceId): Promise<SignedMembership>`
  - `setUrls(urls: string[]): Promise<SignedMembership>`
  - Every list change bumps the version, signs, persists through `members.accept`, and pushes `{t:'membership', s}` to every online device.
- Handshake (text frames JSON; anything else, or a timeout of `10_000` ms, closes the socket with code `4401`):
  1. Hub sends `{t:'hello', v:1, hub: <hub deviceId>, nonce: b64(32)}`.
  2. Device sends `{t:'auth', deviceId, cert: b64 DER, nonce: b64(32), sig, lan: [{host,port}], mv: <list version>}`. `sig = signDomain('meshdrop-hub-auth-v1', hub+'\0'+deviceId+'\0'+hubNonce, deviceKey)`. The hub checks that `deviceId === sha256(cert)`, that the signature verifies with the cert key, and that `members.isTrusted(deviceId)`.
  3. Hub sends `{t:'welcome', sig: signDomain('meshdrop-hub-auth-v1', 'hub\0'+deviceId+'\0'+deviceNonce, hubDeviceKey), membership?: SignedMembership /* if mv < current */, directory}`.
- When the link is on the mTLS port and the TLS peer certificate is present, it must equal `deviceId`; a mismatch closes with `4401`.
- A revoked or unknown device gets `{t:'revoked'}` and close code `4403`.
- A newer connection for the same device replaces the older one, which is closed with `4409`.
- Directory changes are pushed as `{t:'directory', devices}`.
- [ ] **Step 1: Write the failing tests.** They use a real `HubServer` on an ephemeral mTLS port and a hand-rolled `ws` client:
  - A member authenticates and gets `welcome`. The test verifies the hub's signature against the hub member key.
  - A bad signature gives close `4401`.
  - A cert that does not hash to `deviceId` gives `4401`.
  - A non-member gets `revoked` and `4403`.
  - A TLS peer different from `deviceId` gives `4401`.
  - Sending no auth within the timeout gives `4401` (use a short `heartbeatTimeoutMs` option for the test).
  - `addMember` pushes the new list to an online member, and its version is the old version plus 1.
  - `revoke(B)` closes B with `4403` and pushes the list to A.
  - A second link for A closes the first with `4409`.
  - The directory shows A online with its `lan`, and offline after the heartbeat timeout.
  - The ingress port is bound to `127.0.0.1`, so connecting to the LAN IP fails.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement on `ws` `WebSocketServer({ noServer: true, maxPayload })`.
- [ ] **Step 4:** Run the tests 3 times. Expected: they pass each time.
- [ ] **Step 5:** Commit with the message `feat(hub): authenticated WSS link, directory and membership authority`.

### Task 7: HubClient (device side)

**Files:** Create `src/hub/client.ts`. Test: `test/hub-client.test.ts`.

**Interfaces:**
- Consumes: Task 6 protocol, Task 2 `MembershipStore`, Task 5 envelopes, and Task 4 `handle`.
- Produces `class HubClient extends EventEmitter`:
  - `constructor(opts: { id: Identity; members: MembershipStore; handler: (r: MeshRequest) => Promise<MeshResponse>; lanAddrs: () => {host: string; port: number}[]; hubLan?: () => {host: string; port: number} | undefined; backoffMs?: number[]; pingMs?: number })`
  - `start(): void` and `stop(): Promise<void>`
  - `readonly state: 'idle' | 'connecting' | 'online' | 'revoked'`
  - `directory(): DirectoryEntry[]`
  - `request(e: Envelope, timeoutMs: number, signal?: AbortSignal): Promise<Envelope>` resolves with the matching `res` by `id`. It rejects with `HubOfflineError` when not online and `RelayTimeoutError` on timeout.
  - Events: `online`, `offline`, `membership` (after `accept` returns `updated`), `directory`, `revoked`, `held-delivered`, and `held-failed`.
- Connection order:
  1. The hub's LAN address, if `hubLan()` returns one. This uses `wss://host:port/mesh/v1/hub` with the client certificate and checks the hub pin with `deviceIdOf(peer cert) === list.hub.deviceId`.
  2. Each URL in `list.hub.urls`, with standard CA validation.
- After `welcome` the client verifies the hub signature against the member key of `list.hub.deviceId`. A failure closes the link and counts as a failed attempt.
- Inbound `req` frames:
  - `openEnvelope` with member keys;
  - drop it if the `ReplayGuard` has seen the id;
  - `handler({peer: header.from, …})`;
  - reply with a `res` sealed with the device key, `to` = original `from`.
- Backoff is `[1000, 2000, 5000, 10000, 30000, 60000]` ms. It resets after an `online` that lasts 60 s.
- A ping is sent every `240_000` ms.
- On `{t:'revoked'}` or close `4403`, the client sets `state='revoked'`, emits `revoked` and **does not reconnect**.
- [ ] **Step 1: Write the failing tests** against a real `HubServer` from Task 6:
  - The client goes online, and `membership` updates are accepted (the version advances).
  - A stale list pushed by a fake hub is ignored.
  - A fake hub with a wrong welcome signature means the client never reaches `online`.
  - The hub is closed and restarted: the client reconnects after the first backoff delay. Use a `backoffMs: [50, 50]` test override.
  - **Review Focus #3:** after `revoke`, the client emits `revoked` once, makes no further connection attempts within 1 s (count connections on the server), and `state === 'revoked'`.
  - An inbound `req` with a forged signature is never passed to the handler.
  - A replayed `req` id is handled only once.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests 3 times. Expected: they pass each time.
- [ ] **Step 5:** Commit with the message `feat(hub): device-side hub client with reconnect and inbound relay`.

### Task 8: Relay routing on the hub

**Files:** Modify `src/hub/server.ts`. Test: `test/relay.test.ts`.

**Interfaces:**
- Consumes: Tasks 5, 6 and 7.
- Behaviour:
  - A binary frame from authenticated device A is checked with `decodeFrame` and `openEnvelope`. The hub requires `header.from === A`, `kind === 'req'`, and that `to` is a member other than A. On failure it replies with a hub-signed `res` (`from` = hub deviceId), `status 400`, body `{"error":"bad-envelope"}`.
  - If `to` is online, the hub forwards the frame unchanged and forwards the target's `res` back. The `res` must have `from === to` and `to === A`; a mismatched `res` is dropped.
  - If the target does not answer within `600_000` ms, the hub replies with a hub-signed `504 {"error":"relay-timeout"}`.
  - If `to` is offline and `header.holdBytes` is absent, the hub replies with a hub-signed `503 {"error":"offline"}`. When `holdBytes` is present, Task 9 handles it.
  - Senders accept hub-signed responses only for the error codes above.
- [ ] **Step 1: Write the failing tests** with a hub and two `HubClient`s whose handlers are real `createMeshHandler`s with temp inboxes. LAN is unused.
  - A sends a full session to B through `client.request`: offer, chunks, complete, finish. B's inbox has the file, and its sha256 matches.
  - A sends to offline C and gets 503 `offline`.
  - A forges `from: B` and gets 400 `bad-envelope`. Nothing reaches B.
  - B's `res` that claims `from: C` is dropped, and A gets 504 within the test-shortened timeout.
  - The hub never sees plaintext: assert that the plaintext marker bytes do not appear in any frame it routes, by capturing them through a test hook.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(hub): relay routing of signed envelopes`.

### Task 9: Held files

**Files:** Create `src/hub/held.ts`. Modify `src/hub/server.ts`. Test: `test/held.test.ts`.

**Interfaces:**
- Consumes: Tasks 5, 6 and 8.
- Produces:
  - `class HeldStore`:
    - `constructor(dir: string, opts?: { quotaBytes?: number; ttlMs?: number; now?: () => number; fs?: typeof nodeFs })`
    - `put(e: Envelope): Promise<HeldReply>`
    - `pending(to: string): Promise<HeldSession[]>`
    - `remove(to: string, sessionId: string): Promise<void>`
    - `prune(): Promise<number>`
  - `HeldReply = { status: number; body: object }`
  - `HeldSession = { to; from; sessionId; envelopes: () => AsyncIterable<Envelope> }`, where envelopes come back in replay order: offer, chunks in (fileId, index) order, complete per file, finish.
- On-disk layout is `held/<to>/<sessionId>/`:
  - `meta.json` holds `{from, holdBytes, createdAt, completes: number[], finished: bool}`;
  - `offer.env`;
  - `c-<fileId>-<index>.env`;
  - `complete-<fileId>.env`;
  - `finish.env`.

  Writes use tmp + fsync + rename.
- The hub's synthetic replies to the sender are hub-signed `res` envelopes:
  - **Offer** with `holdBytes`: it checks `holdBytes ≤ quota − used` (otherwise `507 {"error":"hub-quota"}`) and stores the offer. The reply is `200 {"have": <chunks already stored for this session, by verified bodySha256>, "held": true}`.
  - **Chunk:** it stores the chunk and replies 204. Storing re-checks `sha256(body) === header.bodySha256`; this is the ciphertext-hash resume from spec §8.
  - **Complete:** replies `200 {"held":true}`.
  - **Finish:** replies `200 {"held":true}` and marks the session ready.
  - An `ENOSPC` while writing gives `507 {"error":"hub-no-space"}`.
  - After a terminal 507, the session directory is deleted.
- **Replay:** when the target authenticates, the hub replays each ready session through the relay path, waiting for each real `res`.
  - When `finish` returns 200, it sends `{t:'held-delivered', to, sessionId, files}` to the sender (queued in `meta.json` if the sender is offline) and deletes the session.
  - A 4xx `res` (terminal) sends `{t:'held-failed', to, sessionId, status, error}` and deletes the session.
  - Transient failures (5xx, or the link closing) leave the session for the next connect.
- `prune()` deletes sessions older than the TTL, judged by the hub clock (`now`). It runs at hub start and hourly.
- [ ] **Step 1: Write the failing tests.**
  - A sends to offline B with `holdBytes` and gets synthetic 200/204 replies. The store has the session.
  - B connects, and B's inbox ends up with the file (sha256 matches). A gets `held-delivered`, and the store is empty.
  - A re-offers the same held session after a sender restart and gets `have` listing the stored chunks, so only the missing chunks are re-sent.
  - **Review Focus #4:**
    - `holdBytes` over the quota gives `507 hub-quota`, and `held/` contains nothing for that session.
    - An injected fs throwing `ENOSPC` on a chunk gives `507 hub-no-space`, and the session directory is removed.
  - TTL: a fake `now` advanced by 7 d plus 1 ms makes `prune()` delete the session.
  - B's handler returning 422 on replay gives A `held-failed`, and the session is deleted.
  - B disconnecting mid-replay keeps the session, and B's next connect completes it.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests 3 times. Expected: they pass each time.
- [ ] **Step 5:** Commit with the message `feat(hub): held-file store with quota, TTL and replay`.

### Task 10: Sender transports and path choice

**Files:** Create `src/transfer/transport.ts`. Modify `src/transfer/send.ts` and `src/transfer/multisend.ts`. Test: `test/transport.test.ts`. The existing `send.test.ts` and `e2e.test.ts` must pass unchanged.

**Interfaces:**
- Consumes: Tasks 5, 7, 8 and 9, and M1 `send.ts`.
- Produces:
  - `class LanTransport implements Transport`, constructed as `new LanTransport(id, target: Target, connectTimeoutMs)`. It is the M1 `connectPinned` + `pinnedRequest` path moved out of `send.ts`.
  - `class RelayTransport implements Transport`, constructed as `new RelayTransport(id, hub: HubClient, to: string, pubOf: (id) => KeyObject | undefined, mode: 'relay' | 'held', holdBytes?: number)`.
    - It seals a `req` envelope; in `'held'` mode only the offer carries `holdBytes`.
    - It verifies the `res` envelope's `from`: it must be the target, or the hub for the codes in Task 8/9.
    - It maps the result to `PinnedResponse` (`status`, `json` when the content type is `application/json`, `body`).
    - `HubOfflineError` and `RelayTimeoutError` are transient for the M1 retry logic.
  - Changes to `SendOptions`:
    - `transport?: (t: Target) => Transport | Promise<Transport>`. The default is `LanTransport`, which keeps M1 behaviour.
    - `SendResult.status` gains `'held'`. A session whose `finish` reply carries `{held:true}` ends as `'held'`, and its outbox entry is removed (the hub owns delivery from then on).
    - `postCancel` goes through the same transport.
  - `Target.host` and `Target.port` become optional (`host?: string; port?: number`). `LanTransport` throws `NoRouteError` (non-transient) if they are missing.
- [ ] **Step 1: Write the failing tests.**
  - `sendTo` with a `RelayTransport` delivers a 3-chunk file through a hub.
  - With `mode 'held'` and the target offline, the result is `'held'` and the outbox entry is removed. After the target comes online, its inbox has the file.
  - **Review Focus #1:**
    1. Start a relay send.
    2. Close the hub after the first chunk, wait, and restart it.
    3. Re-run `sendTo` with the same outbox.

    Expected: the result is `done`, the receiver stored each chunk index exactly once (use the `test/engines.ts` write recorder), and there is exactly one final file.
  - A switch from relay to LAN mid-session (first run on relay, aborted; resumed with `LanTransport`) resumes without re-sending stored chunks.
  - Run the M1 `send.test.ts` and `e2e.test.ts` unchanged; they pass.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement. `call()` in `send.ts` takes a `Transport` instead of calling `connectPinned` directly.
- [ ] **Step 4:** Run the full suite. Expected: all pass.
- [ ] **Step 5:** Commit with the message `feat(core): pluggable transports (LAN, relay, held) for the sender`.

### Task 11: QR invites and joining

**Files:** Create `src/mesh/invite.ts` and `protocol/vectors/invite-v1.json`. Modify `src/api/handler.ts` (route `POST /mesh/v1/join`, open to `peer` that is not trusted), `src/hub/server.ts` (`t:'invite'` registration and the `t:'join'` first message) and `src/hub/client.ts` (`registerInvite`). Test: `test/invite.test.ts`.

**Interfaces:**
- Consumes: Tasks 2, 4, 6 and 7.
- Produces:
  - `interface Invite { secret: Buffer /*16*/; inviter: string; mesh: string; lan: {host: string; port: number}[]; hubUrls: string[]; expiresAt: number }`
  - `inviteUri(i: Invite): string`, of the form `meshdrop://join?v=1&s=<b64url>&i=<inviter>&r=<mesh>&l=<host:port>…&h=<url>…&e=<epoch s>`. Query parameter order is fixed as written, `l` and `h` repeat, and values are URI-encoded.
  - `parseInviteUri(s: string): Invite` throws `InviteError` on any malformed field.
  - `joinProof(secret: Buffer, newId: string, inviter: string): string`, which is base64 of `HMAC-SHA256(secret, 'meshdrop-join-v1\0' + newId + '\0' + inviter)`.
  - `class InviteBook`:
    - `constructor(now = Date.now)`
    - `create(inviter, mesh, lan, hubUrls): Invite`
    - `register(i: Invite): void`, which the hub uses for invites created on other devices
    - `consume(newId: string, inviter: string, proof: string): 'ok' | 'expired' | 'used' | 'bad-proof' | 'unknown' | 'burned'`. At most 5 attempts are allowed. The comparison is timing-safe, and expiry is judged by its own `now()` only.
- **Join over LAN** (`POST /mesh/v1/join`; the new device connects with `connectPinned` to `inviter`):
  - Request: `{deviceId (must equal the TLS peer), alias, proof}`.
  - The inviter consumes the proof from its `InviteBook`.
  - If the inviter is the hub, or its `HubClient` is online, the hub signs the new list. The inviter sends `{t:'join', newMember, inviteSecret}` over the link for a non-hub inviter. The reply is `200 {status:'member', anchorPem, membership}`.
  - Otherwise the reply is `200 {status:'provisional', anchorPem, inviterKeyPem}`. The inviter records a provisional manual trust in its M1 TrustStore and queues the join, which it sends on its next hub connection.
- **Join over the internet:** the first message on `/mesh/v1/hub` is `{t:'join', deviceId, cert, alias, proof, inviter, nonce, sig}` instead of `auth`. The hub consumes the invite registered by the inviter, adds the member, and replies `welcome` with `membership` and `anchorPem`.
- **Joining device:** it checks `spkiSha256(anchor) === invite.mesh`, then `verifySigned`, then that it is listed in the members, then `MembershipStore.init`. If the anchor check fails, nothing is stored.
- [ ] **Step 1: Write the failing tests.**
  - URI round trip; each malformed field throws.
  - `consume`:
    - a good proof gives `ok` once, then `used`;
    - a wrong proof gives `bad-proof`; after 5 attempts the result is `burned`, even with the right proof;
    - an expired invite (fake `now`) gives `expired`.
  - Join over LAN with the hub as inviter: the new device becomes a member and A sees the pushed list.
  - Join over LAN with a non-hub inviter and the hub offline: the result is `provisional`. When the inviter later reconnects, the hub adds the member, and the new device authenticates as a member.
  - Join over the internet through the hub only: the new device becomes a member.
  - A wrong root hash in the URI makes the joining device refuse and store nothing.
  - **Review Focus #5:** the joining device's `now` is skewed by +1 day, using a test clock on its side; the join still succeeds because only the inviter's clock is consulted.
  - Frozen `invite-v1.json` holds the URI and proof for fixed values.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests 3 times. Expected: they pass each time.
- [ ] **Step 5:** Commit with the message `feat(mesh): QR invites and join over LAN or hub`.

### Task 12: Revocation and membership propagation

**Files:** Modify `src/api/handler.ts` (`GET /mesh/v1/membership` for members only; `info` gains `mv`), `src/hub/client.ts` and `src/engine.ts` (only the hooks needed here). Test: `test/revoke.test.ts`.

**Interfaces:**
- `GET /mesh/v1/membership` returns `200 SignedMembership` to trusted peers.
- `GET info` adds `mv: number`, which is 0 when the device is not in a mesh.
- When a device sees a peer `info` with a higher `mv`, through probe or discovery, it fetches the list and runs `accept`. This propagates lists over the LAN while the hub is offline.
- On `revoked` the engine stops its `HubClient`, deletes `<home>/mesh/` and keeps its identity. It then emits `{source:'mesh', type:'revoked'}`.
- [ ] **Step 1: Write the failing tests.**
  - The hub revokes B. A's receiver refuses B on its next LAN request (403 untrusted) and on relay (the envelope `from` is no longer a member, so it gets 400 `bad-envelope` from the hub).
  - B's engine emits `revoked` exactly once and B has no `mesh/` directory.
  - B makes no reconnect attempts.
  - LAN propagation: with the hub offline, C (on an old list) probes A (on a newer list) and gets the new list.
  - C refuses a list from A that is signed by another root.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit with the message `feat(mesh): revocation and LAN membership propagation`.

### Task 13: Engine and CLI integration, headless unit, docs

**Files:** Modify `src/engine.ts`, `src/cli.ts`, `docs/protocol.md` and `packages/core/package.json` (deps). Create `packaging/systemd/meshdrop.service`. Test: `test/engine-hub.test.ts`.

**Interfaces:**
- `EngineOptions.hub?: { ingressPort?: number /*53319*/; heldQuotaBytes?: number; heldTtlMs?: number }`.
  - A home that has `hub/root-key.pem` runs as the hub: it creates a `HubServer`, attaches it to its mesh server and calls `listenIngress`.
  - Any home with `mesh/membership.json` runs a `HubClient`. A hub device does not run a client for itself.
  - `trust` becomes a `CompositeTrust`.
- Engine methods:
  - `hubInit(urls: string[]): Promise<SignedMembership>` creates the root key and list v1 with this device as `role:'hub'`, and refuses if a root key already exists.
  - `createInvite(): Invite`
  - `join(uri: string, alias?: string): Promise<'member' | 'provisional'>`
  - `members(): Member[]`
  - `revoke(prefix: string)`, hub only
  - `exportRecovery(passphrase)` and `importRecovery(text, passphrase)`. Import on a fresh hub replaces the old hub member with this device, revokes the old hub id, bumps the version and signs.
  - `hubStatus()`
- `send()` path choice per target:
  1. LAN, when the device is in `peers()` or in a directory entry's `lanAddrs`, probed with a 2 s connect timeout.
  2. Otherwise relay, when the hub client is online and the directory says the target is online.
  3. Otherwise held, when the hub client is online.
  4. Otherwise `failed: 'unreachable'`, with the outbox kept.

  If a LAN attempt fails with a transient error, the engine resumes the same session over relay or held once.
- Events: `{source:'mesh', type:'online'|'offline'|'membership'|'directory'|'revoked'|'held-delivered'|'held-failed', …}`.
- CLI commands:
  - `meshdrop hub init [--url wss://…]…`
  - `meshdrop hub status`
  - `meshdrop hub revoke <id-prefix>`
  - `meshdrop hub recovery-export <file>`, which reads the passphrase from the TTY twice (or `--passphrase-file` for tests) and writes the file with mode 0600
  - `meshdrop hub recovery-import <file>`
  - `meshdrop invite`, which prints the URI plus a terminal QR via `qrcode`'s `toString(uri, {type:'terminal', small:true})`
  - `meshdrop join <uri> [--alias]`
  - `meshdrop members`

  `listen` starts the hub or the client automatically. Every network-sourced string still goes through `printable()`.
- `packaging/systemd/meshdrop.service`: a user unit with `ExecStart=%h/.local/bin/meshdrop listen --device-type headless`, `Restart=on-failure` and `RestartSec=5`. Document how to install it in `docs/protocol.md` § "Running the hub".
- `docs/protocol.md` gets new sections:
  - Canonical JSON and signatures
  - Membership list
  - Hub link handshake and close codes (4401/4403/4409)
  - Relay envelopes and frames
  - Held files (synthetic replies, replay order, ciphertext-hash resume)
  - Invites and join
  - Revocation and propagation
  - Recovery file
  - Vector files table

  Update the "M1 pairing" section: manual pairing stays as a developer fallback.
- [ ] **Step 1: Write the failing tests in `engine-hub.test.ts`.** Use three engines with temp homes, `discovery:false` and ephemeral ports: H (hub), A and B.
  - `H.hubInit([])`.
  - A joins via `H.createInvite()` URI over LAN.
  - B joins via an A-created invite while H is online.
  - `A.send([B])` with no LAN route (B's address unknown to A) ends `done` via relay.
  - Stop B, then `A.send([B])`: `held`. Restart B, and B gets `received` while A gets `held-delivered`.
  - `H.revoke(B)`: B emits `revoked`.
  - `exportRecovery`, a fresh home, `importRecovery`: the new hub signs list v(n+1), and A accepts it on reconnect.
  - CLI smoke test: `meshdrop invite --home H` prints a `meshdrop://join?` line.
  - `meshdrop members` lists H, A and B with roles.
- [ ] **Step 2:** Run the tests. Expected: they fail.
- [ ] **Step 3:** Implement, and write the docs.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck`, and the hub, relay and engine test files 3 times each. Expected: all green.
- [ ] **Step 5: Manual check.** Two machines are not needed. Run 3 CLI instances with temp homes on localhost: the hub with `listen`, plus A and B with `--no-discovery`. Join both, then send a 200 MB file A→B through the relay and record the throughput. Stop B, send, restart B, and confirm delivery. Record the outputs in the report.
- [ ] **Step 6:** Commit with the message `feat: hub integration in engine and CLI, systemd unit, protocol docs`.

---

## Milestone roadmap (updated)

| # | Milestone | Status |
|---|---|---|
| M1 | Protocol and Node core | done (`main` 1bff0dd) |
| M2 | Hub | this plan |
| M3 | Desktop app (Ubuntu) | Also includes the deferred M1 items: auto-resume when a peer reappears, announces must not override manual addresses, the ENOTDIR folder collision, and the sender-side path pre-check. |
| M4 | Android app | Needs `docs/protocol.md` plus all of `protocol/vectors/*` from M1 and M2. |
| M5 | Guest tier and internet reach | Tunnels point at the loopback ingress `127.0.0.1:53319` defined here. |
| M6 | LocalSend v2 interop | |
| M7 | Release | |
