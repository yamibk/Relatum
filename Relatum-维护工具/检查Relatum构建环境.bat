@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Relatum - Check build environment
set "REPO=%~dp0.."
if defined RELATUM_REPO set "REPO=%RELATUM_REPO%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%REPO%\build-desktop.ps1" -CheckOnly
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (echo Environment check passed.) else (echo Check failed. Run the preparation BAT and read the log above.)
pause
exit /b %RESULT%
