param(
    [string]$Root = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
    [switch]$Physical
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')

if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw ('Repository root does not exist: ' + $Root)
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $Physical -and $git -and (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    $files = @(& $git.Source -c core.quotePath=false -C $Root ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed.' }
    $scanMode = 'Git candidates'
} else {
    $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
    } | Where-Object { $_ -notmatch '^\.git/' })
    $scanMode = 'physical files'
}

$findings = [Collections.Generic.List[string]]::new()
$textExtensions = @(
    '.bat', '.css', '.html', '.ini', '.js', '.json', '.md', '.ps1', '.py',
    '.toml', '.txt', '.xml', '.yaml', '.yml'
)
$textNames = @('.env', '.gitignore', '.gitattributes')
$selfPath = 'scripts/check-public.ps1'
$maxBytes = 95MB

foreach ($entry in $files) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    $relative = $entry.Replace('\', '/')
    if ($relative.StartsWith('./', [StringComparison]::Ordinal)) {
        $relative = $relative.Substring(2)
    }
    $full = Join-Path $Root ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }

    if ($relative -match '^(data|canvases|notes)/' -or
        $relative -match '(^|/)\.assets/' -or
        $relative -match '(^|/)__pycache__/' -or
        $relative -match '(^|/)\.claude/settings\.local\.json$' -or
        $relative -match '(^|/)\.env(?:\..+)?$' -or
        $relative -match '\.(canvas|pyc|pyo)$') {
        $findings.Add('Forbidden user/cache file: ' + $relative)
    }

    if ($relative -match '(^|/)(TODO\.md|和codex的对话\.txt|画布项目交接信息\.md|美化优化方案\.md)$') {
        $findings.Add('Internal history file: ' + $relative)
    }

    $item = Get-Item -LiteralPath $full
    if ($item.Length -gt $maxBytes) {
        $findings.Add(('File exceeds 95 MiB: {0} ({1:N1} MiB)' -f $relative, ($item.Length / 1MB)))
    }

    if ($relative -eq $selfPath -or $relative -match '^assets/vendor/') { continue }
    if (($textExtensions -notcontains $item.Extension.ToLowerInvariant()) -and
        ($textNames -notcontains $item.Name.ToLowerInvariant())) { continue }

    try {
        $content = [IO.File]::ReadAllText($full, [Text.Encoding]::UTF8)
    } catch {
        $findings.Add('Could not scan text file: ' + $relative)
        continue
    }

    if ($content -match '(?i)((?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})') {
        $findings.Add('Possible credential: ' + $relative)
    }
    if ($content -match '(?i)[A-Z]:[\\/]Users[\\/][^\\/\r\n]+[\\/]') {
        $findings.Add('Personal absolute path: ' + $relative)
    }
    if ($content -match '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----') {
        $findings.Add('Private key material: ' + $relative)
    }
}

if ($findings.Count -gt 0) {
    Write-Host ''
    Write-Host 'Public repository safety check failed:' -ForegroundColor Red
    $findings | Sort-Object -Unique | ForEach-Object { Write-Host ('  - ' + $_) }
    exit 1
}

Write-Host ('Public repository safety check passed. Mode: {0}; files checked: {1}' -f $scanMode, $files.Count) -ForegroundColor Green
