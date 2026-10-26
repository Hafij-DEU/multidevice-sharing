# Run by the Windows installer: puts <MeshDrop>\bin (the meshdrop command) on the system PATH, or
# takes it off again (what /usr/bin/meshdrop is on Ubuntu). Usage: meshdrop-path.ps1 add|remove <dir>
# The registry value is edited as is (REG_EXPAND_SZ, %SystemRoot% and friends left unexpanded).
param([Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action, [Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
$path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$dir = $Dir.TrimEnd('\')
$parts = @($path -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $dir })
if ($Action -eq 'add') { $parts += $dir }
$key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
