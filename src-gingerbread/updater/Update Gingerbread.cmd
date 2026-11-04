@echo off
rem Reward Routine Automator - Gingerbread: double-click this to update.
rem The work happens in the .ps1 beside it; this wrapper only exists so the
rem script can be run by double-clicking, and so the window stays open long
rem enough to read the result. -ExecutionPolicy Bypass is required because the
rem script is unsigned; -NoProfile keeps a user's PowerShell profile from
rem changing how it runs.
setlocal
title Reward Routine Automator - Gingerbread updater

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update Gingerbread.ps1" %*
set "updaterExit=%errorlevel%"

echo.
pause
exit /b %updaterExit%
