@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "LOGS=%LOCALAPPDATA%\RelatumBuild\logs"
if defined RELATUM_BUILD_HOME set "LOGS=%RELATUM_BUILD_HOME%\logs"
if not exist "%LOGS%" (
    echo No build logs yet. Run a build or environment check first.
    pause
    exit /b 1
)
start "" "%SystemRoot%\explorer.exe" "%LOGS%"
