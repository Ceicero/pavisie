@echo off
REM XAC launcher for Windows. Double-click, or run: start-xac.bat --profile deep
setlocal
cd /d "%~dp0"
title XAC

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo Python 3.9+ is required.
  echo Install it with:  winget install Python.Python.3.12
  echo or from https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^)
  pause
  exit /b 1
)

where ollama >nul 2>nul
if errorlevel 1 (
  echo Ollama ^(the local model runtime XAC uses^) is not installed.
  choice /m "Install it now with winget"
  if errorlevel 2 (
    echo Download it from https://ollama.com/download then run this again.
    pause
    exit /b 1
  )
  winget install -e --id Ollama.Ollama
  echo.
  echo Ollama installed. Close this window and double-click start-xac.bat again.
  pause
  exit /b 0
)

%PY% run_xac.py %*
if errorlevel 1 pause
