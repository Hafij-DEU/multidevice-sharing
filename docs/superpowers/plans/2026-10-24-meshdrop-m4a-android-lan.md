# MeshDrop M4a: Android App on the LAN — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship MeshDrop on the owner's Android phones as a signed APK that sends and receives files, folders, text and clipboard with the Ubuntu app over Wi-Fi. It discovers devices on the LAN or pairs by address, stays reachable in the background on stock Android, HiOS and HyperOS, and saves received files to `Download/MeshDrop`.

**Architecture:**
- **`apps/android`** is a Gradle project with two modules.
  - **`:engine`** is a plain-Java library with no Android imports. It holds:
    - the Java engine implementing `docs/protocol.md` (identity, HPKE, chunks, receiver, sender, outbox, discovery);
    - a Java `AppController`.
  - **`:app`** is the Android shell:
    - a foreground service that runs the engine;
    - a WebView that shows the **same React renderer** as the desktop (`apps/desktop/src/renderer`), talking to Java through a JS bridge that implements `DesktopApi`;
    - MediaStore, SAF, clipboard, notifications and keep-alive integration.
- **Interop is proven on the JVM.** `:engine` tests run on JDK 17 against the protocol vectors. They also run against the real Node engine (`node packages/core/src/cli.ts`) in both directions, so the phone build reuses code that has already talked to the PC.
- **M4b** (next plan) adds the mesh on Android: QR join, membership, the hub link, relay, held files and revocation. M4a devices pair by address or discovery, like the desktop's "Add by address".

**Tech Stack:**
- Java 17 language level (desugared by AGP), AGP `8.7.3`, Gradle `8.11.1` (`~/.local/opt/gradle-8.11.1/bin/gradle --offline`);
- compileSdk/targetSdk 35, build-tools 35.0.0;
- `androidx.webkit:webkit:1.12.1` (cached);
- JUnit `4.13.2` + hamcrest-core `1.3` for `:engine` tests (fetched online once, see Global Constraints);
- the existing Vite renderer build;
- Node 24 for the interop tests.

**Spec:** `docs/superpowers/specs/2026-10-23-meshdrop-design.md`. This plan builds:
- §2 owner tier on Android;
- §3 goals 1, 3 (auto-accept from trusted), 6, 7, 9 and 14 on Android;
- §6 Android row;
- §7 "Android engine in plain Java … in a foreground service" and "one UI codebase";
- §8 "LAN discovery" (multicast plus manual IP and subnet scan; mDNS is deferred, see Rulings), "Transport", "Clipboard" (Android rules), "Multi-send", "Received files";
- §9 entirely;
- §10 Android testing.

**Wire spec:** `docs/protocol.md` (normative) and `protocol/vectors/*.json` (byte-exact). The Node engine in `packages/core/src` is the reference implementation: when this plan says "port X", read `X.ts` and its test file, and keep the behaviour and the limits.

**Owner decisions (2026-10-24):**
- **minSdk 29.** All three phones run Android 10 or newer. This gives platform TLS 1.3 and MediaStore Downloads without Conscrypt.
- **The Android work is split.** M4a (this plan, LAN) comes first, then M4b (mesh and hub).

This changes spec §6 "minSdk 26" for MeshDrop only.

## Global Constraints

- **Toolchain.** Build offline: `~/.local/opt/gradle-8.11.1/bin/gradle --offline` from `apps/android`. No Gradle wrapper jar is committed.
  - AGP 8.7.3, `compileSdk 35`, `targetSdk 35`, `minSdk 29`, `buildToolsVersion "35.0.0"`.
  - JDK 17 (`java -version` → 17); `sourceCompatibility`/`targetCompatibility` 17.
- **Language.** Plain Java: no Kotlin, no NDK, no records or sealed types (D8 desugaring varies).
  - Only APIs available on Android 29: no `java.util.HexFormat`, no `java.net.http`. Java 11 APIs that AGP desugars (`String.repeat`, `List.of`) are fine.
  - `:engine` uses only `java.*`/`javax.*` APIs that exist on Android 29. Use the `javax.net.ssl`, `java.security` and `javax.crypto` JCA providers; no BouncyCastle.
- **Dependencies.**
  - `:engine` has **no runtime dependencies**. JSON is the engine's own `Json` class.
  - Its tests use JUnit 4.13.2 and hamcrest-core 1.3. These are not in the offline cache, so one online resolution (`gradle --refresh-dependencies` without `--offline`, once) is allowed and recorded.
  - `:app` adds only `androidx.webkit:webkit:1.12.1` (cached) and what it pulls in.
  - Anything else needs a written justification in the ledger.
- **Identity.**
  - Package and applicationId `io.github.hafijbge.meshdrop`, app name `MeshDrop`, versionName `0.1.0`, versionCode `1`.
  - Announce `deviceType` is `mobile`; alias defaults to `Build.MODEL` (at most 64 characters).
  - Licence GPL-3.0; credit Md Hafijur Rahman.
- **Storage.**
  - Engine home is `context.getFilesDir()/meshdrop`. It holds `identity/`, `trust.json`, `manual-peers.json`, `outbox/`, `inbox-state/` and partial data.
  - Received files go to MediaStore `Download/MeshDrop/<relative path>`.
  - Android settings and history are JSON files in the home: `android-settings.json` and `desktop-history.json`, the latter using the same format as the desktop `HistoryStore`.
  - `android:allowBackup="false"`.
- **Protocol.**
  - Ports: TCP 53318 for HTTPS and UDP multicast `224.0.0.168:53318`.
  - TLS 1.3 only; `CHUNK_SIZE` 4 194 304.
  - Limits as in `docs/protocol.md`: offer at most 64 MiB, chunk at most `CHUNK_SIZE + 16`, 100 000 files, text at most 1 MiB, path rules from `sanitize.ts`.
  - Sender retries 0.5, 1 and 2 s.
  - Every number in the protocol is the Node engine's number.
