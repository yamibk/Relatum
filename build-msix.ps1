# Relatum Microsoft Store package builder (x64 MSIX)
# -----------------------------------------------------------------------------
# Builds the existing PyInstaller onedir application, stages an AppxManifest,
# creates the required visual assets, and emits both .msix and .msixupload.
# The Store accepts the unsigned upload and signs the certified package.
#
#   powershell -ExecutionPolicy Bypass -File .\build-msix.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-msix.ps1 -SkipInstall
#   powershell -ExecutionPolicy Bypass -File .\build-msix.ps1 -Version 12.4.1.0
#
# Requires MakeAppx.exe from the Windows 10/11 SDK.
# NOTE: keep this script ASCII-only for Windows PowerShell 5.1 compatibility.
# -----------------------------------------------------------------------------
param(
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')]
    [string]$Version = '12.4.0.0',
    [switch]$SkipInstall,
    [switch]$SkipDesktopBuild,
    [switch]$KeepBuildArtifacts
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReleaseParent = Split-Path $ProjectRoot -Parent
$PortableRelease = Join-Path $ReleaseParent 'Relatum-release'
$OutputRoot = Join-Path $ReleaseParent 'Relatum-store'
$BuildParent = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$StageRoot = Join-Path $BuildParent 'relatum-msix-stage'
$ManifestTemplate = Join-Path $ProjectRoot 'packaging\AppxManifest.xml.in'
$AssetScript = Join-Path $ProjectRoot 'packaging\make_msix_assets.py'
$BuildPython = Join-Path (Join-Path $BuildParent 'canvas-desktop-build-venv') 'Scripts\python.exe'

function Assert-NativeSuccess([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw ($Step + ' failed (exit ' + $LASTEXITCODE + ').') }
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

function Find-WindowsSdkTool([string]$Leaf) {
    $command = Get-Command $Leaf -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $installedRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue).KitsRoot10
    $roots = @(
        $(if ($installedRoot) { Join-Path $installedRoot 'bin' }),
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
    ) | Where-Object { $_ } | Select-Object -Unique
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $candidates = Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name -Descending
        foreach ($candidate in $candidates) {
            $tool = Join-Path $candidate.FullName ('x64\' + $Leaf)
            if (Test-Path -LiteralPath $tool) { return $tool }
        }
    }
    return $null
}

$versionParts = $Version.Split('.')
foreach ($part in $versionParts) {
    if ([int]$part -gt 65535) { throw ('MSIX version component exceeds 65535: ' + $Version) }
}

if (-not $SkipDesktopBuild) {
    $desktopArgs = @()
    if ($SkipInstall) { $desktopArgs += '-SkipInstall' }
    if ($KeepBuildArtifacts) { $desktopArgs += '-KeepBuildArtifacts' }
    & (Join-Path $ProjectRoot 'build-desktop.ps1') @desktopArgs
}

$ReleaseExe = Join-Path $PortableRelease 'Relatum.exe'
if (-not (Test-Path -LiteralPath $ReleaseExe)) {
    throw ('Portable build output is missing: ' + $ReleaseExe)
}
if ((Test-Path -LiteralPath (Join-Path $PortableRelease 'canvases')) -or
    (Test-Path -LiteralPath (Join-Path $PortableRelease 'data'))) {
    throw ('Portable build contains user data and cannot be packaged: ' + $PortableRelease)
}
if (-not (Test-Path -LiteralPath $ManifestTemplate)) {
    throw ('MSIX manifest template is missing: ' + $ManifestTemplate)
}
if (-not (Test-Path -LiteralPath $AssetScript)) {
    throw ('MSIX asset generator is missing: ' + $AssetScript)
}
if (-not (Test-Path -LiteralPath $BuildPython)) {
    throw ('Build Python is missing. Run without -SkipDesktopBuild first: ' + $BuildPython)
}

$MakeAppx = Find-WindowsSdkTool 'MakeAppx.exe'
if (-not $MakeAppx) {
    throw 'MakeAppx.exe was not found. Install the Windows 10/11 SDK, then rerun this script.'
}

Remove-TreeInside $StageRoot $BuildParent
New-Item -ItemType Directory -Path $StageRoot | Out-Null
Copy-Item -Path (Join-Path $PortableRelease '*') -Destination $StageRoot -Recurse -Force

$Manifest = (Get-Content -LiteralPath $ManifestTemplate -Raw).Replace('__VERSION__', $Version)
[System.IO.File]::WriteAllText(
    (Join-Path $StageRoot 'AppxManifest.xml'),
    $Manifest,
    [System.Text.UTF8Encoding]::new($false)
)
& $BuildPython $AssetScript (Join-Path $StageRoot 'Assets')
Assert-NativeSuccess 'Generating MSIX visual assets'

if (-not (Test-Path -LiteralPath $OutputRoot)) {
    New-Item -ItemType Directory -Path $OutputRoot | Out-Null
}
$BaseName = 'Relatum_' + $Version + '_x64'
$MsixPath = Join-Path $OutputRoot ($BaseName + '.msix')
$UploadPath = Join-Path $OutputRoot ($BaseName + '.msixupload')
$UploadZip = Join-Path $OutputRoot ($BaseName + '.zip')
foreach ($target in @($MsixPath, $UploadPath, $UploadZip)) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
}

& $MakeAppx pack /v /h SHA256 /d $StageRoot /p $MsixPath
Assert-NativeSuccess 'Creating MSIX package'

Compress-Archive -LiteralPath $MsixPath -DestinationPath $UploadZip -CompressionLevel Optimal
Move-Item -LiteralPath $UploadZip -Destination $UploadPath

if (-not (Test-Path -LiteralPath $MsixPath)) { throw ('MSIX output missing: ' + $MsixPath) }
if (-not (Test-Path -LiteralPath $UploadPath)) { throw ('MSIX upload output missing: ' + $UploadPath) }
if (-not $KeepBuildArtifacts) { Remove-TreeInside $StageRoot $BuildParent }

Write-Host ''
Write-Host ('MSIX package complete: ' + $MsixPath)
Write-Host ('Partner Center upload: ' + $UploadPath)
Write-Host 'Upload the .msixupload file on the Package page.'
