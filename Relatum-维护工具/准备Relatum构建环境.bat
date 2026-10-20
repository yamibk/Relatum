@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Relatum - Prepare desktop build environment
set "REPO=%~dp0.."
if defined RELATUM_REPO set "REPO=%RELATUM_REPO%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%REPO%\prepare-desktop.ps1" %*
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Preparation stopped. See the log above. A previously working environment was not replaced.
pause
exit /b %RESULT%
