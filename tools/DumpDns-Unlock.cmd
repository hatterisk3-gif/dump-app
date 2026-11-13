@echo off
setlocal EnableDelayedExpansion
title DUMP DNS Unlock
echo Requesting Administrator permission...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" unlock
set "ERR=!ERRORLEVEL!"
if not "!ERR!"=="0" (
  echo.
  echo [ERROR] unlock failed. code=!ERR!
  pause
)
endlocal
