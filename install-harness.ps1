$ErrorActionPreference = 'Stop'

$Repo = 'hvsingh006/ai-harness'
$RepoUrl = 'https://github.com/hvsingh006/ai-harness.git'
$Documents = [Environment]::GetFolderPath('MyDocuments')
$DevRoot = Join-Path $Documents 'AI Workspace\Projects'
$RepoDir = Join-Path $DevRoot 'ai-harness'
$PrivateRoot = Join-Path $Documents 'AI Harness'
$LegacyRepo = Join-Path $env:LOCALAPPDATA 'AI-Harness\app'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}
function Ensure-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Windows Package Manager (winget) is required. Install 'App Installer' from Microsoft Store, then run this installer again."
  }
}
function Find-InstalledTool($Command) {
  $found = Get-Command $Command -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  if ($Command -eq 'pdftotext') {
    $packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    $candidate = Get-ChildItem -LiteralPath $packageRoot -Filter 'pdftotext.exe' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*oschwartz10612.Poppler*' } | Select-Object -First 1
    if ($candidate) {
      [Environment]::SetEnvironmentVariable('AIH_POPPLER_BIN', $candidate.DirectoryName, 'User')
      $env:AIH_POPPLER_BIN = $candidate.DirectoryName
      return $candidate.FullName
    }
  }
  if ($Command -eq 'tesseract') {
    $candidate = Join-Path $env:ProgramFiles 'Tesseract-OCR\tesseract.exe'
    if (Test-Path -LiteralPath $candidate) {
      [Environment]::SetEnvironmentVariable('AIH_TESSERACT_PATH', $candidate, 'User')
      $env:AIH_TESSERACT_PATH = $candidate
      return $candidate
    }
  }
  return $null
}
function Ensure-Package($Command, $PackageId, $DisplayName) {
  if (Find-InstalledTool $Command) { return }
  Write-Step "Installing $DisplayName"
  Ensure-Winget
  winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "$DisplayName installation failed." }
  Refresh-Path
  if (-not (Find-InstalledTool $Command)) { throw "$DisplayName was installed but Harness could not locate it. Restart Windows and run this installer again." }
}
function Test-GitHubAuth {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & gh auth status --hostname github.com *> $null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false } finally { $ErrorActionPreference = $old }
}
function Full($p) { [IO.Path]::GetFullPath($p).TrimEnd('\') }
function Within($child, $parent) {
  $c = Full $child; $p = Full $parent
  return $c.Equals($p, [StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase)
}

Write-Host "`nAI Harness Bootstrap Installer 0.8.0" -ForegroundColor White
Write-Host 'One canonical development repository; private Harness data remains outside the AI coding workspace.' -ForegroundColor DarkGray

Ensure-Package 'git' 'Git.Git' 'Git'
Ensure-Package 'gh' 'GitHub.cli' 'GitHub CLI'
Ensure-Package 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS'
Ensure-Package 'pdftotext' 'oschwartz10612.Poppler' 'Poppler PDF text extractor'
Ensure-Package 'tesseract' 'UB-Mannheim.TesseractOCR' 'Tesseract OCR engine'

$nodeVersionText = (node --version).Trim().TrimStart('v')
if ([version]$nodeVersionText -lt [version]'22.5.0') {
  Write-Step 'Upgrading Node.js'
  Ensure-Winget
  winget upgrade --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Node.js upgrade failed.' }
  Refresh-Path
  $nodeVersionText = (node --version).Trim().TrimStart('v')
  if ([version]$nodeVersionText -lt [version]'22.5.0') { throw "Node.js 22.5+ is required. Current version is $nodeVersionText." }
}

Write-Step 'Signing in to GitHub if needed'
if (-not (Test-GitHubAuth)) {
  & gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0 -or -not (Test-GitHubAuth)) { throw 'GitHub sign-in failed or was cancelled.' }
}
& gh auth setup-git *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI could not configure Git authentication.' }

if ((Within $PrivateRoot $DevRoot) -or (Within $DevRoot $PrivateRoot)) { throw 'AI Workspace and private AI Harness data must be separate directory trees.' }

try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
  if ($health.pid) { Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700 }
} catch {}

Write-Step 'Preparing AI Workspace and private Harness storage'
New-Item -ItemType Directory -Force -Path $DevRoot, $PrivateRoot | Out-Null
foreach ($name in @('Projects','Library','Archive','Backups')) { New-Item -ItemType Directory -Force -Path (Join-Path $PrivateRoot $name) | Out-Null }
[Environment]::SetEnvironmentVariable('AI_HARNESS_DEV_ROOT', (Full $DevRoot), 'User')
[Environment]::SetEnvironmentVariable('AI_HARNESS_REPO_ROOT', (Full $RepoDir), 'User')
[Environment]::SetEnvironmentVariable('HARNESS_WORKSPACE_ROOT', (Full $PrivateRoot), 'User')
$env:AI_HARNESS_DEV_ROOT = Full $DevRoot
$env:AI_HARNESS_REPO_ROOT = Full $RepoDir
$env:HARNESS_WORKSPACE_ROOT = Full $PrivateRoot

Write-Step 'Installing or updating canonical AI Harness repository'
if (Test-Path (Join-Path $RepoDir '.git')) {
  $dirty = @(git -C $RepoDir status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect canonical repository.' }
  if ($dirty.Count -gt 0) { throw "Canonical repository has local changes. The installer will not overwrite them: $RepoDir" }
  git -C $RepoDir checkout main
  if ($LASTEXITCODE -ne 0) { throw 'Could not switch to main.' }
  git -C $RepoDir fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch origin/main.' }
  git -C $RepoDir merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fast-forward main.' }
} else {
  if (Test-Path $RepoDir) {
    $items = Get-ChildItem -Force $RepoDir -ErrorAction SilentlyContinue
    if ($items) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Move-Item $RepoDir "$RepoDir-preinstall-$stamp"
    }
  }

  $localClone = $false
  if (Test-Path (Join-Path $LegacyRepo '.git')) {
    $legacyDirty = @(git -C $LegacyRepo status --porcelain)
    if ($LASTEXITCODE -eq 0 -and $legacyDirty.Count -eq 0) {
      Write-Host "Migrating clean legacy checkout from $LegacyRepo"
      git clone $LegacyRepo $RepoDir
      if ($LASTEXITCODE -eq 0) {
        git -C $RepoDir remote set-url origin $RepoUrl
        $localClone = $true
      }
    } else {
      Write-Host 'Legacy checkout contains local changes; leaving it untouched and cloning GitHub instead.' -ForegroundColor Yellow
    }
  }
  if (-not $localClone) {
    gh repo clone $Repo $RepoDir
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone the private AI Harness repository.' }
  }
  git -C $RepoDir fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch current main.' }
  git -C $RepoDir checkout main
  git -C $RepoDir merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Could not align canonical checkout with origin/main.' }
}

Write-Step 'Installing dependencies and validating'
Push-Location $RepoDir
try {
  npm install --no-package-lock --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm dependency setup failed.' }
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'AI Harness tests failed.' }
  npm run doctor
  if ($LASTEXITCODE -ne 0) { throw 'AI Harness diagnostics failed.' }
  npm run dev:status
  if ($LASTEXITCODE -ne 0) { throw 'Development workspace status failed.' }
} finally { Pop-Location }

