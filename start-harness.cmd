@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-harness.ps1"
if errorlevel 1 (
  echo.
  echo AI Harness could not be started.
  pause
)
