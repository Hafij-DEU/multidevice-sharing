@echo off
rem meshdrop command line, run by the bundled Electron in Node mode (installed in <MeshDrop>\bin, on PATH).
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\MeshDrop.exe" "%~dp0..\resources\cli.cjs" %*
