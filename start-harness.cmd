@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo AI Harness needs Node.js 22.5 or newer.
  echo Install the current Node.js LTS release, then run this file again.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)
start "" http://127.0.0.1:4317/
echo Starting AI Harness. Keep this window open while testing.
echo Press Ctrl+C to stop it.
echo.
node src\server.mjs
pause