- **Interop is a gate.** Every `:engine` task whose code is on the wire ends with a JUnit test that drives the Node engine via `node ../../packages/core/src/cli.ts` (path from `apps/android/engine`).
- **WebView security.**
  - The WebView loads only `https://appassets.androidplatform.net/` through `WebViewAssetLoader`, and the bridge shim is injected only for that origin (`WebViewCompat.addDocumentStartJavaScript`).
  - Every other navigation is blocked: `setAllowFileAccess(false)`, no `setAllowUniversalAccessFromFileURLs`, `usesCleartextTraffic="false"`.
  - The renderer's existing CSP and "peer strings are text only" rules stay.
- **Bridge contract.** The renderer still talks only to `window.meshdrop: DesktopApi`.
  - Additions to `apps/desktop/src/shared/api.ts` are optional members, so the desktop keeps compiling and its tests stay green.
- **Commits.** Work on branch `m4a-android` and commit with `git -c user.name=Hafij-BGE -c user.email=mdhafijur.rahman@ogr.deu.edu.tr commit`.
  - Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never `adb install` to a physical phone without asking the owner (spec §10). The emulator `markd35` (API 35) is fine.

## Review Focus

1. **Wi-Fi drops, a network change or the screen turning off mid-transfer, in either direction.** Expected: an outgoing send is `cancelled`/`failed`, stays in the outbox and resumes by itself when the peer is seen again. An incoming session resumes from its have map. Tests: Task 7 (Node receiver killed mid-send, restarted, resumed), Task 8 (auto-resume on re-sighting) and Task 10 (network callback re-announces and re-probes).
2. **A several-GB video picked through SAF.** Expected: constant memory. The file is hashed and read by position through a `FileChannel` and never loaded whole. Test: Task 7 sends a 1 GiB sparse file in a test JVM capped at `-Xmx96m`.
3. **Names that do not fit.** Covers emoji, RTL and combining characters, Windows-reserved stems, 300-byte names, and two files landing on the same `Download/MeshDrop` name. Expected: sanitized like the Node engine, never overwritten, and the landed name (`a (1).txt`) is reported back to the sender and shown in the Inbox. Tests: Task 5 (sink collisions) and Task 6 (Node sends `ü 😀.txt` twice).
4. **The OEM kills the app mid-receive.** Expected: partial chunks and the progress log survive, and the next start (or the sender's retry) resumes without re-sending held chunks. Test: Task 5 reloads `Inbox` from the same directory between chunks, including a torn last progress line.
5. **Hostile LAN input.** Covers an untrusted device's offer, an oversized `Content-Length`, a slowloris client, garbage announces and header floods. Expected: the right 4xx or a closed connection, nothing written, and the server keeps serving others. Tests: Task 6 (HTTP limits and the 30 s idle timeout, shortened by a constructor parameter in tests) and Task 8 (announce validation).

---

## File Structure

```
apps/android/
  settings.gradle, build.gradle, gradle.properties, .gitignore (build/, local.properties, dist-apk/)
  engine/build.gradle                       java-library, JUnit 4
  engine/src/main/java/io/github/hafijbge/meshdrop/engine/
    util/Json.java  util/B64.java  util/Hex.java  util/Atomic.java (atomic file writes, 0600)
    crypto/P256.java  crypto/Hpke.java
    proto/Manifest.java  proto/Chunks.java  proto/Offer.java  proto/Sanitize.java
    identity/X509.java  identity/Identity.java  identity/KeyVault.java  identity/PlainKeyVault.java
    recv/Inbox.java  recv/InboxSink.java  recv/DirectorySink.java  recv/MeshServer.java
    net/Http.java  net/Tls.java  net/TrustStore.java
    send/Source.java  send/PathSource.java  send/Prepared.java  send/Sender.java  send/Outbox.java  send/MultiSend.java
    disc/Announce.java  disc/Discovery.java
    Engine.java  EngineConfig.java  EngineEvent.java  EngineDevice.java  SendItem.java  SendResult.java
    app/AppController.java  app/Platform.java  app/SettingsStore.java  app/HistoryStore.java  app/StateJson.java
  engine/src/test/java/...                  one test class per main class, plus interop/NodeInteropTest.java
  app/build.gradle
  app/src/main/AndroidManifest.xml
  app/src/main/java/io/github/hafijbge/meshdrop/
    MainActivity.java  WebUi.java  Bridge.java  MeshService.java  AndroidPlatform.java
    MediaStoreSink.java  UriSource.java  ClipboardSendActivity.java  ClipboardTile.java
    BootReceiver.java  KeepAlive.java  KeystoreVault.java
  app/src/main/assets/bridge/shim.js        DesktopApi over the JS bridge
  app/src/debug/java/.../DebugCommands.java + debug AndroidManifest.xml (adb-driven e2e only)
  scripts/build-renderer.sh  scripts/emulator-e2e.sh  scripts/release.sh
apps/desktop/src/shared/api.ts              + optional platform members
apps/desktop/src/renderer/…                 hide desktop-only UI when state.platform === 'android'
```

---

### Task 1: Gradle project, JSON and encoding utilities

**Files:**
- Create: `apps/android/{settings.gradle,build.gradle,gradle.properties,.gitignore}`, `engine/build.gradle`, and `util/{Json,B64,Hex,Atomic}.java`.
- Test: `engine/src/test/.../util/JsonTest.java` and `AtomicTest.java`.

**Interfaces (produces):**
- `Json.parse(String s) → Object`. Results map to `LinkedHashMap<String,Object>`, `ArrayList<Object>`, `String`, `Long` (integers within ±2^53−1), `Double`, `Boolean` or `null`. Depth is limited to 64 and input to 64 MiB; it throws `Json.JsonException`.
- `Json.stringify(Object v) → String` keeps insertion order and escapes exactly as ECMAScript `JSON.stringify`:
  - only `"`, `\` and controls below U+0020 are escaped (`\b \f \n \r \t`, else `\u00XX` lower-case);
  - lone surrogates are written as `\udXXX`;
  - integers have no `.0`.
- `B64.std(byte[])`, `B64.stdDecode(String)` (padded, strict), `B64.url(byte[])` (unpadded) and `B64.urlDecode(String)`.
- `Hex.of(byte[])` (lower case) and `Hex.parse(String)`.
- `Atomic.write(File f, byte[] data)` writes a temp file in the same directory, owner-only (`setReadable(false,false)` then `setReadable(true,true)`, and the same for writable), fsyncs and renames.

- [ ] **Step 1:** Write the tests.
  - Parity cases copied from `protocol/vectors/canonical-v1.json` "strings". Use the expected output only for the escaping part; canonical key sorting is M4b.
  - `{"a":1,"b":[true,null,"x"]}` round-trips byte-exact.
  - `"\ud800"` stringifies to `"\"\\ud800\""`.
  - `1e400` and depth 65 throw.
  - `9007199254740993` parses as `Double`, never a wrapped `Long`.
  - An `Atomic.write` file is mode 0600, checked with `Files.getPosixFilePermissions` on JDK.
- [ ] **Step 2:** Run `gradle --offline :engine:test` (the first run, without `--offline`, fetches JUnit). Expected: compile failure.
- [ ] **Step 3:** Implement. `settings.gradle` includes `:engine` only; `:app` arrives in Task 9.
  - `pluginManagement`/`dependencyResolutionManagement` repos: `google()` and `mavenCentral()`.
  - `engine/build.gradle` sets `test { maxHeapSize = "512m"; systemProperty "meshdrop.repo", rootDir.parentFile.parentFile.path }`.
- [ ] **Step 4:** Rerun. Expected: green.
- [ ] **Step 5:** Commit: `feat(android): gradle project and JSON/encoding utilities for the Java engine`.

### Task 2: P-256 and HPKE (RFC 9180 mode_auth)

**Files:**
- Create: `crypto/P256.java` and `crypto/Hpke.java`.
- Test: `HpkeTest.java`, which reads `${meshdrop.repo}/protocol/vectors/hpke-auth-p256.json`.

**Interfaces:**
- `P256`:
  - `generate() → KeyPair`;
  - `publicFromSec1(byte[] 65)` and `sec1(ECPublicKey) → byte[65]`;
  - `privateFromScalar(byte[] 32)`;
  - `publicFromSpki(byte[])`, `spki(PublicKey)`, `pkcs8(PrivateKey)`, `privateFromPkcs8(byte[])`;
  - `ecdh(PrivateKey, PublicKey) → byte[32]`.
  - It rejects non-P-256 keys and points not on the curve.
- `Hpke.Context`:
  - `seal(long seq, byte[] aad, byte[] pt)` and `open(long seq, byte[] aad, byte[] ct)`, where nonce = `baseNonce XOR I2OSP(seq,12)`;
  - `export(byte[] ctx, int len)`;
  - `key()`, `baseNonce()` and `exporterSecret()` for the vectors.
- `Hpke.setupAuthS(PublicKey pkR, byte[] info, KeyPair skS, KeyPair ephemeral /* null = fresh */) → {byte[] enc, Context ctx}`.
- `Hpke.setupAuthR(byte[] enc, KeyPair skR, byte[] info, PublicKey pkS) → Context`.
- Suite: KEM 0x0010, KDF 0x0001, AEAD 0x0002 (AES-256-GCM) or 0x0001 (AES-128-GCM, for the vector only).
- HKDF is built on `Mac("HmacSHA256")` with labeled extract/expand per RFC 9180 §4.

- [ ] **Step 1:** Write `HpkeTest`.
  - For both vector entries (aead 1 and 2): `enc`, `shared_secret`, `key`, `base_nonce` and `exporter_secret` must equal the vector.
  - Every `encryptions[i]` must seal to `ct` at seq `i` and open back.
  - `open` with a flipped tag byte throws `AEADBadTagException`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement by porting `packages/core/src/crypto/hpke.ts`.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): P-256 and HPKE mode_auth, RFC 9180 vectors`.

### Task 3: Manifest, offer and chunk sealing

**Files:**
- Create: `proto/{Manifest,Chunks,Offer}.java`.
- Test: `ChunksTest.java` (the `chunk-v1.json` vector) and `ManifestTest.java`.

**Interfaces:**
- `Manifest`: fields `v, sessionId, from, to, createdAt, List<FileEntry{fileId,path,size,mime,sha256}> files, List<String> dirs, String text /*nullable*/, boolean clipboard`.
  - `toJson()` writes the fixed key order of `docs/protocol.md` (`clipboard:true` only when set).
  - `Manifest.parse(byte[])` validates per protocol, throwing `Offer.BadOffer`.
- `Chunks`:
  - `CHUNK_SIZE`;
  - `count(long size)`;
  - `seq(int fileId, int index)` = `((fileId+1L)<<32)|index`;
  - `aad(String sessionId, int fileId, int index)`;
  - `sealChunk(Context, …)` and `openChunk(Context, …)`.
- `Offer.create(Identity sender, PublicKey receiverPub, String receiverId, Manifest m, KeyPair eph /*null*/) → {Offer offer, Hpke.Context ctx}`.
- `Offer.toJson()` gives `{v,sessionId,from,to,enc,sealedManifest}` with standard base64.
- `Offer.open(byte[] json, KeyPair receiver, String receiverId, String peerId, PublicKey trustedSenderKey) → {Manifest, Context}`. It applies every receiver check in `docs/protocol.md` "Offer", raising `Offer.BadOffer(status, code)` with the 403/422 split documented there.
- `Session ids`: `Offer.newSessionId()` gives 16 random bytes as base64url; `Offer.SESSION_ID` is `^[A-Za-z0-9_-]{22}$`.

- [ ] **Step 1:** Write the tests.
  - From `chunk-v1.json` with its fixed scalars: the manifest JSON bytes, `enc`, the sealed manifest and the sealed chunk must be byte-exact.
  - A manifest with `clipboard` and text round-trips.
  - `clipboard` together with files is `BadOffer 422`.
  - An offer whose `from` is not the TLS peer is `403 forbidden`.
  - An offer addressed to another `to` is `422`.
  - 100 001 files is `422`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement by porting `chunk.ts`.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): manifest, offer and chunk sealing (chunk-v1 vector)`.

### Task 4: Identity and the self-signed certificate

**Files:**
- Create: `identity/{X509,Identity,KeyVault,PlainKeyVault}.java`.
- Test: `X509Test.java` (`x509-v1.json`) and `IdentityTest.java`.

**Interfaces:**
- `X509.selfSigned(KeyPair kp, byte[] serial16, String cn) → byte[] der` follows the Node profile in `docs/protocol.md` "Identity", ported from `x509.ts`. `X509.tbs(...)` is exposed for the vector.
- `X509.publicKey(byte[] der) → ECPublicKey` parses via `CertificateFactory`. It accepts any well-formed self-signed P-256 certificate, ignoring validity, subject and extensions.
- `Identity`: `deviceId()` (hex SHA-256 of the DER), `shortId()`, `certDer()`, `keyPair()`.
- `Identity.loadOrCreate(File home, KeyVault vault)`:
  - storage: `identity/cert.der` plus `identity/key.bin` (PKCS#8 sealed by the vault);
  - a fresh identity is written to a temp dir and then renamed;
  - when only one file exists, it throws `IOException("missing identity/key.bin")` (or `cert.der`);
  - it checks that the cert verifies under the key.
- `KeyVault`: `byte[] seal(byte[])` and `byte[] open(byte[])`. `PlainKeyVault` is the identity function, for JVM tests and interop. Android's `KeystoreVault` arrives in Task 10.

- [ ] **Step 1:** Write the tests.
  - The `x509-v1.json` TBS is byte-exact for its fixed key, serial and CN.
  - `selfSigned` verifies with `SHA256withECDSA`.
  - `loadOrCreate` twice gives the same `deviceId`.
  - Deleting `key.bin` makes the load throw with that name.
  - **Node accepts our certificate:** write `identity/cert.der` plus `identity/key.pem`, exported as PKCS#8 PEM, into a temp home. Then `node cli.ts id --home <tmp>` must print `device id: <our id>`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): identity and self-signed P-256 certificate (Node-compatible)`.

