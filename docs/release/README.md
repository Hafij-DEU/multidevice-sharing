# Releasing MeshDrop

These steps change things outside this repository. Do them yourself: nothing here does them for you.

1. **Version.** Set it in `apps/desktop/package.json` (`version`) and `apps/android/app/build.gradle`
   (`versionName` and a higher `versionCode`). Merge to `main`.
2. **APK signing secrets** (once). Add these to the GitHub repository secrets:
   - `MESHDROP_KEYSTORE_B64` = `base64 -w0 ~/.android/meshdrop-release.jks`;
   - `MESHDROP_KS_PASS`, `MESHDROP_KEY_ALIAS`, `MESHDROP_KEY_PASS` from `~/.android/meshdrop-release.env`.

   Every update must be signed with this same key.
3. **Tag.** `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow builds the .deb, the
   signed APK and the Windows installer, then creates a **draft** release. Check it, then
   publish it.
4. **App Hub (Ubuntu).** Add the entry below to `src/catalog.json` in Hafij-DEU/Application-hub and a
   96 px icon `src/icons/meshdrop.png` (from `apps/desktop/build/icon.png`). Release App Hub as usual.
5. **App Hub for Android.** Add the entry below to `catalog.json` in Hafij-DEU/app-hub-android, and a
   `<queries><package android:name="io.github.hafijbge.meshdrop"/></queries>` entry in its manifest
   (it has no QUERY_ALL_PACKAGES), plus an icon `icon_meshdrop`.

## App Hub catalog entry (`src/catalog.json`)

```json
{
  "id": "meshdrop",
  "name": "MeshDrop",
  "summary": "Send files between your PC and phones, on Wi-Fi or through your own hub",
  "repo": "Hafij-DEU/multidevice-sharing",
  "package": "meshdrop",
  "desktop": "meshdrop.desktop"
}
```

## App Hub for Android catalog entry (`catalog.json`)

```json
{
  "id": "meshdrop",
  "name": "MeshDrop",
  "repo": "Hafij-DEU/multidevice-sharing",
  "package": "io.github.hafijbge.meshdrop",
  "icon": "icon_meshdrop"
}
```

## Windows

`MeshDrop-Setup-<version>.exe` (NSIS, x64) is built by the Release workflow, or on a Windows PC with
`pnpm --filter @meshdrop/desktop dist:win` (into `apps/desktop/dist-win/`). It installs for every user
(administrator once) and, through `build/installer.nsh`: a Windows Firewall rule for MeshDrop.exe, the
`meshdrop` command (`bin/meshdrop.cmd`) on the system PATH and Explorer's Send to → MeshDrop; the
uninstaller takes them away again. The config lives in `%LOCALAPPDATA%\MeshDrop`.

The Windows parts are in `src/main/windows.ts`: remote input through `build/meshdrop-input.ps1`
(SendInput), PC actions, Start menu apps, ringing, the battery and the clipboard shortcut (Electron's
globalShortcut). Sound, camera and microphone (PipeWire) are Linux only. The installer is not code
signed, so SmartScreen warns on first run.
