$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host 'AI Harness Update & Launch' -ForegroundColor White

# Stop only the local Harness process reported by its own health endpoint.
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
  if ($health.pid) {
    Write-Host "Stopping running AI Harness process $($health.pid)..."
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 2 | Out-Null } catch {}
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      if (-not (Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue) { Stop-Process -Id ([int]$health.pid) -Force -ErrorAction Stop }
  }
} catch {}

$updateSucceeded = $true
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'update-harness.ps1')
  if ($LASTEXITCODE -ne 0) { $updateSucceeded = $false }
} catch {
  $updateSucceeded = $false
}

if (-not $updateSucceeded) {
  Write-Host ''
  Write-Host 'Update was unavailable or failed. Launching the currently installed working version instead.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Launching AI Harness...'
Start-Process -FilePath (Join-Path $PSScriptRoot 'start-harness.cmd')

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
    if ($health.ok) { $healthy = $true; break }
  } catch {}
}
if (-not $healthy) { throw 'AI Harness did not become healthy after restart.' }
Write-Host 'AI Harness is healthy after restart.' -ForegroundColor Green