### Task 5: Path sanitizing and the receiver inbox

**Files:**
- Create: `proto/Sanitize.java`, `recv/{Inbox,InboxSink,DirectorySink}.java`.
- Test: `SanitizeTest.java` and `InboxTest.java`.

**Interfaces:**
- `Sanitize.safeRelPath(String) → String` (throws `Sanitize.UnsafePath`) and `Sanitize.uniqueName(String stem, String ext, int n)`. These port `sanitize.ts` exactly.
- `InboxSink` (where finished files land):
  - `boolean exists(String relPath)`;
  - `String publish(String relPath, File data, String mime) → landedRelPath`, which moves or copies and picks `stem (n).ext` on collision;
  - `void mkdirs(String relPath)`.
  - `DirectorySink(File root)` implements it on a plain directory. MediaStore implements it in Task 10.
- `Inbox(File stateDir, InboxSink sink, long partialMaxAgeMs)`:
  - `begin(Manifest, String ctxSecretsB64) → have map`;
  - `have(sid)`;
  - `writeChunk(sid, fileId, index, byte[] plain)`;
  - `complete(sid, fileId) → landedRelPath`, which throws `IntegrityError`/`Incomplete`;
  - `finish(sid) → List<String>`;
  - `cancel(sid)`;
  - `tombstone(sid)`;
  - `prune()`.
