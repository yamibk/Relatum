# Explicit environment preparation; this is the only build entry allowed online.
param([switch]$Offline, [string]$BuildHome = '')
. (Join-Path $PSScriptRoot 'scripts\desktop-build-common.ps1')
$session = $null
try {
    $homePath = Get-DesktopBuildHome $BuildHome
    $session = Enter-DesktopBuild $homePath 'prepare'
    $python = Get-DesktopRuntime $homePath -Offline:$Offline
    $arguments = @('-I', '-B', '-X', 'utf8', '-u', (Join-Path $PSScriptRoot 'scripts\desktop_build.py'), 'prepare', '--home', $homePath)
    if ($Offline) { $arguments += '--offline' }
    & $python @arguments
    if ($LASTEXITCODE -ne 0) { throw ('Environment preparation failed (exit ' + $LASTEXITCODE + ').') }
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally { Exit-DesktopBuild $session }
