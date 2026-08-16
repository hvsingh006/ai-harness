@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AI-Harness.ps1"
if errorlevel 1 (
  echo.
  echo AI Harness installation stopped with an error.
  echo Send ChatGPT a screenshot of this window.
  echo.
  pause
)
