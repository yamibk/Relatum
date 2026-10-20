# Shared bootstrap only. Keep ASCII for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$DesktopProjectRoot = Split-Path -Parent $PSScriptRoot

function Get-DesktopFileHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Save-DesktopDownload([string]$Uri, [string]$Destination) {
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 60000
    $request.UserAgent = 'Relatum-build-setup'
    if ($env:HTTPS_PROXY) { $request.Proxy = [Net.WebProxy]::new($env:HTTPS_PROXY) }
    $response = $null; $inputStream = $null; $outputStream = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $request.GetResponse()
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Create($Destination)
        $buffer = New-Object byte[] 65536
        $total = 0; $reported = 0
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $outputStream.Write($buffer, 0, $read); $total += $read
            if ($total - $reported -ge 2MB) { Write-Host ('Downloaded {0:N1} MiB...' -f ($total / 1MB)); $reported = $total }
            if ($watch.Elapsed.TotalSeconds -gt 180) { throw 'Python download exceeded 180s.' }
        }
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Get-DesktopBuildHome([string]$Override = '') {
    if (-not $Override) { $Override = $env:RELATUM_BUILD_HOME }
    if (-not $Override) { $Override = Join-Path $env:LOCALAPPDATA 'RelatumBuild' }
    return [IO.Path]::GetFullPath($Override)
}

function Get-DesktopBuildLock {
    $path = Join-Path $DesktopProjectRoot 'packaging\desktop-build-lock.json'
    $data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $fingerprint = Get-DesktopFileHash $path
    return @{ Data = $data; Fingerprint = $fingerprint; Path = $path }
}

function Enter-DesktopBuild([string]$BuildRootHome, [string]$Mode) {
    New-Item -ItemType Directory -Path $BuildRootHome -Force | Out-Null
    $lockPath = Join-Path $BuildRootHome 'build.lock'
    try { $handle = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw ('Another build or environment preparation is active: ' + $lockPath) }
    try {
        $logs = Join-Path $BuildRootHome 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $log = Join-Path $logs ($Mode + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.log')
        $previousEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        Start-Transcript -LiteralPath $log | Out-Null
        Write-Host ('Log: ' + $log)
        return @{ Handle = $handle; Log = $log; Started = Get-Date; Encoding = $previousEncoding }
    } catch { $handle.Dispose(); throw }
}

function Exit-DesktopBuild($Session) {
    if ($Session) {
        Write-Host ('Elapsed: {0:N1}s. Log: {1}' -f ((Get-Date) - $Session.Started).TotalSeconds, $Session.Log)
        try { Stop-Transcript | Out-Null } finally { $Session.Handle.Dispose(); [Console]::OutputEncoding = $Session.Encoding }
    }
}

function Get-PreparedDesktopPython([string]$BuildRootHome) {
    $lock = Get-DesktopBuildLock
    $pointer = Join-Path $BuildRootHome ('active-' + $lock.Fingerprint + '.json')
    if (-not (Test-Path -LiteralPath $pointer)) {
        throw 'Build environment is not prepared for this lock. Run prepare-desktop.ps1 (or the preparation BAT) first. Daily builds never install or download dependencies.'
    }
    $active = Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json
    if ($active.fingerprint -ne $lock.Fingerprint -or $active.environment -notmatch '^envs/[a-zA-Z0-9-]+$') {
        throw 'Invalid build environment record. Run prepare-desktop.ps1 to repair it.'
    }
    $python = Join-Path (Join-Path $BuildRootHome $active.environment) 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw ('Prepared Python is missing. Run prepare-desktop.ps1: ' + $python) }
    return $python
}

function Get-DesktopRuntime([string]$BuildRootHome, [switch]$Offline) {
    $lock = Get-DesktopBuildLock
    $runtime = $lock.Data.runtime
    $root = Join-Path $BuildRootHome ('runtimes\' + $runtime.id)
    $python = Join-Path $root 'python\python.exe'
    if ((Test-Path -LiteralPath $python) -and (Test-Path -LiteralPath (Join-Path $root '.verified')) -and
        ([IO.File]::ReadAllText((Join-Path $root '.verified')) -eq $runtime.sha256)) {
        try {
            & $python -I -B -X utf8 (Join-Path $DesktopProjectRoot 'scripts\desktop_build.py') runtime-check | Out-Host
            if ($LASTEXITCODE -eq 0) { return $python }
        } catch { Write-Host 'The fixed runtime is damaged; restoring to a new directory.' }
    }
    $cache = Join-Path $BuildRootHome 'cache'
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $archive = Join-Path $cache $runtime.filename
    $valid = (Test-Path -LiteralPath $archive) -and ((Get-DesktopFileHash $archive) -eq $runtime.sha256)
    if (-not $valid) {
        if ($Offline) { throw ('Verified Python archive missing from offline cache: ' + $archive) }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $part = $archive + '.' + [guid]::NewGuid().ToString('N') + '.part'
        try {
            for ($attempt = 1; $attempt -le 2; $attempt++) {
                try {
                    Write-Host ('Downloading fixed Python runtime (attempt {0}/2, timeout 180s)...' -f $attempt)
                    Save-DesktopDownload $runtime.url $part
                    if ((Get-DesktopFileHash $part) -ne $runtime.sha256) { throw 'Python archive SHA-256 mismatch.' }
                    Move-Item -LiteralPath $part -Destination $archive -Force
                    break
                } catch {
                    if ($attempt -eq 2) { throw }
                    Write-Host ('Download failed: ' + $_.Exception.Message)
                }
            }
        } finally { if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force } }
    }
    # Never overwrite a runtime that an existing prepared venv may still use.
    if (Test-Path -LiteralPath $root) { $root += '-' + [guid]::NewGuid().ToString('N') }
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { throw 'Windows tar.exe is required to extract the fixed Python archive.' }
    Write-Host 'Extracting the verified Python runtime...'
    & $tar -xzf $archive -C $root | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Extracting Python failed.' }
    $python = Join-Path $root 'python\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Python archive does not contain python/python.exe.' }
    & $python -I -B -X utf8 (Join-Path $DesktopProjectRoot 'scripts\desktop_build.py') runtime-check | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Fixed Python runtime cannot start.' }
    [IO.File]::WriteAllText((Join-Path $root '.verified'), $runtime.sha256)
    return $python
}
