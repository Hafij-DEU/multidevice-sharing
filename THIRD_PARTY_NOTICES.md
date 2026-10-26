# Third-party notices

MeshDrop is licensed GPL-3.0-only (see LICENSE). It uses the following third-party software, all under
licenses compatible with the GPL.

| Component | Used for | License |
| --- | --- | --- |
| [LocalSend protocol](https://github.com/localsend/protocol) (v2) | Interoperability with LocalSend apps (MeshDrop implements the protocol; it contains no LocalSend code) | MIT |
| [Electron](https://www.electronjs.org/) | Desktop app (Ubuntu, Windows) | MIT (Chromium inside: BSD-3-Clause and others, see LICENSES.chromium.html in the app) |
| [React](https://react.dev/) and react-dom | User interface | MIT |
| [ws](https://github.com/websockets/ws) | WebSocket hub link | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) (and its dependencies: pngjs, dijkstrajs, yargs and helpers) | QR codes | MIT / ISC |
| [ZXing core](https://github.com/zxing/zxing) 3.5.3 | QR scanning on Android | Apache-2.0 |
| [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit) | Android WebView helpers | Apache-2.0 |
| Android WebView (system component) | Android web engine | Chromium licenses |

Build and test tools only (not shipped): Vite (MIT), TypeScript (Apache-2.0), Vitest (MIT), Playwright (Apache-2.0).

The list of the Node packages bundled in the apps comes from `pnpm licenses list --prod`: 23 MIT and 7 ISC.