Write-Step 'Creating Desktop and Start Menu shortcuts'
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AI Harness'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$wsh = New-Object -ComObject WScript.Shell
function New-Shortcut($Path, $Target, $WorkingDirectory, $Description) {
  $shortcut = $wsh.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = $Description
  $shortcut.Save()
}
foreach ($base in @($desktop, $startMenu)) {
  New-Shortcut (Join-Path $base 'AI Harness.lnk') (Join-Path $RepoDir 'update-and-launch-harness.cmd') $RepoDir 'Update if safe, then launch AI Harness'
  New-Shortcut (Join-Path $base 'AI Harness - Codex.lnk') (Join-Path $RepoDir 'open-codex.cmd') $RepoDir 'Open AI Harness in OpenAI Codex CLI'
  New-Shortcut (Join-Path $base 'AI Harness - Antigravity.lnk') (Join-Path $RepoDir 'open-antigravity.cmd') $RepoDir 'Open AI Harness in Google Antigravity CLI'
  New-Shortcut (Join-Path $base 'AI Workspace.lnk') $DevRoot $DevRoot 'Open the AI development workspace'
  New-Shortcut (Join-Path $base 'AI Harness Private Data.lnk') $PrivateRoot $PrivateRoot 'Open private AI Harness project/archive storage'
}

Write-Step 'Launching AI Harness'
Start-Process -FilePath (Join-Path $RepoDir 'start-harness.cmd') -WorkingDirectory $RepoDir
Start-Sleep -Seconds 2

$extensionDir = Join-Path $RepoDir 'extension'
$chrome = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$edge = @(
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$browser = if ($chrome) { $chrome } else { $edge }
if ($browser) { Start-Process -FilePath $browser -ArgumentList 'chrome://extensions/' }
Start-Process explorer.exe -ArgumentList "`"$extensionDir`""
try { Set-Clipboard -Value $extensionDir } catch {}

Write-Host "`nINSTALL COMPLETE" -ForegroundColor Green
Write-Host "Canonical repository: $RepoDir"
Write-Host "AI project parent:     $DevRoot"
Write-Host "Private Harness data:  $PrivateRoot"
Write-Host "`nThe development agents should normally be opened on the individual repository, not the entire parent workspace."
if (Get-Command codex -ErrorAction SilentlyContinue) { Write-Host 'Codex CLI detected.' -ForegroundColor Green } else { Write-Host 'Codex CLI not detected; the shortcut will show the install command when used.' -ForegroundColor Yellow }
if (Get-Command agy -ErrorAction SilentlyContinue) { Write-Host 'Antigravity CLI detected.' -ForegroundColor Green } else { Write-Host 'Antigravity CLI not detected; the shortcut will show the install command when used.' -ForegroundColor Yellow }
Write-Host "`nBrowser companion: enable Developer mode, Load unpacked, and select the opened extension folder if it is not already loaded."
Read-Host 'Press Enter to close this installer'
