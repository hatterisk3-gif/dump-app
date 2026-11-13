@echo off
REM Launcher for dumpdns: protocol (called from registry)
REM Example args: dumpdns:lock / dumpdns://unlock
setlocal EnableDelayedExpansion
set "RAW=%~1"
set "ACTION=status"
if defined RAW (
  set "ACTION=!RAW!"
  set "ACTION=!ACTION:dumpdns:=!"
  set "ACTION=!ACTION:/=!"
  for /f "tokens=1 delims=?&#" %%A in ("!ACTION!") do set "ACTION=%%A"
)
set "DUMP_DNS_NO_PAUSE=1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" "!ACTION!"
endlocal
