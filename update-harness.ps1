$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Git is required for one-click source updates.' -ForegroundColor Red
  Write-Host 'Install Git for Windows, or update the application from a downloaded release.'
  exit 1
}
if (-not (Test-Path '.git')) {
  Write-Host 'This copy is not a Git checkout, so it cannot pull updates.' -ForegroundColor Yellow
  Write-Host 'Your project data is already external and safe. Clone the repository once, then use this updater.'
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'AI Harness needs Node.js 22.5 or newer.' -ForegroundColor Red
  exit 1
}

Write-Host 'Backing up Harness metadata before update...'
node .\scripts\backup.mjs

Write-Host 'Pulling application changes...'
git pull --ff-only

Write-Host 'Running installation checks...'
node .\scripts\doctor.mjs

Write-Host ''
Write-Host 'AI Harness application updated. Your Project folders and archive were not replaced by git pull.' -ForegroundColor Green
