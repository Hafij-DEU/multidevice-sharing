; Windows installer extras (electron-builder includes this in its NSIS script): what the .deb's
; after-install/after-remove do on Ubuntu, the Windows way.
;  - the firewall lets other devices reach MeshDrop (LAN discovery, transfers, guests, the hub)
;  - the meshdrop command line on PATH (<MeshDrop>\bin\meshdrop.cmd)
;  - Explorer: right-click files -> Send to -> MeshDrop (like the Files "Send with MeshDrop" script)

!macro meshdropPowerShell ARGS
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\meshdrop-path.ps1" ${ARGS} "$INSTDIR\bin"'
  Pop $0
!macroend

!macro customInstall
  ; one rule for the program, every protocol and network profile (Windows calls most new Wi-Fi "Public")
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="MeshDrop"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="MeshDrop" dir=in action=allow program="$INSTDIR\MeshDrop.exe" enable=yes profile=any description="MeshDrop: devices on your network send files to this PC"'
  Pop $0
  !insertmacro meshdropPowerShell add
  ; tell running programs (Explorer, new terminals) that PATH changed: WM_SETTINGCHANGE to all windows
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
  CreateShortCut "$SENDTO\MeshDrop.lnk" "$INSTDIR\MeshDrop.exe" "--send" "$INSTDIR\MeshDrop.exe" 0
!macroend

!macro customUnInstall
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="MeshDrop"'
  Pop $0
  !insertmacro meshdropPowerShell remove
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
  Delete "$SENDTO\MeshDrop.lnk"
!macroend
