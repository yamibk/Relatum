# Offline desktop build entry. ASCII; compatible with Windows PowerShell 5.1.
# Prepare once: powershell -ExecutionPolicy Bypass -File .\prepare-desktop.ps1
param(
    [switch]$SkipInstall,
    [switch]$KeepBuildArtifacts,
    [switch]$ForceReplaceUserData,
    [string]$OutputDirectory = '',
    [string]$BuildHome = '',
    [switch]$CheckOnly
)
. (Join-Path $PSScriptRoot 'scripts\desktop-build-common.ps1')
$session = $null
try {
    $homePath = Get-DesktopBuildHome $BuildHome
    $session = Enter-DesktopBuild $homePath 'build'
    $python = Get-PreparedDesktopPython $homePath
    $mode = 'build'
    if ($CheckOnly) { $mode = 'check' }
    $arguments = @('-I', '-B', '-X', 'utf8', '-u', (Join-Path $PSScriptRoot 'scripts\desktop_build.py'), $mode, '--home', $homePath)
    if ($OutputDirectory) { $arguments += @('--output', [IO.Path]::GetFullPath($OutputDirectory)) }
    if ($KeepBuildArtifacts) { $arguments += '--keep-build-artifacts' }
    if ($ForceReplaceUserData) { $arguments += '--force-replace-user-data' }
    # -SkipInstall remains accepted; every daily build is now offline.
    & $python @arguments
    if ($LASTEXITCODE -ne 0) { throw ('Desktop build failed (exit ' + $LASTEXITCODE + ').') }
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally { Exit-DesktopBuild $session }
