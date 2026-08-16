$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'AI Harness needs Node.js 22.5 or newer.' -ForegroundColor Red
  Write-Host 'Install the current Node.js LTS release from https://nodejs.org/ and run this script again.'
  exit 1
}
Start-Process 'http://127.0.0.1:4317/'
Write-Host 'Starting AI Harness. Keep this window open while testing.'
node .\src\server.mjs
