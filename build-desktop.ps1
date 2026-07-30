# Canvas desktop client packaging script (PyInstaller --onedir)
# ----------------------------------------------------------------------------
# Bundles the pywebview/WebView2 shell (desktop.py) + local server (app.py) +
# assets/ into a standalone exe.
# Output: sibling folder "Relatum-release\" containing Relatum.exe + _internal\.
# Clean distribution: NO user data is packaged (canvases\ / data\ are created by
# the exe next to itself on first run), so the release is safe to share / upload.
#
#   First run / reinstall deps:  powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1
#   Fast rebuild (reuse venv):   powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1 -SkipInstall
#   Keep PyInstaller temp files: powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1 -KeepBuildArtifacts
#   Replace a local test release containing user data only after backup:
#                              powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1 -ForceReplaceUserData
#
# NOTE: keep this script ASCII-only. Windows PowerShell 5.1 reads scripts using
# the system ANSI codepage, so non-ASCII text without a BOM becomes mojibake and
# breaks parsing.
# ----------------------------------------------------------------------------
param(
    [switch]$SkipInstall,
    [switch]$KeepBuildArtifacts,
    [switch]$ForceReplaceUserData
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExeName = 'Relatum'
$ReleaseLeaf = $ExeName + '-release'
$ReleaseParent = Split-Path $ProjectRoot -Parent
$Release = Join-Path $ReleaseParent $ReleaseLeaf

function Assert-NativeSuccess([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw ($Step + ' failed (exit ' + $LASTEXITCODE + ').') }
}

function Test-CompatiblePython([string]$Exe, [object[]]$Prefix) {
    try {
        & $Exe @Prefix -c "import sys; raise SystemExit(0 if (3, 9) <= sys.version_info[:2] <= (3, 12) else 1)" *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-PipUsable([string]$Exe) {
    try {
        & $Exe -m pip --version *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Remove-TreeInside([string]$Target, [string]$Parent) {
    if (-not (Test-Path -LiteralPath $Target)) { return }
    $fullTarget = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if (-not $fullTarget.StartsWith($fullParent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ('Refusing to remove path outside expected parent: ' + $fullTarget)
    }
    Remove-Item -LiteralPath $fullTarget -Recurse -Force
}

# -- 1. Build Python environment (pywebview needs Python <=3.12 for pythonnet) --
$BuildParent = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$Venv = Join-Path $BuildParent 'canvas-desktop-build-venv'
$Python = Join-Path $Venv 'Scripts\python.exe'

if ((Test-Path -LiteralPath $Python) -and -not (Test-CompatiblePython -Exe $Python -Prefix @())) {
    Remove-TreeInside $Venv $BuildParent
}

if ((Test-Path -LiteralPath $Python) -and -not (Test-PipUsable -Exe $Python)) {
    Write-Host 'Build venv has a broken pip; recreating it...'
    Remove-TreeInside $Venv $BuildParent
}

if (-not (Test-Path -LiteralPath $Python)) {
    # Pick a supported base interpreter able to create the venv.
    $BundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    $candidates = @(
        @($BundledPython, @()),
        @('py', @('-3.12')),
        @('py', @('-3.11')),
        @('python', @())
    )

    $created = $false
    foreach ($c in $candidates) {
        $exe = $c[0]; $pre = $c[1]
        if (($exe -notlike '*\*') -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        if (-not (Test-CompatiblePython -Exe $exe -Prefix $pre)) { continue }
        Remove-TreeInside $Venv $BuildParent
        & $exe @pre -m venv $Venv
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $Python) -and
            (Test-CompatiblePython -Exe $Python -Prefix @())) {
            $created = $true
            break
        }
    }
    if (-not $created) { throw 'Could not create build venv (need Python <=3.12 for pywebview).' }
}

if (-not $SkipInstall) {
    & $Python -m pip install --disable-pip-version-check --no-cache-dir --quiet `
        'pywebview==6.2.1' 'pyinstaller==6.20.0' 'Pillow>=11.0,<13'
    Assert-NativeSuccess 'Installing build dependencies'
}

# -- 2. Application icon -------------------------------------------------------
$PreferredIcon = Join-Path $ProjectRoot 'Relatum.ico'
$IconScript = Join-Path $ProjectRoot 'packaging\make_icon.py'
$IconSource = Join-Path $ProjectRoot 'packaging\icon-source.png'
$Icon = Join-Path $ProjectRoot 'assets\app-icon.ico'
if (Test-Path -LiteralPath $PreferredIcon) {
    $Icon = $PreferredIcon
    Write-Host ('Using preferred application icon: ' + $Icon)
} elseif (Test-Path -LiteralPath $Icon) {
    Write-Host ('Using existing application icon: ' + $Icon)
} elseif ((Test-Path -LiteralPath $IconSource) -and (Test-Path -LiteralPath $IconScript)) {
    & $Python $IconScript
    Assert-NativeSuccess 'Generating application icon'
} else {
    throw 'Application icon missing and packaging\icon-source.png not found.'
}

# -- 3. Stage assets in TEMP; drop the build-only font backup (source untouched) -
$BuildRoot = Join-Path $BuildParent 'canvas-desktop-build'
Remove-TreeInside $BuildRoot $BuildParent
New-Item -ItemType Directory -Path $BuildRoot | Out-Null

$PackAssets = Join-Path $BuildRoot 'assets'
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'assets') -Destination $PackAssets -Recurse -Force
$FontTtf = Join-Path $PackAssets 'fonts\kose-font.ttf'
if (Test-Path -LiteralPath $FontTtf) { Remove-Item -LiteralPath $FontTtf -Force }  # CSS uses woff2
$RuntimeConfig = Join-Path $ProjectRoot 'packaging\Relatum.exe.config'
if (-not (Test-Path -LiteralPath $RuntimeConfig)) {
    throw ('Runtime config missing: ' + $RuntimeConfig)
}

# -- 4. PyInstaller (onedir; only the Windows pywebview platform code) ----------
& $Python -m PyInstaller `
    --noconfirm --clean --windowed --onedir `
    --name $ExeName `
    --icon $Icon `
    --add-data ($PackAssets + ';assets') `
    --hidden-import webview.platforms.winforms `
    --hidden-import webview.platforms.edgechromium `
    --specpath $BuildRoot `
    --workpath (Join-Path $BuildRoot 'work') `
    --distpath (Join-Path $BuildRoot 'dist') `
    (Join-Path $ProjectRoot 'desktop.py')
Assert-NativeSuccess 'Building desktop client'

$BuiltDir = Join-Path (Join-Path $BuildRoot 'dist') $ExeName
if (-not (Test-Path -LiteralPath $BuiltDir)) { throw ('Build output missing: ' + $BuiltDir) }

# -- 5. Replace the release folder. Refuse to erase local user data by accident. --
$ReleaseCanvases = Join-Path $Release 'canvases'
$ReleaseData = Join-Path $Release 'data'
if (((Test-Path -LiteralPath $ReleaseCanvases) -or (Test-Path -LiteralPath $ReleaseData)) -and
    -not $ForceReplaceUserData) {
    throw ('Release folder contains user data. Back it up or move it first; use -ForceReplaceUserData only intentionally: ' + $Release)
}
Remove-TreeInside $Release $ReleaseParent
Move-Item -LiteralPath $BuiltDir -Destination $Release
Copy-Item -LiteralPath $RuntimeConfig -Destination (Join-Path $Release ($ExeName + '.exe.config'))

# -- 6. Validate the clean distributable and remove temporary PyInstaller files. --
$ReleaseExe = Join-Path $Release ($ExeName + '.exe')
$ReleaseConfig = Join-Path $Release ($ExeName + '.exe.config')
$ReleaseInternal = Join-Path $Release '_internal'
$ReleaseAssets = Join-Path $ReleaseInternal 'assets'
$ReleaseTtf = Join-Path $ReleaseAssets 'fonts\kose-font.ttf'
if (-not (Test-Path -LiteralPath $ReleaseExe)) { throw ('Release exe missing: ' + $ReleaseExe) }
if (-not (Test-Path -LiteralPath $ReleaseConfig)) { throw ('Runtime config missing from release: ' + $ReleaseConfig) }
if (-not (Test-Path -LiteralPath $ReleaseAssets)) { throw ('Release assets missing: ' + $ReleaseAssets) }
if (Test-Path -LiteralPath $ReleaseTtf) { throw ('Build-only TTF leaked into release: ' + $ReleaseTtf) }
if ((Test-Path -LiteralPath $ReleaseCanvases) -or (Test-Path -LiteralPath $ReleaseData)) {
    throw ('User data leaked into release: ' + $Release)
}
if (-not $KeepBuildArtifacts) { Remove-TreeInside $BuildRoot $BuildParent }

Write-Host ''
Write-Host ('Build complete: ' + $Release)
Write-Host ('Double-click ' + $ExeName + '.exe to launch. Keep ' + $ExeName + '.exe.config beside it when sharing.')
Write-Host 'Zip the whole release folder to share (no Python needed on the target machine).'
Write-Host 'Contains no canvas/preference data - safe to share or upload.'