- Ported from `inbox.ts`:
  - per-session `state.json`;
  - an append-only progress log, compacted, with a torn last line ignored;
  - chunk data written by position into `part-<fileId>`;
  - top-level folder mapping ("tops") persisted in state;
  - tombstones for 7 days;
  - partial sessions pruned after 30 days.

- [ ] **Step 1:** Write the tests.
  - `SanitizeTest` copies every case of `packages/core/test/sanitize.test.ts` with the same expected strings.
  - `InboxTest` ports these Node `inbox.test.ts` cases by name:
    - "stores a small file, finalizes with verified hash";
    - "collision: existing file untouched, two finalizes get (1) and (2)";
    - "two files with the same path in one manifest both land";
    - "resume state survives restart (chunks 0 and 2 of 3)";
    - "begin with the same manifest keeps progress; a different manifest resets it";
    - "hash mismatch: IntegrityError … partial discarded";
    - "0-byte file";
    - "empty dir";
    - "begin rejects the whole manifest on any unsafe path";
    - "writeChunk rejects unknown session, unknown fileId, bad index, wrong length";
    - "a torn last progress line is ignored on load";
    - "prune() removes partial sessions untouched for 30 days";
    - "completed()/tombstone persists and prunes after 7 days";
    - "lands the folder under a unique name and leaves the file alone";
    - "keeps the same folder after a restart".
  - **Review Focus #4:** create `Inbox`, write chunk 0 of 3, drop the object, append a torn line to the log, construct a new `Inbox` on the same dir, and get have `{0:[0]}`.
  - **Review Focus #3:** `DirectorySink` with existing `ü 😀.txt` lands `ü 😀 (1).txt` and returns that path.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): path sanitizing and resumable inbox`.

### Task 6: TLS, HTTP/1.1 and the receiver server, with Node → Java interop

**Files:**
- Create: `net/{Tls,Http,TrustStore}.java` and `recv/MeshServer.java`.
- Test: `HttpTest.java`, `MeshServerTest.java`, and `interop/NodeInteropTest.java` (receive direction).

**Interfaces:**
- `Tls`:
  - `serverContext(Identity)`: TLS 1.3 only, `setWantClientAuth(true)`, accepts any client certificate;
  - `pinnedClient(Identity me, String expectedId) → SSLSocketFactory`. The pin is checked inside `X509TrustManager.checkServerTrusted`, so it fails before our certificate is sent (protocol "TLS rules" note).
  - `probeClient()`: no client certificate, no pin;
  - `peerId(SSLSession) → String|null`.
