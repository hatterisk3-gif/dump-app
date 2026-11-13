# DUMP DNS Helper - Cloudflare Family DNS (1.1.1.3 / 1.0.0.3)
# Usage:
#   DumpDnsHelper.ps1 lock
#   DumpDnsHelper.ps1 unlock
#   DumpDnsHelper.ps1 status
#   DumpDnsHelper.ps1 install
# Protocol: dumpdns:lock / dumpdns:unlock / dumpdns:status

param(
  [Parameter(Position = 0)]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$DnsPrimary = '1.1.1.3'
$DnsSecondary = '1.0.0.3'
$DnsPrimary6 = '2606:4700:4700::1113'
$DnsSecondary6 = '2606:4700:4700::1003'
$StateDir = Join-Path $env:LOCALAPPDATA 'DUMP'
$BackupFile = Join-Path $StateDir 'dns-backup.json'
$HelperCopy = Join-Path $StateDir 'DumpDnsHelper.ps1'
$FamilyDnsSet = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
  $DnsPrimary, $DnsSecondary, $DnsPrimary6, $DnsSecondary6
))

function Ensure-StateDir {
  if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir | Out-Null
  }
}

function Normalize-Action([string]$raw) {
  $a = [string]$raw
  if ($a -match '^dumpdns:(//)?(.+)$') { $a = $Matches[2] }
  $a = ($a -split '[?/&#]')[0]
  return ($a.Trim().ToLowerInvariant())
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Require-Admin {
  if (Test-IsAdmin) { return }
  $self = if (Test-Path -LiteralPath $HelperCopy) { $HelperCopy } else { $PSCommandPath }
  if (-not $self) { $self = $MyInvocation.MyCommand.Path }
  $argList = @(
    '-NoProfile'
    '-ExecutionPolicy', 'Bypass'
    '-File', $self
    $Action
  )
  try {
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -PassThru -Wait
    if ($null -eq $p) { exit 1 }
    exit $p.ExitCode
  } catch {
    Write-Host 'ERROR: Administrator approval was cancelled or blocked.'
    Write-Host 'Open DumpDns-Lock.cmd and choose Yes on the UAC prompt.'
    exit 1
  }
}

function Test-IsFamilyDns([string[]]$addrs) {
  if (-not $addrs -or $addrs.Count -eq 0) { return $false }
  foreach ($a in $addrs) {
    if ($FamilyDnsSet.Contains([string]$a)) { return $true }
  }
  return $false
}

function Get-TargetAdapterIndexes {
  $skip = 'Loopback|vEthernet|Hyper-V|WSL|Docker|Bluetooth|Local Area Connection\*'
  $indexes = New-Object 'System.Collections.Generic.HashSet[int]'
  try {
    Get-NetAdapter -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Status -eq 'Up' -and
        $_.InterfaceAlias -and
        $_.InterfaceAlias -notmatch $skip
      } |
      ForEach-Object { [void]$indexes.Add([int]$_.InterfaceIndex) }
  } catch {}

  Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.InterfaceAlias -and
      $_.InterfaceAlias -notmatch $skip -and
      $_.ServerAddresses -and
      $_.ServerAddresses.Count -gt 0
    } |
    ForEach-Object { [void]$indexes.Add([int]$_.InterfaceIndex) }

  return @($indexes)
}

function Get-AdapterSnapshot([int]$ifIndex) {
  $v4 = Get-DnsClientServerAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $v6 = Get-DnsClientServerAddress -InterfaceIndex $ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $alias = if ($v4 -and $v4.InterfaceAlias) { $v4.InterfaceAlias }
    elseif ($v6 -and $v6.InterfaceAlias) { $v6.InterfaceAlias }
    else { "if$ifIndex" }
  return [pscustomobject]@{
    InterfaceAlias = $alias
    InterfaceIndex = $ifIndex
    ServerAddresses = @($(if ($v4) { $v4.ServerAddresses } else { @() }))
    ServerAddresses6 = @($(if ($v6) { $v6.ServerAddresses } else { @() }))
  }
}

function Save-DnsBackup($snapshots) {
  Ensure-StateDir
  if (Test-Path -LiteralPath $BackupFile) { return }
  $items = @()
  foreach ($a in $snapshots) {
    # Do not backup Family DNS as "original" (would unlock to locked state)
    $v4 = @($a.ServerAddresses)
    $v6 = @($a.ServerAddresses6)
    if (Test-IsFamilyDns $v4) { $v4 = @() }
    if (Test-IsFamilyDns $v6) { $v6 = @() }
    $items += [pscustomobject]@{
      InterfaceAlias = $a.InterfaceAlias
      InterfaceIndex = $a.InterfaceIndex
      ServerAddresses = $v4
      ServerAddresses6 = $v6
    }
  }
  $payload = [pscustomobject]@{
    savedAt = (Get-Date).ToString('o')
    adapters = $items
  }
  $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $BackupFile -Encoding UTF8
}

