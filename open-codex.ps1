$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $PSScriptRoot).Path
if (-not (Test-Path (Join-Path $Repo '.git'))) { throw "AI Harness repository not found at $Repo" }

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  Write-Host 'Codex CLI is not installed or not on PATH.' -ForegroundColor Yellow
  Write-Host 'Install it with: npm install -g @openai/codex'
  Write-Host 'Then run this shortcut again.'
  Read-Host 'Press Enter to close'
  exit 1
}

$escaped = $Repo.Replace("'", "''")
$command = "Set-Location -LiteralPath '$escaped'; codex"
Start-Process powershell.exe -WorkingDirectory $Repo -ArgumentList @('-NoExit', '-NoProfile', '-Command', $command)
