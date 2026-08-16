$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/hvsingh006/ai-harness.git'
$RepoSlug = 'hvsingh006/ai-harness'
$Documents = [Environment]::GetFolderPath('MyDocuments')
$DevRoot = if ($env:AI_HARNESS_DEV_ROOT) { $env:AI_HARNESS_DEV_ROOT } else { Join-Path $Documents 'AI Workspace\Projects' }
$RepoDir = if ($env:AI_HARNESS_REPO_ROOT) { $env:AI_HARNESS_REPO_ROOT } else { Join-Path $DevRoot 'ai-harness' }
$PrivateRoot = if ($env:HARNESS_WORKSPACE_ROOT) { $env:HARNESS_WORKSPACE_ROOT } else { Join-Path $Documents 'AI Harness' }
$LegacyRepo = Join-Path $env:LOCALAPPDATA 'AI-Harness\app'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Require($name) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required." } }
function Full($p) { [IO.Path]::GetFullPath($p).TrimEnd('\') }
function Within($child, $parent) {
  $c = Full $child; $p = Full $parent
  return $c.Equals($p, [StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase)
}

Require git
Require gh
Require node
if ((Within $PrivateRoot $DevRoot) -or (Within $DevRoot $PrivateRoot)) {
  throw 'AI Workspace and private AI Harness data must be separate directory trees.'
}

try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
  if ($health.pid) { Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700 }
} catch {}

Step 'Preparing separated workspace roots'
New-Item -ItemType Directory -Force -Path $DevRoot, $PrivateRoot | Out-Null
[Environment]::SetEnvironmentVariable('AI_HARNESS_DEV_ROOT', (Full $DevRoot), 'User')
[Environment]::SetEnvironmentVariable('AI_HARNESS_REPO_ROOT', (Full $RepoDir), 'User')
[Environment]::SetEnvironmentVariable('HARNESS_WORKSPACE_ROOT', (Full $PrivateRoot), 'User')
$env:AI_HARNESS_DEV_ROOT = Full $DevRoot
$env:AI_HARNESS_REPO_ROOT = Full $RepoDir
$env:HARNESS_WORKSPACE_ROOT = Full $PrivateRoot

Step 'Preparing canonical AI Harness repository'
if (Test-Path (Join-Path $RepoDir '.git')) {
  $dirty = @(git -C $RepoDir status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the canonical repository.' }
  if ($dirty.Count -gt 0) { throw "Canonical repository has local changes. Resolve them before migration/update: $RepoDir" }
  git -C $RepoDir checkout main
  if ($LASTEXITCODE -ne 0) { throw 'Could not switch canonical repository to main.' }
  git -C $RepoDir fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch origin/main.' }
  git -C $RepoDir merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fast-forward canonical repository.' }
} else {
  if (Test-Path $RepoDir) {
    $items = Get-ChildItem -Force $RepoDir -ErrorAction SilentlyContinue
    if ($items) { throw "Target repository directory exists but is not a Git checkout: $RepoDir" }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir -Parent) | Out-Null

  $usedLocalClone = $false
  if (Test-Path (Join-Path $LegacyRepo '.git')) {
    $legacyDirty = @(git -C $LegacyRepo status --porcelain)
    if ($LASTEXITCODE -eq 0 -and $legacyDirty.Count -eq 0) {
      Write-Host "Cloning clean legacy checkout locally from $LegacyRepo"
      git clone $LegacyRepo $RepoDir
      if ($LASTEXITCODE -eq 0) {
        git -C $RepoDir remote set-url origin $RepoUrl
        $usedLocalClone = $true
      }
    }
  }
  if (-not $usedLocalClone) {
    gh repo clone $RepoSlug $RepoDir
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone the private AI Harness repository.' }
  }
  git -C $RepoDir fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch current main.' }
  git -C $RepoDir checkout main
  if ($LASTEXITCODE -ne 0) { throw 'Could not switch to main.' }
  git -C $RepoDir merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fast-forward to current main.' }
}

Step 'Installing dependencies and validating canonical checkout'
Push-Location $RepoDir
try {
  if (Test-Path 'package-lock.json') { npm ci --no-audit --no-fund } else { npm install --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw 'npm dependency setup failed.' }
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'AI Harness tests failed.' }
  npm run doctor
  if ($LASTEXITCODE -ne 0) { throw 'AI Harness diagnostics failed.' }
  npm run dev:status
  if ($LASTEXITCODE -ne 0) { throw 'Development workspace status failed.' }
} finally { Pop-Location }

Step 'Updating Desktop and Start Menu shortcuts'
$wsh = New-Object -ComObject WScript.Shell
function Shortcut($path, $target, $working, $description) {
  $s = $wsh.CreateShortcut($path); $s.TargetPath = $target; $s.WorkingDirectory = $working; $s.Description = $description; $s.Save()
}
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AI Harness'
New-Item -ItemType Directory -Force -Path $StartDir | Out-Null
foreach ($base in @($Desktop, $StartDir)) {
  Shortcut (Join-Path $base 'AI Harness.lnk') (Join-Path $RepoDir 'update-and-launch-harness.cmd') $RepoDir 'Update if safe, then launch AI Harness'
  Shortcut (Join-Path $base 'AI Harness - Codex.lnk') (Join-Path $RepoDir 'open-codex.cmd') $RepoDir 'Open the canonical AI Harness repository in Codex CLI'
  Shortcut (Join-Path $base 'AI Harness - Antigravity.lnk') (Join-Path $RepoDir 'open-antigravity.cmd') $RepoDir 'Open the canonical AI Harness repository in Antigravity CLI'
  Shortcut (Join-Path $base 'AI Workspace.lnk') $DevRoot $DevRoot 'Open the AI development workspace'
}

Step 'Launching canonical AI Harness checkout'
Start-Process -FilePath (Join-Path $RepoDir 'start-harness.cmd') -WorkingDirectory $RepoDir
Write-Host "`nAI Workspace migration complete." -ForegroundColor Green
Write-Host "Canonical repository: $RepoDir"
Write-Host "Private Harness data: $PrivateRoot"
if ((Full $LegacyRepo) -ne (Full $RepoDir) -and (Test-Path $LegacyRepo)) {
  Write-Host "Legacy checkout remains at $LegacyRepo as a temporary fallback. After verifying the new shortcut works, it can be removed." -ForegroundColor Yellow
}
