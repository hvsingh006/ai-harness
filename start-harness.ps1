param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path $PSScriptRoot).Path
Set-Location $RepoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'AI Harness needs Node.js 22.5 or newer.' }

$ExpectedSource = $RepoRoot.TrimEnd('\')
try {
  $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
  if ($existing.ok) {
    if (-not ([IO.Path]::GetFullPath([string]$existing.source_root).TrimEnd('\').Equals($ExpectedSource, [StringComparison]::OrdinalIgnoreCase))) {
      throw "Port 4317 is serving a different AI Harness source: $($existing.source_root)"
    }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4317/' }
    Write-Host "AI Harness is already running from $ExpectedSource (PID $($existing.pid))." -ForegroundColor Green
    exit 0
  }
} catch {
  if ($_.Exception.Message -like 'Port 4317 is serving*') { throw }
}

$Documents = [Environment]::GetFolderPath('MyDocuments')
$PrivateRoot = if ($env:HARNESS_WORKSPACE_ROOT) { $env:HARNESS_WORKSPACE_ROOT } else { Join-Path $Documents 'AI Harness' }
$RuntimeRoot = Join-Path $PrivateRoot 'Runtime'
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$OutLog = Join-Path $RuntimeRoot 'service.stdout.log'
$ErrLog = Join-Path $RuntimeRoot 'service.stderr.log'
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('src/server.mjs') -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru

$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 300
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2; if ($health.ok) { break } } catch {}
}
if (-not $health.ok) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
  throw "AI Harness did not become healthy. Inspect $ErrLog"
}
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4317/' }
Write-Host "AI Harness background service started from $ExpectedSource (PID $($health.pid))." -ForegroundColor Green
Write-Host "Logs: $RuntimeRoot"