- `Http`: a minimal HTTP/1.1 request and response codec over a socket.
  - Content-Length and chunked bodies; `Connection: close` on every response.
  - Limits: request line plus headers at most 16 KiB and at most 100 headers; a per-read idle timeout (constructor parameter, default 30 s).
  - `Http.Request{method, path, headers, InputStream body}`.
  - `Http.send(SSLSocket, method, path, headers, byte[] body) → Http.Response{status, headers, byte[] body (capped)}`.
- `TrustStore(File trustJson)`:
  - `add(deviceId, alias, spkiPem)`, `get(id)`, `isTrusted(id)`, `list()`, `remove(id)`;
  - it reloads when the file changes;
  - it refuses non-P-256 keys.
  - Its format equals the Node `trust.json`.
- `MeshServer(Identity, TrustStore, Inbox, EventSink, ServerOptions{port, idleTimeoutMs, maxConnections=64, accepting: BooleanSupplier})`:
  - `start() → boundPort`, `stop()`;
  - one thread per connection from a bounded pool;
  - routes and the error table are exactly `docs/protocol.md` "Endpoints (v1)"; `accepting=false` gives offers `503 paused`.
  - Receiver events: `offer`, `progress`, `file`, `received{files(absolute or content URI string), text, clipboard}`, `error` and `cancelled`.

- [ ] **Step 1:** Write the tests.
  - `HttpTest`:
    - a 17 KiB header block → 431 and the connection is closed;
    - `Content-Length: 99999999999` on a chunk PUT → 413 before reading the body;
    - a client that sends nothing is closed after the idle timeout (200 ms in the test) while a second client is still served (**Review Focus #5**);
    - a chunked body decodes.
  - `MeshServerTest`:
    - untrusted peer offer → `403 {"error":"untrusted"}`;
    - `GET info` gives `{v:1, deviceId, alias, deviceType:"mobile"}`;
    - paused → 503.
  - `NodeInteropTest.receivesFromNode`:
    - start a Java `MeshServer` on port 0 with a `DirectorySink`, and a Node home;
    - `node cli.ts pair 127.0.0.1:<javaPort> phone --home N`;
    - trust Node's id in Java (read `N/identity/cert.der`);
    - `node cli.ts send <javaId8> <folder with ü 😀.txt, a 9 MiB file, an empty dir> --text hi --home N` exits 0;
    - files are byte-equal and the empty dir exists;
    - a `received` event carries text `hi`;
    - sending `ü 😀.txt` again lands `ü 😀 (1).txt`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement by porting `api/handler.ts`, `api/server.ts` and `tls.ts`. Use a cached thread pool capped by a `Semaphore(maxConnections)`; the 65th connection is closed at once.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): TLS 1.3 receiver server; Node sends to Java`.

### Task 7: Sender, outbox and multi-send, with Java → Node interop

**Files:**
- Create: `send/{Source,PathSource,Prepared,Sender,Outbox,MultiSend}.java` and `SendItem.java`, `SendResult.java`.
- Test: `SenderTest.java` and `NodeInteropTest.sendsToNode`, `.resumesAfterReceiverRestart`, `.bigFileLowMemory`.

**Interfaces:**
- `Source` is an abstraction over a file the user picked:
  - `String name()`, `long size()`, `long lastModified()`;
  - `SeekableByteChannel open()`;
  - `String mime()`.
  - `SourceTree`: `List<Entry{String relPath, Source src}> files()` and `List<String> emptyDirs()`.
  - JVM implementation: `PathSource.file(Path)` and `PathSource.tree(Path)`, which skip symlinks and special files inside walks, as `send.ts` step 1 does.
- `SendItem.file(Source)`, `SendItem.dir(SourceTree)`, `SendItem.text(String)` and `SendItem.clipboard(String)`.
- `SendResult{deviceId, status: done|failed|cancelled, sessionId, error}`.
- `Sender.sendTo(Identity, Target{deviceId, host, port, PublicKey}, Prepared, SendOptions{Outbox, AtomicBoolean pause, ProgressListener, int concurrency=3}) → SendResult`. This is the algorithm of `docs/protocol.md` "Sender algorithm" steps 1–7, including:
  - source-change checks with per-chunk SHA-256;
  - retries 0.5/1/2 s;
  - best-effort `cancel`;
  - `done:true` tombstone handling.
- `Outbox(File dir)`:
  - `put/list/remove/load`;
  - `resumeEntry(...)` and `resumeAll(...)`;
  - entries record `lastError`.
  - The file format is the engine's own (local only) but holds the same fields: offer bytes, manifest, sources (URI or path, size, mtime, chunk hashes), plus `key` and `baseNonce` for the context. Mode 0600.
- `MultiSend.send(Identity, List<Target>, Prepared, …) → List<SendResult>`: concurrent, in target order.
- `ProgressListener.onProgress(String deviceId, String sessionId, int fileId, long sent, long total)`.

- [ ] **Step 1:** Write the tests, against a Node `listen --home N --port 0 --no-discovery` child with both sides paired.
  - `sendsToNode`: a folder, a 0-byte file, a file of exactly 2 × 4 MiB and text are byte-equal in `N/inbox`.
  - `resumesAfterReceiverRestart`:
    - kill Node after the first progress of a 64 MiB file; the result is `failed`, the outbox keeps the entry and `lastError` is transient;
    - restart Node on the same port; `Outbox.resumeAll` → `done`, and the bytes are equal.
  - `sourceChanged`: rewrite the source in place with the same size and mtime after the first chunk; the result is `failed / source-changed` and Node received `cancel` (its inbox has no partial session after `prune`).
  - `bigFileLowMemory` (**Review Focus #2**): a 1 GiB sparse file sent from a forked test JVM with `-Xmx96m` completes, and the Node side's SHA-256 matches.
  - `multiSendOneFails`: two Node receivers, one killed first; one `done`, one `failed`, in target order.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement by porting `transfer/send.ts`, `transport.ts` (direct LAN transport only) and `multisend.ts`. Hashing and reads go through `SeekableByteChannel.position()`, never whole files.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): resumable sender, outbox and multi-send; Java sends to Node`.