function Set-FamilyDns {
  Require-Admin
  $indexes = @(Get-TargetAdapterIndexes)
  if (-not $indexes.Count) {
    Write-Host 'No target network adapter found.'
    exit 1
  }
  $snaps = @($indexes | ForEach-Object { Get-AdapterSnapshot $_ })
  Save-DnsBackup $snaps

  $ok = 0
  foreach ($a in $snaps) {
    try {
      Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ServerAddresses @($DnsPrimary, $DnsSecondary)
      try {
        Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ServerAddresses @($DnsPrimary6, $DnsSecondary6)
      } catch {
        # Some adapters reject IPv6 DNS; IPv4 lock still applies
      }
      Write-Host ("LOCK  {0} -> {1}, {2} (+IPv6 family)" -f $a.InterfaceAlias, $DnsPrimary, $DnsSecondary)
      $ok++
    } catch {
      Write-Host ("FAIL  {0}: {1}" -f $a.InterfaceAlias, $_.Exception.Message)
    }
  }
  try { ipconfig /flushdns | Out-Null } catch {}
  Write-Host ''
  if ($ok -gt 0) {
    Write-Host 'DNS set to Cloudflare Family (1.1.1.3 / 1.0.0.3).'
    Write-Host 'NOTE: Turn OFF browser Secure DNS / DoH, or sites can bypass this lock.'
    exit 0
  }
  Write-Host 'ERROR: Could not lock any adapter.'
  exit 1
}

function Restore-Dns {
  Require-Admin
  if (-not (Test-Path -LiteralPath $BackupFile)) {
    Write-Host 'No backup found. Resetting adapters to DHCP.'
    foreach ($idx in @(Get-TargetAdapterIndexes)) {
      $snap = Get-AdapterSnapshot $idx
      try {
        Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses
        Write-Host ("UNLOCK {0} -> DHCP" -f $snap.InterfaceAlias)
      } catch {
        Write-Host ("FAIL  {0}: {1}" -f $snap.InterfaceAlias, $_.Exception.Message)
      }
    }
    try { ipconfig /flushdns | Out-Null } catch {}
    return
  }
  $backup = Get-Content -LiteralPath $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($item in @($backup.adapters)) {
    try {
      $servers = @($item.ServerAddresses)
      $servers6 = @($item.ServerAddresses6)
      if ($servers.Count -eq 0) {
        Set-DnsClientServerAddress -InterfaceIndex $item.InterfaceIndex -ResetServerAddresses
        Write-Host ("UNLOCK {0} -> DHCP" -f $item.InterfaceAlias)
      } else {
        Set-DnsClientServerAddress -InterfaceIndex $item.InterfaceIndex -ServerAddresses $servers
        if ($servers6 -and $servers6.Count -gt 0 -and -not (Test-IsFamilyDns $servers6)) {
          try {
            Set-DnsClientServerAddress -InterfaceIndex $item.InterfaceIndex -ServerAddresses $servers6
          } catch {}
        }
        Write-Host ("UNLOCK {0} -> {1}" -f $item.InterfaceAlias, ($servers -join ', '))
      }
    } catch {
      Write-Host ("FAIL  {0}: {1}" -f $item.InterfaceAlias, $_.Exception.Message)
    }
  }
  try { ipconfig /flushdns | Out-Null } catch {}
  Write-Host ''
  Write-Host 'DNS restored from backup.'
}

function Show-Status {
  Write-Host '=== DUMP DNS Helper ==='
  Write-Host ("Primary target : {0} / {1}" -f $DnsPrimary, $DnsPrimary6)
  Write-Host ("Secondary      : {0} / {1}" -f $DnsSecondary, $DnsSecondary6)
  Write-Host ("Backup file    : {0}" -f $BackupFile)
  Write-Host ("Backup exists  : {0}" -f (Test-Path -LiteralPath $BackupFile))
  Write-Host ("IsAdmin        : {0}" -f (Test-IsAdmin))
  Write-Host ''
  foreach ($idx in @(Get-TargetAdapterIndexes)) {
    $a = Get-AdapterSnapshot $idx
    $mark = if (Test-IsFamilyDns $a.ServerAddresses) { ' [FAMILY]' } else { '' }
    Write-Host ("{0}: IPv4={1}{2}" -f $a.InterfaceAlias, (($a.ServerAddresses) -join ', '), $mark)
    if ($a.ServerAddresses6 -and $a.ServerAddresses6.Count -gt 0) {
      $mark6 = if (Test-IsFamilyDns $a.ServerAddresses6) { ' [FAMILY]' } else { '' }
      Write-Host ("  IPv6={0}{1}" -f (($a.ServerAddresses6) -join ', '), $mark6)
    }
  }
  Write-Host ''
  Write-Host 'If adult sites still open: disable Chrome/Edge Secure DNS (Use secure DNS = Off).'
}

