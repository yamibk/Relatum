@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title Relatum - Build release folder

echo.
echo ============================================================
echo   Relatum：把当前源码构建为 Windows release 文件夹
echo ============================================================
echo.
echo 本工具只构建 Relatum-release。
echo 不压缩 ZIP，不运行 EXE，不提交或推送 Git，也不发布 GitHub Release。
echo 当前源码可以尚未 commit；网页测试产生的 data 和 canvases 不会被打包。
echo.

where powershell >nul 2>&1
if errorlevel 1 (
    echo [错误] 找不到 Windows PowerShell。
    goto :failed
)

where git >nul 2>&1
if errorlevel 1 (
    echo [错误] 找不到 Git。请先安装 Git，并使用 Git 仓库而不是下载的源码 ZIP。
    goto :failed
)

set "REPO="
if defined RELATUM_REPO (
    call :try_repo "%RELATUM_REPO%"
    if not defined REPO (
        echo [错误] 环境变量 RELATUM_REPO 指向的目录不是有效的 Relatum 仓库：
        echo %RELATUM_REPO%
        goto :failed
    )
)
if not defined REPO call :try_repo "%~dp0.."
if not defined REPO call :try_repo "%~dp0..\Relatum"
if not defined REPO call :try_repo "%~dp0..\Relatum-Opensource"
if not defined REPO for /d %%D in ("%~dp0..\*") do if not defined REPO call :try_repo "%%~fD"

if not defined REPO (
    echo [错误] 无法自动找到 Relatum Git 仓库。
    echo 请把本 BAT 保留在仓库根目录下的 Relatum-维护工具 文件夹中。
    echo 仓库必须包含 .git、build-desktop.ps1、app.py、desktop.py 和 assets。
    goto :failed
)

for %%I in ("%REPO%\..") do set "BASE=%%~fI"
set "RELEASE=%BASE%\Relatum-release"
set "RELATUM_RELEASE_PATH=%RELEASE%"

echo [1/4] 已找到源码仓库：
echo %REPO%
echo.
git -C "%REPO%" status -sb
if errorlevel 1 (
    echo [错误] 无法读取 Git 状态。
    goto :failed
)

if exist "%RELEASE%" (
    echo.
    echo [2/4] 检查旧 Relatum-release 是否含有用户数据...
    powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath($env:RELATUM_RELEASE_PATH); $bad=@(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { $_.FullName -match '[\/](data|canvases)([\/]|$)' -or $_.Name -like '*.canvas' -or $_.FullName -match '\.assets([\/]|$)' -or $_.Name -ieq 'ai.json' -or $_.Name -match '^\.env($|\.)' -or $_.Extension -in @('.pem','.key') }); if($bad.Count){$bad.FullName; exit 1}else{'Existing release is clean and may be replaced.'}"
    if errorlevel 1 (
        echo.
        echo [停止] 旧 Relatum-release 中发现了用户数据或敏感文件。
        echo 本工具不会覆盖或删除它。请先备份并移走整个旧目录，再重新运行。
        echo 不要使用 -ForceReplaceUserData。
        goto :failed
    )
)

pushd "%REPO%" >nul
if errorlevel 1 (
    echo [错误] 无法进入源码仓库。
    goto :failed
)

echo.
echo [2/4] 检查本次会参与构建的公开源码...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\check-public.ps1"
if errorlevel 1 (
    echo [错误] 公开边界检查失败，已停止构建。
    popd >nul
    goto :failed
)

echo.
set "RELATUM_BUILD_SCRIPT=%REPO%\build-desktop.ps1"
set "RELATUM_BUILD_PY=%TEMP%\canvas-desktop-build-venv\Scripts\python.exe"
set "EXPECTED_WEBVIEW="
set "EXPECTED_PYINSTALLER="
set "EXPECTED_PILLOW_MIN="
set "EXPECTED_PILLOW_MAX="
set "USE_SKIP_INSTALL="

