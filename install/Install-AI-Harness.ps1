$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/hvsingh006/ai-harness.git'
$BaseDir = Join-Path $env:LOCALAPPDATA 'AI-Harness'
$AppDir = Join-Path $BaseDir 'app'
$WorkspaceRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AI Harness'
$ExtensionDir = Join-Path $AppDir 'extension'

function Write-Step($text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

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

function Ensure-Package($Command, $PackageId, $DisplayName) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        Write-Host "$DisplayName already installed." -ForegroundColor Green
        return
    }

    Write-Step "Installing $DisplayName"
    Ensure-Winget
    winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "$DisplayName installation failed."
    }

    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$DisplayName was installed but is not available yet. Restart Windows and run this installer again."
    }
}

function Test-GitHubAuth {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        & gh auth status --hostname github.com *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }
}

Write-Host ""
Write-Host "AI Harness Bootstrap Installer 0.6.1" -ForegroundColor White
Write-Host "Application updates and your permanent workspace remain physically separate." -ForegroundColor DarkGray

Ensure-Package 'git' 'Git.Git' 'Git'
Ensure-Package 'gh' 'GitHub.cli' 'GitHub CLI'
Ensure-Package 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS'

$nodeVersionText = (node --version).Trim().TrimStart('v')
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'22.5.0') {
    Write-Step "Upgrading Node.js to a supported version"
    Ensure-Winget
    winget upgrade --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Node.js upgrade failed."
    }
    Refresh-Path

    $nodeVersionText = (node --version).Trim().TrimStart('v')
    $nodeVersion = [version]$nodeVersionText
    if ($nodeVersion -lt [version]'22.5.0') {
        throw "Node.js 22.5+ is required. Current version is $nodeVersionText."
    }
}

Write-Step "Signing in to GitHub if needed"
if (-not (Test-GitHubAuth)) {
    Write-Host "GitHub sign-in is required once because ai-harness is private." -ForegroundColor Yellow
    Write-Host "Your browser will open. Complete the GitHub authorization, then return to this window."
    Write-Host ""

    & gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub sign-in failed or was cancelled."
    }

    if (-not (Test-GitHubAuth)) {
        throw "GitHub still reports that you are not authenticated after login."
    }
}

& gh auth setup-git
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI could not configure Git authentication."
}
Write-Host "GitHub authentication ready." -ForegroundColor Green

Write-Step "Preparing permanent workspace"
New-Item -ItemType Directory -Force -Path $WorkspaceRoot | Out-Null
foreach ($name in @('Projects','Library','Archive','Backups')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot $name) | Out-Null
}

[Environment]::SetEnvironmentVariable('HARNESS_WORKSPACE_ROOT', $WorkspaceRoot, 'User')
$env:HARNESS_WORKSPACE_ROOT = $WorkspaceRoot

$workspaceFull = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
$appFull = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
if ($workspaceFull.StartsWith($appFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe storage configuration: workspace cannot be inside the application checkout."
}

Write-Step "Installing or updating AI Harness"
New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null

if (Test-Path (Join-Path $AppDir '.git')) {
    git -C $AppDir fetch origin main
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch the AI Harness repository." }

    git -C $AppDir checkout main
    if ($LASTEXITCODE -ne 0) { throw "Could not switch AI Harness to main." }

    git -C $AppDir pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw "Could not update AI Harness cleanly." }
}
elseif (Test-Path $AppDir) {
    $existing = Get-ChildItem -Force $AppDir -ErrorAction SilentlyContinue
    if ($existing) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupDir = "$AppDir-preinstall-$stamp"
        Write-Host "Existing non-Git app folder found. Moving it to: $backupDir" -ForegroundColor Yellow
        Move-Item $AppDir $backupDir
    }

    git clone $RepoUrl $AppDir
    if ($LASTEXITCODE -ne 0) { throw "Could not clone the private AI Harness repository." }
}
else {
    git clone $RepoUrl $AppDir
    if ($LASTEXITCODE -ne 0) { throw "Could not clone the private AI Harness repository." }
}

Write-Step "Preparing application dependencies"
Push-Location $AppDir
try {
    if (Test-Path 'package-lock.json') {
        npm ci --no-audit --no-fund
    } else {
        npm install --no-audit --no-fund
    }

    if ($LASTEXITCODE -ne 0) {
        throw "npm dependency setup failed."
    }

    Write-Step "Running AI Harness diagnostics"
    npm run doctor
    if ($LASTEXITCODE -ne 0) {
        throw "AI Harness diagnostics failed."
    }
}
finally {
    Pop-Location
}

Write-Step "Creating desktop shortcuts"
$desktop = [Environment]::GetFolderPath('Desktop')
$wsh = New-Object -ComObject WScript.Shell

function New-Shortcut($Path, $Target, $WorkingDirectory, $Description) {
    $shortcut = $wsh.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.Save()
}

New-Shortcut (Join-Path $desktop 'AI Harness.lnk') (Join-Path $AppDir 'start-harness.cmd') $AppDir 'Start AI Harness'
New-Shortcut (Join-Path $desktop 'Update AI Harness.lnk') (Join-Path $AppDir 'update-harness.cmd') $AppDir 'Backup, update, and validate AI Harness'
New-Shortcut (Join-Path $desktop 'AI Harness Projects.lnk') $WorkspaceRoot $WorkspaceRoot 'Open AI Harness persistent workspace'

Write-Step "Launching AI Harness"
Start-Process -FilePath (Join-Path $AppDir 'start-harness.cmd')
Start-Sleep -Seconds 2

$chromeCandidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$edgeCandidates = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)

$browser = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
    $browser = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if ($browser) {
    Start-Process -FilePath $browser -ArgumentList 'chrome://extensions/'
}

Start-Process explorer.exe -ArgumentList "`"$ExtensionDir`""
try { Set-Clipboard -Value $ExtensionDir } catch {}

Write-Host ""
Write-Host "INSTALL COMPLETE" -ForegroundColor Green
Write-Host ""
Write-Host "Application: $AppDir"
Write-Host "Permanent workspace: $WorkspaceRoot"
Write-Host "Extension folder: $ExtensionDir"
Write-Host ""
Write-Host "One browser security step remains:" -ForegroundColor Yellow
Write-Host "Enable Developer mode, choose 'Load unpacked', and select the extension folder."
Write-Host "The extension folder has been opened and its path copied to your clipboard."
Write-Host ""
Write-Host "After that, refresh ChatGPT/Gemini and look for the bright red Harness ready indicator."
Write-Host ""
Read-Host "Press Enter to close this installer"