### Task 8: Discovery and the Engine facade

**Files:**
- Create: `disc/{Announce,Discovery}.java` and `{Engine,EngineConfig,EngineEvent,EngineDevice}.java`.
- Test: `AnnounceTest.java`, `DiscoveryTest.java` (multicast tests are skipped when a loopback multicast probe fails, as in `test/multicast.ts`), and `EngineTest.java`.

**Interfaces:**
- `Announce.parse(byte[], String srcHost) → PeerInfo|null` applies the strict validation of the protocol's "Announce packet"; `Announce.encode(...)`.
- `Discovery(DiscoveryOptions{self, group, port, intervalMs=5000, ttlMs=15000, announce, isTrusted})`:
  - `start()`, `stop()`, `peers()`;
  - `probe(host, port, timeoutMs) → PeerInfo` (probe TLS, `GET info`, id from the certificate);
  - `forget(id)`;
  - listener callbacks `peer` and `lost`.
  - It ports `discovery.ts`, including the M3 rules: trusted newcomers evict untrusted entries when full, manual peers keep their address, and `peer` is re-emitted after silence longer than the TTL.
  - The multicast socket is a `MulticastSocket` joined on every non-loopback IPv4 `NetworkInterface`.
  - Android wraps this with a `WifiManager.MulticastLock` (Task 10) through `EngineConfig.multicastHooks{acquire(), release()}`.
- `Engine.create(EngineConfig{home, KeyVault, InboxSink, port=53318, alias, deviceType="mobile", discovery=true, autoResume=true, multicastHooks})`. Methods:
  - `start()`, `stop()`, `port()`, `identity()`;
  - `devices() → List<EngineDevice{deviceId, alias, role: paired|nearby, trusted, reach: lan|offline, deviceType, lastSeen}>`;
  - `pairManual(host, port, alias)`, `addNearby(host, port)`, `forgetPeer(id)`;
  - `scanSubnet(List<String> cidrs /*null=own /24s*/, List<Integer> ports, timeoutMs, concurrency) → int`;
  - `send(List<String> idsOrPrefixes | ALL, List<SendItem>, String tag) → CompletableFuture<List<SendResult>>` and `sendClipboard(…)`;
  - `resumePending()`, `listOutbox()`, `removeOutbox(prefix)`;
  - `setReceiving(boolean)`, `receiving()`;
  - `restartNetworking()`, which re-announces, re-probes manual peers and re-runs auto-resume checks after a network change;
  - `addListener(EngineListener)`.
- `EngineEvent{source, type, Map<String,Object> data}` mirrors the Node event shapes, including `tag` and `sessionId` on sender `progress`/`result`.
- Auto-resume follows the M3 fixed rules: run at most once per burst (an in-flight flag plus a re-check), stamp the 30 s gate only after a reachable route, and never resume `source-changed` or 4xx.

- [ ] **Step 1:** Write the tests.
  - `AnnounceTest`: every rejection case in `discovery.test.ts` "validates announces" (bad version, id, alias, type, port, oversized, non-object) returns null, and a valid packet parses with the host taken from the source address.
  - `DiscoveryTest`:
    - the Java announcer is seen by a Node `listen` on the same multicast port: `node cli.ts listen --home N` prints `peer … [untrusted]` naming our alias;
    - a Node announcer is seen by Java.
  - `EngineTest`:
    - `pairManual` with Node → `devices()` shows `paired/lan`;
    - send to a prefix;
    - a burst of three `addNearby` after a Node restart auto-resumes once (one `result` event);
    - `setReceiving(false)` → Node's `send` to us fails with `http-503`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement by porting `discovery.ts` and `engine.ts`'s LAN parts. No mesh: `role` is only `paired`/`nearby`.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat(android-engine): discovery and Engine facade with auto-resume`.

### Task 9: AppController in Java and the Android app shell with the shared renderer

**Files:**
- Create in `:engine`: `app/{AppController,Platform,SettingsStore,HistoryStore,StateJson}.java`.
- Create in `:app`: `app/build.gradle`, `AndroidManifest.xml`, `MainActivity.java`, `WebUi.java`, `Bridge.java`, `assets/bridge/shim.js` and `scripts/build-renderer.sh`.
- Modify: `apps/desktop/src/shared/api.ts`, `App.tsx`, `pages/{Devices,Settings}.tsx` and `settings.gradle` (add `:app`).
- Test: `AppControllerTest.java` and `StateJsonTest.java`; the desktop `pnpm test` and `pnpm desktop:e2e` stay green.

**Interfaces:**
- **`api.ts` additions**, all optional so the desktop compiles unchanged:
  - `AppState.platform?: 'desktop' | 'android'` (desktop sets `'desktop'`);
  - `AppState.keepAlive?: {batteryUnrestricted: boolean; rom: 'miui' | 'hios' | 'stock'; steps: {id: string; label: string; done?: boolean}[]}`;
  - `AppState.sharedPending?: number`;
  - `DesktopApi.takeSharedItems?(): Promise<SendItemInput[]>` and `DesktopApi.keepAliveAction?(id: string): Promise<void>`.
  - `SendItemInput.path` may be a `content://` URI on Android.
- **Renderer, when `platform === 'android'`:**
  - hide the Mesh page (M4b) and the desktop-only settings: autostart, start hidden, close to tray, keyboard shortcut, open config folder, and the inbox field (fixed to `Download/MeshDrop` in M4a);
  - hide the DropZone;
  - show a "Keep MeshDrop alive" section in Settings from `state.keepAlive`;
  - Devices calls `takeSharedItems()` when `sharedPending > 0` and adds them to the item list.