if exist "%RELATUM_BUILD_PY%" (
    for /f "tokens=1-4 delims=|" %%A in ('powershell -NoProfile -Command "$t=[IO.File]::ReadAllText($env:RELATUM_BUILD_SCRIPT); $a=[regex]::Match($t,'''pywebview==([^'']+)''').Groups[1].Value; $b=[regex]::Match($t,'''pyinstaller==([^'']+)''').Groups[1].Value; $p=[regex]::Match($t,'''Pillow\x3e=([^,'']+),\x3c([^'']+)'''); if($a -and $b -and $p.Success){$a+'|'+$b+'|'+$p.Groups[1].Value+'|'+$p.Groups[2].Value}"') do (
        set "EXPECTED_WEBVIEW=%%A"
        set "EXPECTED_PYINSTALLER=%%B"
        set "EXPECTED_PILLOW_MIN=%%C"
        set "EXPECTED_PILLOW_MAX=%%D"
    )
)

if defined EXPECTED_WEBVIEW if defined EXPECTED_PYINSTALLER if defined EXPECTED_PILLOW_MIN if defined EXPECTED_PILLOW_MAX (
    "%RELATUM_BUILD_PY%" -c "import re,sys; from importlib.metadata import version; import webview,PyInstaller,PIL; v=lambda s:tuple(int(x) for x in (re.findall(r'\d+',s)+['0','0','0'])[:3]); ok=(3,9)<=sys.version_info[:2]<=(3,12) and version('pywebview')==sys.argv[1] and version('pyinstaller')==sys.argv[2] and v(version('Pillow'))>=v(sys.argv[3]) and v(version('Pillow'))<v(sys.argv[4]); raise SystemExit(0 if ok else 1)" "%EXPECTED_WEBVIEW%" "%EXPECTED_PYINSTALLER%" "%EXPECTED_PILLOW_MIN%" "%EXPECTED_PILLOW_MAX%" >nul 2>&1
    if not errorlevel 1 set "USE_SKIP_INSTALL=1"
)

echo.
if defined USE_SKIP_INSTALL (
    echo [3/4] 已检测到匹配的构建依赖，本次离线复用，不再联网安装...
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\build-desktop.ps1" -SkipInstall
) else (
    echo [3/4] 首次构建、依赖缺失或版本已变化，将联网安装依赖...
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\build-desktop.ps1"
)
if errorlevel 1 (
    echo [错误] 构建失败。不要运行或上传失败状态下的 Relatum-release。
    popd >nul
    goto :failed
)

popd >nul

if not exist "%RELEASE%\Relatum.exe" (
    echo [错误] 构建后找不到 Relatum.exe。
    goto :failed
)
if not exist "%RELEASE%\Relatum.exe.config" (
    echo [错误] 构建后找不到 Relatum.exe.config。
    goto :failed
)
if not exist "%RELEASE%\_internal" (
    echo [错误] 构建后找不到 _internal 文件夹。
    goto :failed
)

echo.
echo [4/4] 递归检查新 release 是否混入用户数据...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath($env:RELATUM_RELEASE_PATH); $bad=@(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { $_.FullName -match '[\/](data|canvases)([\/]|$)' -or $_.Name -like '*.canvas' -or $_.FullName -match '\.assets([\/]|$)' -or $_.Name -ieq 'ai.json' -or $_.Name -match '^\.env($|\.)' -or $_.Extension -in @('.pem','.key') }); if($bad.Count){$bad.FullName; exit 1}else{'Release data check passed.'}"
if errorlevel 1 (
    echo [错误] 新 release 中发现了不应存在的用户数据或敏感文件。
    echo 不要运行、压缩或上传这个目录，请把完整提示交给 AI。
    goto :failed
)

echo.
echo ============================================================
echo   构建完成
echo ============================================================
echo.
echo 干净的 Windows 成品目录：
echo %RELEASE%
echo.
echo 本 BAT 没有压缩、上传或发布任何内容。
echo 测试 EXE 时不要直接运行这份原始 release；请先复制整个文件夹作为测试副本。
echo 具体步骤见同目录的“05-如何构建和测试EXE客户端.md”。
echo.
pause
exit /b 0

:failed
echo.
echo 操作已停止。没有执行 Git commit、push、ZIP 压缩或 GitHub Release 发布。
echo.
pause
exit /b 1

:try_repo
for %%I in ("%~1") do set "CANDIDATE=%%~fI"
if not exist "%CANDIDATE%\.git" exit /b 0
if not exist "%CANDIDATE%\build-desktop.ps1" exit /b 0
if not exist "%CANDIDATE%\scripts\check-public.ps1" exit /b 0
if not exist "%CANDIDATE%\app.py" exit /b 0
if not exist "%CANDIDATE%\desktop.py" exit /b 0
if not exist "%CANDIDATE%\assets" exit /b 0
set "REPO=%CANDIDATE%"
exit /b 0
