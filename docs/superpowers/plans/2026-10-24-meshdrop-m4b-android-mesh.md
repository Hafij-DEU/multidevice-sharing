# MeshDrop M4b: the Mesh on Android — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone becomes a full mesh member. It joins the owner's mesh from a QR invite (any QR scanner or camera opens the `meshdrop://join` link, or the link is pasted), keeps a link to the hub, and sends and receives through the hub when the other device is not on the same Wi-Fi. That includes held files for a device that is offline, and it obeys revocation.

**Architecture:** M2's mesh, ported to the Java engine (`apps/android/engine`), with the Node engine as the reference and the interop partner:
- canonical JSON and domain signatures;
- the signed membership list and its trust;
- invites and joining;
- relay envelopes;
- a WebSocket hub link;
- relay and held transports.

The phone is a **member only**. Being a hub, creating meshes, revoking and recovery stay on the PC. The Android UI shows the Mesh page with join and members only.

**Tech Stack:** as M4a, with no new dependencies. The engine gets its own RFC 6455 WebSocket client, because neither OkHttp nor Java-WebSocket is cached and `java.net.http` is missing on Android.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`:
- §8 "Identity and pairing" (QR pairing, membership authority, revocation);
- §8 "Hub connection while away";
- §8 "Held files";
- §9 "Hub as the backstop".

**Wire spec:** `docs/protocol.md` "M2: the mesh and its hub" (normative) and `protocol/vectors/{canonical,membership,envelope,invite}-v1.json` (byte-exact). The reference is the Node code in `packages/core/src/mesh/*.ts`, `hub/client.ts`, `transfer/transport.ts` and `engine.ts`.

## Global Constraints

All of M4a's constraints apply: offline Gradle, minSdk 29, plain Java, no runtime dependencies in `:engine`, the API-29 rules enforced by `AndroidApiTest` and lint, and the commit identity. Additionally:
- **Branch.** Work on `m4b-android-mesh`, cut from `m4a-android` (M4a is not merged yet).
- **Interop gate.** Every wire task ends with a JUnit test against the Node engine: `node packages/core/src/cli.ts hub init / listen / invite / members / hub revoke`.
- **Limits** come from `docs/protocol.md`:
  - envelope header at most 16384 bytes;
  - a `hello`/auth reply within 10 s;
  - ping every 240 s, and the link counts as dead after 510 s of silence;
  - reconnect backoff 1, 2, 5, 10, 30, 60 s;
  - relay timeout 600 s;
  - at most 256 members;
  - invite proof `HMAC-SHA256(secret, "meshdrop-join-v1\0" + newId + "\0" + inviter)`.
- **CA validation.** `wss://` hub URLs (tunnels) use the platform trust store with hostname verification. The hub's mesh port on the LAN is pinned to `list.hub.deviceId` over mutual TLS.
- **No QR library.** The app handles `meshdrop://join?...` as an intent filter, so the phone's camera or Lens opens the link, and it also accepts pasted links.

## Review Focus

1. **Joining twice, or with a stale or used invite.** Expected: a clear error (`expired`, `used`, `bad-proof`), nothing half-stored. Without the anchor, list and membership, the device stays as before. Test: Task 6.
2. **Hub link flapping.** Wi-Fi toggles, the tunnel drops, the hub restarts. Expected: backoff reconnects, no duplicate sessions, and sends in flight end resumable. Test: Task 5 (the Node hub restarted under a connected Java client).
3. **Forged or replayed relay frames.** A bad signature, a `from` that differs from the link, or the same request id twice. Expected: refused or answered from the replay cache, never run twice. Test: Task 7.
4. **Revocation while offline.** Expected: the revoked phone drops its mesh state only on a verified notice. A bare 4403 just stops the link. Test: Task 8.
5. **A held file delivered later.** The phone is offline while the PC sends. Expected: the hub holds it, and it is delivered when the phone's link comes up, without the sender running. Test: Task 7.

---

### Task 1: Canonical JSON and domain-separated signatures

**Files:** `mesh/Canonical.java`; test `CanonicalTest`.
- **API:**
  - `Canonical.json(Object) → String`: keys sorted by UTF-16 code unit, safe integers only, `-0` → `0`, anything else throws.
  - `sign(domain, byte[] payload, PrivateKey) → base64 DER`.
  - `verify(domain, payload, sigB64, PublicKey) → boolean`, which never throws.
  - `spkiSha256(PublicKey)`.
- **Test:** every `canonical-v1.json` case is byte-exact; the stored signature verifies; a flipped bit, an empty signature, a non-P-256 key and a domain with a NUL all give false.
- **Commit:** `feat(android-engine): canonical JSON and domain signatures (canonical-v1)`.

### Task 2: Membership list and store

**Files:** `mesh/Membership.java`, `mesh/MembershipStore.java`; test `MembershipTest`.
- **API:**
  - `Membership.validate(Object) → List`, which rejects unknown fields, more than one hub, duplicates, a revoked member, and more than 256 members.
  - `verify(Signed, PublicKey anchor)`.
  - `MembershipStore.load(home)`, `init(home, anchorPem, signed)` and `offer(signed) → accepted|stale|fork`.
  - `isTrusted(id)` / `get(id)` for members minus revoked.
  - `TrustStore` + store → `CompositeTrust`; `MeshServer` takes a `TrustSource` interface.
- **Files on disk:** `mesh/anchor.pem` and `mesh/membership.json`, the same as Node's.
- **Test:**
  - `membership-v1.json` verifies;
  - higher, lower, same-version-different and wrong-anchor lists;
  - a revoked id is never trusted, even when also in `trust.json`.
- **Commit:** `feat(android-engine): signed membership list and composite trust`.

### Task 3: Invites and envelopes

**Files:** `mesh/Invite.java`, `mesh/Envelope.java`; tests `InviteTest`, `EnvelopeTest`.
- **API:**
  - `Invite.parse(uri)` with the parameters in the protocol's order;
  - `Invite.proof(secret, newId, inviter)`;
  - `Envelope.seal(header, body, key)`, `open(env, pubOf)`, `encode`/`decode` frame;
  - `ReplayGuard`, an LRU of answered request ids → the cached signed response.
- **Test:**
  - `invite-v1.json` and `envelope-v1.json` are byte-exact, and the stored signatures verify;
  - a header over 16384 bytes, an unknown field and a bad path fail;
  - a replayed id returns the cached answer.
- **Commit:** `feat(android-engine): invites, relay envelopes, replay guard`.

### Task 4: WebSocket client

**Files:** `net/WebSocket.java`; test `WebSocketTest` (against a Node `ws` echo server spawned from the test).
- **API:**
  - `WebSocket.connect(SSLSocket s, String hostHeader, String path, Listener) → WebSocket`.
  - `sendText`, `sendBinary`, `close(code, reason)`, `ping`.
  - `Listener{onText, onBinary, onClose(code, reason), onPong}`.
  - Client frames are masked; it handles fragmentation, 64-bit lengths up to 32 MiB and a close handshake.
- **Test:** echo text and an 8 MiB binary frame; a server close with 4403 reaches `onClose(4403)`; an oversized frame closes with 1009.
- **Commit:** `feat(android-engine): minimal RFC 6455 WebSocket client`.

### Task 5: Hub link

**Files:** `hub/HubClient.java`; test `HubClientTest` (the Node hub = `hub init` + `listen` on a temp home).
- **Behaviour:** ports `hub/client.ts`.
  - Handshake: `hello` → `auth` (signature over hub ‖ 0 ‖ deviceId ‖ 0 ‖ nonce) → `welcome`, verified with the hub's member key.
  - Pushes: `membership`, `directory`, `held-*` and `revoked`.
  - Ping and liveness, and backoff.
  - States: `idle|connecting|online|revoked|refused`.
  - URLs are tried in order: the hub's LAN address (from the directory or `hub-addr.json`, pinned) and then `list.hub.urls`.
- **Test:**
  - the Java member goes `online`;
  - the hub's `directory` lists it as online;
  - after a hub restart it is `online` again within 5 s with backoff `[50, 100]`, and there is exactly one link in the hub's view.
- **Commit:** `feat(android-engine): hub link client`.

### Task 6: Join from an invite

**Files:** `mesh/Join.java`, `MeshServer` routes `GET /mesh/v1/membership` and `info.mv`; test `JoinTest`.
- **Behaviour:**
  - Join over the LAN: `POST join` to the inviter, pinned to `i`.
  - Otherwise join through the hub (`{t:'join',…}` as the first message).
  - A `provisional` result completes later via `GET membership`.
  - Nothing is stored until the anchor hash equals `r` and the list verifies and contains this device.
- **Test:**
  - `node cli.ts invite` → Java join → `member`, and `node cli.ts members` lists the phone;
  - an expired invite (5-minute clock override via an injected clock) → `expired`;
  - the same URI used again → `used`;
  - a wrong secret → `bad-proof`;
  - after each failure, `mesh/` does not exist.
- **Commit:** `feat(android-engine): join a mesh from a QR invite`.

### Task 7: Relay and held transports, and receiving through the hub

**Files:** `send/RelayTransport.java`, the `Sender` transport abstraction (LAN or relay), a `MeshServer.handle(Request)` socket-free entry point, and `Engine` route choice; test `RelayTest`.
- **Behaviour (ported from `engine.ts`):**
  - Route: LAN when the device is known on the LAN; else relay when the link is up and the target is online; else held with `holdBytes`; else `offline`.
  - A LAN failure that is transient retries once over the hub.
  - Incoming relayed requests run through the same handler as LAN requests.
  - Answers are signed, and replays are answered from the cache.
  - `held-delivered` and `held-failed` become events.
- **Test, with Node member B on its own home and the Node hub H:**
  - Java → B by relay (B not on the LAN);
  - B → Java by relay;
  - Java → B while B is stopped ends `held`, and B started later receives it;
  - a relayed request with a bad signature gets `400 bad-envelope` or is dropped;
  - a replayed id is not run twice (B's inbox has one copy).
- **Commit:** `feat(android-engine): relay and held sends through the hub`.

### Task 8: Revocation and membership propagation

**Files:** `HubClient`, `Engine`; test `RevokeTest`.
- **Behaviour:**
  - On a verified `{t:'revoked', s}`, delete `mesh/`, stop the link for good, keep the identity, and emit `revoked`.
  - A bare 4403 sets the state to `refused`.
  - A LAN peer with a newer `mv` → `GET membership` → `offer`.
- **Test:**
  - `node cli.ts hub revoke <javaId>` → Java `revoked` and `mesh/` gone;
  - a 4403 without a notice → `refused`, `mesh/` kept;
  - a newer list pulled from a Node member on the LAN while the hub is down.
- **Commit:** `feat(android-engine): revocation and membership pull`.

### Task 9: The app: Mesh page on Android, join link handling

**Files:**
- `AppController` (hub state, members, `join`);
- `MainActivity` (intent filter `meshdrop://join`);
- renderer `Mesh.tsx` on Android: join box and members; no create, revoke, hub URLs or recovery;
- `emulator-e2e.sh`: join the Node hub from an invite (`am start -d '<uri>'`), then `node cli.ts members` lists the phone and the phone's state shows `member`.

Tests: `AppControllerTest` gains a join case and `mesh state`; the e2e stays green.
- **Commit:** `feat(android): join a mesh from a meshdrop:// link; Mesh page on Android`.

### Task 10: Docs

Update `README.md` (Android: join by QR) and `docs/protocol.md` notes (what the Java engine implements of M2).

Commit: `docs: M4b`.

## Rulings made while planning

- **Phone is member-only.** No hub role, mesh creation, revocation or recovery on Android: the spec makes the PC the hub, and those actions stay there. Cost if wrong: one more port later.
- **No in-app QR scanner.** No QR library is cached; the system camera/Lens opens `meshdrop://join` links, and the link can be pasted. Cost if wrong: one extra step on phones whose camera does not decode QR.
- **Own WebSocket client.** OkHttp and Java-WebSocket are not cached, and `java.net.http` is absent on Android. Cost if wrong: more code to review.
