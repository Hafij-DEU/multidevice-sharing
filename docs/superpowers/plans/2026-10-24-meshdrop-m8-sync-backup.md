# MeshDrop M8: Folder Sync and Photo Backup — Implementation Plan

> Lean mode (owner): executed natively, GitHub CI + CodeQL check the pushed work.

**Goal:**
- **Folder sync (M8a):** one dedicated folder (not the owner's working folder) stays the same on the PC and the phone.
- **Photo backup (M8b):** new camera photos and videos on the phone go to the PC by themselves when both are on the home Wi-Fi.

**Owner's words:** "Folder sync: keep one folder the same on the PC and the phone … a specific folder will be synced, not the working one." "Auto photo backup: new phone photos go to the PC when on home Wi-Fi."

## Decisions (Claude's calls)

- **LAN only.** Sync and backup run only when the partner is reachable on the LAN, over the pinned mutual-TLS link. The relay would show the hub plaintext: chunks of normal sends are HPKE-sealed, but sync reads would not be. "Home Wi-Fi" = the partner answers on the LAN. This needs no location permission to read the Wi-Fi name. Cost if wrong: no sync while away. Sync over the hub can be added later, with sealed bodies.
- **Opt-in per partner, both ways.** Settings → Sync: a folder, plus a checklist of trusted devices. A device serves its folder only to the partners it ticked, so both owners tick each other, as with pairing.
- **Pull-based rounds.** Each side pulls from its partner:
  1. `GET /mesh/v1/sync/index` → `{v:1, files:[{rel,size,mtime,hash}], gone:[{rel,at}]}`.
  2. `GET /mesh/v1/sync/file?rel=…&hash=…&offset=…&len=…` → raw bytes, at most 4 MiB, refused unless the file still has that hash.
  3. `POST /mesh/v1/sync/poke` → "I changed: pull soon".

  A round runs when the partner appears, after a local change (debounced 2 s, then poke), and every 60 s while the partner is present.
- **Three-way merge per path.** Inputs: local L, remote R and base B (the hash both sides last agreed on, kept per partner).
  - L == R → the base becomes L.
  - R changed and L == B → take R (download, or delete when R is gone).
  - L changed and R == B → nothing to do; the partner pulls it.
  - Both changed:
    - a change beats a delete;
    - between two changes, the newer mtime wins (tie: the larger device id). The loser is kept as `name (conflict from <alias> <yyyy-mm-dd hh-mm>).ext`. Only the side that loses renames, so no conflict copies cascade.
- **Deletes are soft.** A deleted file goes to `<sync>/.meshdrop-trash/` for 30 days. Tombstones are kept 30 days.
- **Ignored:** `.meshdrop-*`, `*.part`, `~$*`, `.~lock.*`, `.DS_Store`, `Thumbs.db`. Symlinks and special files are skipped.
- **Index cache:** sha256 is recomputed only when size or mtime changed (`<home>/sync/index.json`). Per-partner bases are in `<home>/sync/base-<id>.json`.
- **Downloads** go to `<sync>/.meshdrop-partial/<hash>`, are verified against the hash, then moved into place. The move replaces the file only if the local file still has the hash the decision was made on; otherwise the change is redone in the next round.
- **Android folder:** a folder picked with the system picker (SAF tree, persistable permission), behind a `SyncFolder` interface (list / open / write / move / delete) in the engine. `PathSyncFolder` serves the JVM and tests; `SafSyncFolder` lives in the app module.
- **Photo backup:** Android only, one way, phone → PC.
  - The phone watches MediaStore images and videos under `DCIM/` (`READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` on 13+, `READ_EXTERNAL_STORAGE` before).
  - It sends new items with the normal send pipeline (outbox, resume) to the chosen PC, but only when the route is `lan`.
  - The manifest carries `backup: true`. The PC lands those files in its backup folder (Settings, default `~/Pictures/MeshDrop Backup/<phone alias>/`), not in the inbox.
  - The phone remembers sent MediaStore ids (`<home>/backup.json`). The first run asks: "Back up existing photos too?" (default: only new ones).

## Tasks

1. **Core sync model (Node).** `packages/core/src/sync/`:
   - `ignore.ts`, `index.ts` (scan + hash cache), `merge.ts` (a pure three-way decision → actions), `state.ts` (bases, tombstones).
   - Tests: a merge table covering every row above, plus the ignore rules.
2. **Sync routes + client (Node).**
   - `sync/server.ts`: handler hook for `sync/index`, `sync/file`, `sync/poke`. Only partners ticked here may call it.
   - `sync/client.ts`: a round over LanTransport (download, verify, apply, trash).
   - Engine: `syncConfig()/syncSet({folder, partners})`, `syncStatus()`, rounds on peer/poke/watch/timer, events `sync: {type:'round'|'file'|'conflict'|'error'}`.
   - Test: two engines with two folders: add, edit, delete, conflict, rename, a file being written during the round.
3. **Desktop.**
   - More → Sync page: folder picker, partner checklist, status (last round, files, conflicts), "Sync now".
   - Settings fields `syncFolder`, `syncPartners`, `backupFolder`.
   - Controller tests.
4. **Java engine sync.**
   - Ports of ignore/index/merge/state/client/server against `SyncFolder` (`PathSyncFolder`).
   - Tests: the same merge table; interop with a Node engine (Node ↔ Java sync both ways).
5. **Android.**
   - `SafSyncFolder`, the folder picker, the Sync page shared with the desktop renderer.
   - Rounds in the foreground service.
6. **Photo backup.**
   - Manifest `backup` flag on both engines.
   - The PC lands backups in `backupFolder/<alias>/` (Node + Java receiver).
   - The Android MediaStore watcher, permission and Settings toggle (PC picker).
   - Tests: Node receiver landing; Java backup state (ids sent once).
7. **Docs and release 0.3.0.**

## Review focus

- Never lose data: no case in the merge table deletes or overwrites a version that no other copy has. The trash and conflict copies are the safety net.
- A file edited while it is being read or downloaded must not be applied half-done (hash checks on both ends).
- Path safety: `rel` goes through `safeRelPath`; nothing outside the sync folder; no symlink is followed.
- Only ticked partners can read the folder (403 otherwise), even trusted ones.
