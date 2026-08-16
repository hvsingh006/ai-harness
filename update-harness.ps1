$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step($text) {
  Write-Host ""
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Require-Command($name, $message) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw $message
  }
}

function Install-Dependencies {
  if (Test-Path 'package-lock.json') {
    npm ci --no-audit --no-fund
  } else {
    npm install --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}

function Run-Doctor {
  node .\scripts\doctor.mjs
  if ($LASTEXITCODE -ne 0) { throw 'AI Harness diagnostics failed.' }
}

Require-Command 'git' 'Git is required for one-click source updates.'
Require-Command 'node' 'AI Harness needs Node.js 22.5 or newer.'
if (-not (Test-Path '.git')) {
  throw 'This copy is not a Git checkout. Re-run the AI Harness installer once to enable one-click updates.'
}

$branch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
  throw "The installed application must be on the main branch for automatic updates. Current branch: $branch"
}

$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the application checkout.' }
if ($dirty.Count -gt 0) {
  throw 'The application checkout has local source changes. Automatic update stopped rather than overwriting them.'
}

$oldHead = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read the current application revision.' }

Write-Step 'Checking GitHub for a newer AI Harness version'
git fetch --quiet origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not contact GitHub. Your currently installed version was not changed.' }
$remoteHead = (git rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read origin/main after fetching updates.' }

if ($oldHead -eq $remoteHead) {
  Write-Host 'AI Harness is already up to date.' -ForegroundColor Green
  exit 0
}

Write-Step 'Backing up Harness metadata before update'
node .\scripts\backup.mjs
if ($LASTEXITCODE -ne 0) { throw 'Backup failed. Update stopped before changing application code.' }

try {
  Write-Step 'Applying application update'
  git merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Git could not apply the update as a clean fast-forward.' }

  Write-Step 'Preparing dependencies'
  Install-Dependencies

  Write-Step 'Validating updated application'
  Run-Doctor

  $newHead = (git rev-parse HEAD).Trim()
  Write-Host ""
  Write-Host "AI Harness updated successfully." -ForegroundColor Green
  Write-Host "Previous revision: $oldHead"
  Write-Host "Current revision:  $newHead"
  Write-Host 'Your Project folders, archive, and database remain outside the application checkout.'
}
catch {
  $failure = $_.Exception.Message
  Write-Host ""
  Write-Host 'Update validation failed. Rolling application code back to the previous working revision...' -ForegroundColor Yellow
  git reset --hard $oldHead | Out-Host
  try {
    Install-Dependencies
    Run-Doctor
    Write-Host 'Previous application revision restored successfully.' -ForegroundColor Green
  }
  catch {
    Write-Host 'Rollback completed, but the previous revision also failed diagnostics. Use the automatic database backup if recovery is needed.' -ForegroundColor Red
  }
  throw "Update failed and was rolled back. Cause: $failure"
}
