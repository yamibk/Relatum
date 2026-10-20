@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Relatum - Offline environment repair
set "REPO=%~dp0.."
if defined RELATUM_REPO set "REPO=%RELATUM_REPO%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%REPO%\prepare-desktop.ps1" -Offline
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Offline repair stopped. Missing cached files require the normal preparation BAT.
pause
exit /b %RESULT%
