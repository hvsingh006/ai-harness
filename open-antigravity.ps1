$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $PSScriptRoot).Path
if (-not (Test-Path (Join-Path $Repo '.git'))) { throw "AI Harness repository not found at $Repo" }

if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
  Write-Host 'Antigravity CLI (agy) is not installed or not on PATH.' -ForegroundColor Yellow
  Write-Host 'Windows install command:'
  Write-Host '  irm https://antigravity.google/cli/install.ps1 | iex'
  Write-Host 'Then run this shortcut again.'
  Read-Host 'Press Enter to close'
  exit 1
}

$escaped = $Repo.Replace("'", "''")
$command = "Set-Location -LiteralPath '$escaped'; agy"
Start-Process powershell.exe -WorkingDirectory $Repo -ArgumentList @('-NoExit', '-NoProfile', '-Command', $command)