- **`AppController(home, SettingsStore, HistoryStore, Platform, Engine factory)`** is the Java port of `apps/desktop/src/main/controller.ts`:
  - transfer rows by tag and session;
  - 100 ms state throttle;
  - history (cap 500);
  - notifications and clipboard handling per the M3 rules;
  - `setSettings` validation identical to `settings.ts` (alias, port, booleans);
  - restart on alias, port or discovery change, with rollback on bind failure and `state.error` on a busy port.
  - `Platform` is `notify(title, body, String revealUriOrNull)`, `writeClipboard(text)`, `readClipboard()`, `openInbox()` and `reveal(String)`.
- `StateJson.of(AppState) → String` gives the exact `AppState` JSON the renderer expects.
- **`Bridge`** has one `@JavascriptInterface void call(int id, String method, String argsJson)`.
  - It runs on a background executor and replies with `evaluateJavascript("window.__mdResolve(id, ok, json)")`.
  - It pushes state with `window.__mdState(json)`.
  - It only accepts calls while the page origin is the asset origin.
  - `shim.js` defines every `DesktopApi` method (`pathForFile` returns `''`) and `onState`.
- **`WebUi`**:
  - `WebViewAssetLoader` maps `/` to `assets/web/` (the renderer build);
  - `addDocumentStartJavaScript(shim, Set.of("https://appassets.androidplatform.net"))`;
  - `shouldOverrideUrlLoading` blocks everything else.
- **`scripts/build-renderer.sh`** runs `pnpm --filter @meshdrop/desktop exec vite build -c vite.renderer.config.ts --outDir <tmp>` and copies the result into `app/src/main/assets/web/` (git-ignored; the Gradle `preBuild` depends on it).

- [ ] **Step 1:** Write the tests.
  - `AppControllerTest` ports the desktop `controller.test.ts` cases that apply without a mesh, over two Java engines:
    - "pairs by address, sends a file";
    - "clipboard only when clipboardReceive";
    - "throttles state updates" (2 000 files);
    - "hostile alias as plain data";
    - "refuses a port in use";
    - "keeps two concurrent sends to one device apart";
    - "starts without receiving when its port is taken".
  - `StateJsonTest`: the JSON parses in Node (`node -e` reads it) and matches `AppState`'s keys.
  - The renderer: `pnpm --filter @meshdrop/desktop test` and the `e2e` suite stay green.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement. `MainActivity` binds `MeshService` (Task 10; until then it runs the controller in-process) and hosts the WebView. The `#picker` route stays.
