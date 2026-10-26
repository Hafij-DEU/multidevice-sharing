# Builds dist-win\MeshDrop-Setup-<version>.exe, the Windows 11 installer (x64). Run on Windows:
#   pnpm --filter @meshdrop/desktop dist:win
# electron-builder works in a scratch directory, like build-deb.sh.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }
$out = Join-Path ([IO.Path]::GetTempPath()) ("meshdrop-win-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
try {
  pnpm exec electron-builder --win nsis --x64 --config electron-builder.yml --publish never "-c.directories.output=$out"
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
  New-Item -ItemType Directory -Force dist-win | Out-Null
  Copy-Item (Join-Path $out '*.exe') dist-win -Force
  Get-ChildItem dist-win\*.exe | Format-Table Name, Length -AutoSize
} finally {
  Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
}
