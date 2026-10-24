# MeshDrop M6: LocalSend v2 Interop — Implementation Plan

> Lean mode (owner): executing-plans, no review subagent; GitHub CI and CodeQL check the pushed branch.

**Goal:** LocalSend users on the same network show up in MeshDrop as untrusted nearby devices. They can send to the owner after the owner accepts, and the owner can send to them (spec §3 goal 8).

**Spec:**
- §3 goal 8;
- §8 LAN discovery: LocalSend-compatible announce on `224.0.0.167:53317`;
- §10 interop.

**Protocol:** LocalSend protocol v2.
- **Announce:** UDP multicast JSON `{alias, version:"2.0", deviceModel, deviceType, fingerprint, port, protocol, download, announce}`.
- **API** under `/api/localsend/v2/`:
  - `register` (POST, the device info), `info` (GET);
  - `prepare-upload` (POST `{info, files:{id:{id, fileName, size, fileType, sha256?, preview?}}}`): `200 {sessionId, files:{id: token}}`, `204` when nothing needs uploading, `403` rejected, `409` another session is active;
  - `upload` (POST `?sessionId&fileId&token`, raw body);
  - `cancel` (POST `?sessionId`).
- **Fingerprint:** over HTTPS, SHA-256 of the certificate, which for MeshDrop is the device id.

## Tasks

1. **Protocol and server.** `packages/core/src/localsend/server.ts`, served on HTTPS port 53317 (configurable, 0 in tests) with the device identity.
   - **One session at a time;** others get `409`.
   - **`prepare-upload` waits** for the owner's answer, at most 120 s, then `403`.
   - **Message-only sends** (`text/plain` with `preview`) are recorded as text and answered `204`.
   - **Files:** names pass `safeRelPath`, are streamed into `<home>/localsend-partial/`, then land in the inbox under free names (shared helper with the M5a guest code).
   - **Cancel** removes the partial data.
   - **Tests:** a fake LocalSend client written against the protocol covers accept, reject, timeout, `409` for a second session, a bad token, a hostile name, and a message.
2. **Discovery.** `packages/core/src/localsend/discovery.ts`.
   - Multicast on `224.0.0.167:53317`. On a peer's announce we answer through its `/register` (HTTPS), falling back to a multicast reply. Peers are kept by fingerprint and expire after 60 s silent.
   - The test uses loopback multicast with its own group and port.
3. **Client.** `packages/core/src/localsend/client.ts`.
   - Sends files and text to a peer: `prepare-upload` with our info, then each `upload`.
   - A `403` is reported as `declined`.
   - The fingerprint is verified against the peer's TLS certificate when it uses HTTPS.
   - **Test:** our client against our own server, and against a fake server written from the protocol text.
4. **Engine and desktop.**
   - **Engine:**
     - options `localsend: {port, multicast} | false`;
     - `devices()` lists LocalSend peers as role `localsend`, untrusted, reach `lan`;
     - incoming offers appear in `guestState().offers` with `via: 'localsend'` and are answered by `guestAccept` / `guestReject`;
     - `localsendSend(fingerprint, items)`.
   - **Desktop:** LocalSend devices can be picked on Devices and sent to, and the accept prompt names the LocalSend device.
   - **Tests:** engine-level ones.
5. **Docs:** README and `docs/protocol.md` notes.

## Rulings

- **No real LocalSend client is available offline here.** The fakes are written from the protocol, so real-app interop is the owner's check (and CI's, if a LocalSend CLI is added later). Cost if wrong: an incompatibility shows only against the real app.
- **Android later.** The Java engine does not serve LocalSend yet. Cost if wrong: phones don't see LocalSend users in M6.