- [ ] **Step 4:** Run `:engine:test`, then `gradle --offline :app:assembleDebug`. Install on the emulator `markd35` (`adb -e install -r`), launch it, and check that `uiautomator dump` contains `Devices`, `Transfers` and `Inbox` and not `Mesh`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat(android): Java AppController and the shared React UI in a WebView`.

### Task 10: Foreground service, storage, sharing and clipboard

**Files:**
- Create: `MeshService.java`, `AndroidPlatform.java`, `MediaStoreSink.java`, `UriSource.java`, `ClipboardSendActivity.java`, `ClipboardTile.java`, `BootReceiver.java` and `KeystoreVault.java`.
- Modify: `AndroidManifest.xml`.
- Test: `app/src/debug/.../DebugCommands.java` (an adb broadcast receiver: `pair`, `send`, `state`) and `scripts/emulator-e2e.sh`.

**Behaviour and values:**
- **`MeshService`**, `foregroundServiceType="connectedDevice"`:
  - permissions `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `CHANGE_WIFI_MULTICAST_STATE`, `ACCESS_WIFI_STATE`, `ACCESS_NETWORK_STATE`, `INTERNET`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED` and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`;
  - a low-importance channel `service` with an ongoing notification "Receiving on <Wi-Fi name or 'this network'>", carrying actions **Send clipboard** and **Pause receiving** / **Resume**;
  - it owns the `AppController`;
  - it holds a `MulticastLock` while discovery runs;
  - a `ConnectivityManager.NetworkCallback` on Wi-Fi availability or change calls `engine.restartNetworking()` (**Review Focus #1**);
  - `START_STICKY`;
  - `BootReceiver` starts it after `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.
- **`MediaStoreSink implements InboxSink`**:
  - `publish` inserts into `MediaStore.Downloads` with `RELATIVE_PATH = "Download/MeshDrop/" + dir` and `IS_PENDING=1`, copies, then sets `IS_PENDING=0`;
  - it picks `stem (n).ext` itself by querying existing `DISPLAY_NAME`s in that relative path, so the landed name is known and reported (**Review Focus #3**);
  - `exists` queries MediaStore.
  - Partial data stays in the app home until `complete`.
- **`UriSource implements Source`**:
  - backed by `ContentResolver.openFileDescriptor(uri,"r")` → `FileInputStream.getChannel()`;
  - name and size from `OpenableColumns`;
  - `lastModified` from `DocumentsContract.Document.COLUMN_LAST_MODIFIED` (0 if absent: then only the per-chunk hashes guard against changes);
  - persistable read permission is taken for picked and shared URIs so outbox resumes survive restarts;
  - a folder is a `SourceTree` over a SAF tree URI (`ACTION_OPEN_DOCUMENT_TREE`).
- **Picking and sharing:**
  - `pickFiles` uses `ACTION_OPEN_DOCUMENT` (multiple) and `pickFolder` uses `ACTION_OPEN_DOCUMENT_TREE`;
  - `MainActivity` handles `ACTION_SEND`/`SEND_MULTIPLE` (any `*/*` and `text/plain`): items are queued in the controller, which sets `sharedPending`.
- **Clipboard:**
  - received clipboard text uses `ClipboardManager.setPrimaryClip` (allowed in the background) plus a notification;
  - sending reads the clipboard only in `ClipboardSendActivity`, a translucent dialog-themed activity whose WebView shows the `#picker` route. It is started by the notification action and by `ClipboardTile` (a quick-settings tile).
- **`KeystoreVault implements KeyVault`**: AES-256-GCM key `meshdrop-identity` in AndroidKeyStore; `key.bin` = IV ‖ ciphertext.
- **Notifications:** received files (tap opens the file via `ACTION_VIEW` on the content URI), text, clipboard ("Copied text from <alias>") and failures.

- [ ] **Step 1:** Write `scripts/emulator-e2e.sh`. It:
  1. builds and installs the debug APK on the running emulator `markd35`;
  2. grants `POST_NOTIFICATIONS` and starts the service;
  3. runs a Node `listen --home $H --port 0` on the host;
  4. runs `adb forward tcp:$F tcp:53318` and `node cli.ts pair 127.0.0.1:$F phone --home $H`;
  5. runs `adb shell am broadcast -a io.github.hafijbge.meshdrop.debug.PAIR --es host 10.0.2.2 --ei port <node port> --es alias pc`;
  6. sends a 9 MiB file and text from Node; `adb shell ls /sdcard/Download/MeshDrop` shows it with the same SHA-256 (`adb shell sha256sum`);
  7. pushes a file to `/sdcard/Download/x.bin` and broadcasts `SEND` with its content URI; the Node inbox gets it, byte-equal;
  8. sends `ü 😀.txt` twice; the phone has `ü 😀 (1).txt`;
  9. `am force-stop` during a 200 MiB receive, then restarts the service; Node's `resume` completes (**Review Focus #4**).
  
  The script exits non-zero on any mismatch.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement. `DebugCommands` exists only in the `debug` source set.
- [ ] **Step 4:** Run the script. Expected: `emulator-e2e: OK`. Then run `:engine:test`. Expected: green.
- [ ] **Step 5:** Commit: `feat(android): foreground service, MediaStore inbox, SAF, share target, clipboard`.

### Task 11: Keep-alive checklist, release build and docs

**Files:**
- Create: `KeepAlive.java` and `scripts/release.sh`.
- Modify: `README.md` (Android section) and `docs/protocol.md` ("Notes for other engines": record what M4a chose).
- Test: `KeepAliveTest.java` in `:engine` (pure ROM detection and step list) and the emulator check below.

**Behaviour and values:**
- **ROM detection** (`KeepAlive.rom(Map<String,String> props)`):
  - `miui` if `ro.miui.ui.version.name` or `ro.mi.os.version.name` is set;
  - `hios` if `ro.tranos.type` or `ro.os.hios.version` is set, or `Build.MANUFACTURER` is `TECNO`/`INFINIX`/`itel`;
  - else `stock`.
- **Steps:**
  - all ROMs: `battery` (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, done when `isIgnoringBatteryOptimizations`) and `notifications`;
  - `miui`: `autostart` (component `com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity`) and `battery-saver` (`com.miui.powerkeeper/.ui.HiddenAppsConfigActivity` with extras `package_name`/`package_label`);
  - `hios`: `autostart` (`com.transsion.phonemaster/com.cyin.himgr.autostart.AutoStartActivity`).
  - Every intent falls back to `Settings.ACTION_APPLICATION_DETAILS_SETTINGS` plus a text guide in the step label when it cannot resolve.
  - On first run the app opens Settings → "Keep MeshDrop alive" once.
- **Release:**
  - `scripts/release.sh` sources `~/.android/meshdrop-release.env` (`MESHDROP_KS`, `MESHDROP_KS_PASS`, `MESHDROP_KEY_ALIAS=meshdrop`, `MESHDROP_KEY_PASS`) and runs `gradle --offline assembleRelease`;
  - the output is `apps/android/dist-apk/MeshDrop-0.1.0.apk` plus `SHA256SUMS` (git-ignored);
  - if the keystore is missing, the script creates it with `keytool -genkeypair -keyalg RSA -keysize 4096 -validity 10000 -alias meshdrop` and records the certificate SHA-256.
  - R8: `minifyEnabled false` in 0.1.0.

- [ ] **Step 1:** Write `KeepAliveTest`:
  - MIUI props → `miui` with steps `battery`, `notifications`, `autostart`, `battery-saver`;
  - Tecno manufacturer → `hios`;
  - empty → `stock` with two steps.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `:engine:test`, then `scripts/emulator-e2e.sh`, then `scripts/release.sh`. Expected: green. `apksigner verify --print-certs` shows the meshdrop certificate, and the release APK installs on `markd35` and shows Devices.
- [ ] **Step 5:** Commit: `feat(android): keep-alive checklist, signed release build, docs`.
- [ ] **Step 6 (manual, with the owner):** ask before installing on the Redmi (`192.168.1.108:5555`). MIUI blocks `adb install` (`INSTALL_FAILED_USER_RESTRICTED`); fall back to `adb push` to `/sdcard/Download` so the owner installs from the file manager. Then pair it with the PC by address and record the result:
  - PC → phone and phone → PC transfers;
  - a share from the gallery;
  - the clipboard tile;
  - received clipboard text;
  - the device staying reachable after 30 minutes with the screen off.

---

## Rulings made while planning

- **minSdk 29** (owner, 2026-10-24) replaces the spec's 26: platform TLS 1.3 and MediaStore, no Conscrypt. Cost if wrong: an Android 9 phone can't install; Conscrypt can be added later.
- **The identity key** is a software P-256 key sealed by an AndroidKeyStore AES key, not a keystore EC key: HPKE needs raw ECDH, and keystore ECDH is API 31+ (protocol notes). Cost if wrong: weaker at-rest protection on a rooted phone.
- **mDNS (spec §8)** is deferred: UDP multicast plus manual address plus subnet scan match what the desktop does today. Cost if wrong: devices on networks that pass only mDNS aren't found automatically.
- **The Android inbox** is fixed to `Download/MeshDrop` in M4a; a folder choice (SAF tree) comes with M4b. Cost if wrong: the owner can't redirect received files yet.
- **Own HTTP/1.1 and JSON** instead of OkHttp, NanoHTTPD or org.json: none are cached, org.json is absent on the JVM test runtime, and the protocol needs exact JSON escaping anyway. Cost if wrong: more code to review.
- **Interop is tested on the JVM** against Node, plus one adb-driven emulator script, instead of androidx.test instrumentation (not cached). Cost if wrong: Android-only paths (MediaStore, SAF, service) rely on the emulator script and the owner's checks.
