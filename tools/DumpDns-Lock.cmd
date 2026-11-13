@echo off
setlocal EnableDelayedExpansion
title DUMP DNS Lock
echo Requesting Administrator permission...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" lock
set "ERR=!ERRORLEVEL!"
if not "!ERR!"=="0" (
  echo.
  echo [ERROR] lock failed. code=!ERR!
  echo If UAC was cancelled, run this file again and choose Yes.
  pause
)
endlocal
