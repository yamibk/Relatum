@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Relatum - Offline desktop build
set "REPO=%~dp0.."
if defined RELATUM_REPO set "REPO=%RELATUM_REPO%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%REPO%\build-desktop.ps1" %*
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Build stopped. See the log above. Prepare the environment with prepare-desktop.ps1 first.
pause
exit /b %RESULT%
