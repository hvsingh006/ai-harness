$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host 'AI Harness Update & Launch' -ForegroundColor White

# Stop only the local Harness process reported by its own health endpoint.
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
  if ($health.pid) {
    Write-Host "Stopping running AI Harness process $($health.pid)..."
    Stop-Process -Id ([int]$health.pid) -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 600
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
