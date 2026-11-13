@echo off
setlocal
title DUMP DNS Helper Setup
echo.
echo  ========================================
echo   DUMP DNS Helper Setup
echo  ========================================
echo.
echo  Do NOT double-click DumpDnsHelper.ps1
echo  (Windows may open it in Notepad.)
echo.
echo  Run this Install-DumpDnsHelper.cmd instead.
echo  - Registers dumpdns: protocol
echo  - Copies helper to %%LOCALAPPDATA%%\DUMP
echo.
set "DUMP_DNS_NO_PAUSE=1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DumpDnsHelper.ps1" install
set "ERR=%ERRORLEVEL%"
echo.
echo  After setup:
echo    DumpDns-Lock.cmd   ... lock DNS to 1.1.1.3
echo    DumpDns-Unlock.cmd ... restore DNS
echo    Or use buttons in DUMP abstinence tab
echo.
if not "%ERR%"=="0" echo  [ERROR] install failed. code=%ERR%
pause
endlocal