function Install-Helper {
  Ensure-StateDir
  $src = $PSCommandPath
  if (-not $src) { $src = $MyInvocation.MyCommand.Path }
  $srcFull = [System.IO.Path]::GetFullPath($src)
  $destFull = [System.IO.Path]::GetFullPath($HelperCopy)
  if ($srcFull -ne $destFull) {
    Copy-Item -LiteralPath $srcFull -Destination $HelperCopy -Force
  }

  $runCmd = Join-Path $StateDir 'DumpDns-Run.cmd'
  $lockCmd = Join-Path $StateDir 'DumpDns-Lock.cmd'
  $unlockCmd = Join-Path $StateDir 'DumpDns-Unlock.cmd'

  @(
    '@echo off'
    'setlocal EnableDelayedExpansion'
    'set "RAW=%~1"'
    'set "ACTION=status"'
    'if defined RAW ('
    '  set "ACTION=!RAW!"'
    '  set "ACTION=!ACTION:dumpdns:=!"'
    '  set "ACTION=!ACTION:/=!"'
    '  for /f "tokens=1 delims=?&#" %%A in ("!ACTION!") do set "ACTION=%%A"'
    ')'
    'set "DUMP_DNS_NO_PAUSE=1"'
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" "!ACTION!"'
    'endlocal'
  ) | Set-Content -LiteralPath $runCmd -Encoding ASCII

  @(
    '@echo off'
    'setlocal EnableDelayedExpansion'
    'title DUMP DNS Lock'
    'echo Requesting Administrator permission...'
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" lock'
    'set "ERR=!ERRORLEVEL!"'
    'if not "!ERR!"=="0" ('
    '  echo.'
    '  echo [ERROR] lock failed. code=!ERR!'
    '  echo If UAC was cancelled, run this file again and choose Yes.'
    '  pause'
    ')'
    'endlocal'
  ) | Set-Content -LiteralPath $lockCmd -Encoding ASCII

  @(
    '@echo off'
    'setlocal EnableDelayedExpansion'
    'title DUMP DNS Unlock'
    'echo Requesting Administrator permission...'
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" unlock'
    'set "ERR=!ERRORLEVEL!"'
    'if not "!ERR!"=="0" ('
    '  echo.'
    '  echo [ERROR] unlock failed. code=!ERR!'
    '  pause'
    ')'
    'endlocal'
  ) | Set-Content -LiteralPath $unlockCmd -Encoding ASCII

  $cmd = "`"$runCmd`" `"%1`""
  New-Item -Path 'HKCU:\Software\Classes\dumpdns' -Force | Out-Null
  New-ItemProperty -Path 'HKCU:\Software\Classes\dumpdns' -Name '(default)' -Value 'URL:DUMP DNS Helper' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path 'HKCU:\Software\Classes\dumpdns' -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  New-Item -Path 'HKCU:\Software\Classes\dumpdns\shell\open\command' -Force | Out-Null
  New-ItemProperty -Path 'HKCU:\Software\Classes\dumpdns\shell\open\command' -Name '(default)' -Value $cmd -PropertyType String -Force | Out-Null

  Write-Host "Installed helper to: $StateDir"
  Write-Host '  DumpDnsHelper.ps1 / DumpDns-Run.cmd / DumpDns-Lock.cmd / DumpDns-Unlock.cmd'
  Write-Host 'Registered protocol: dumpdns:lock / dumpdns:unlock'
  Write-Host ''
  Write-Host 'NOTE: Do not double-click DumpDnsHelper.ps1 (opens in Notepad).'
  Write-Host '      Use DumpDns-Lock.cmd / DumpDns-Unlock.cmd instead.'
  Write-Host '      Browser Secure DNS/DoH must be OFF or lock is bypassed.'
}

$Action = Normalize-Action $Action
switch ($Action) {
  'lock' { Set-FamilyDns }
  'unlock' { Restore-Dns }
  'install' { Install-Helper }
  'status' { Show-Status }
  default {
    Write-Host "Unknown action: $Action"
    Write-Host 'Use: lock | unlock | status | install'
    exit 1
  }
}

if ($Host.Name -eq 'ConsoleHost' -and -not $env:DUMP_DNS_NO_PAUSE) {
  Write-Host ''
  Write-Host 'Press Enter to close...'
  [void][Console]::ReadLine()
}
