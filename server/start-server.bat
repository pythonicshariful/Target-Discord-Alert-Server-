@echo off
REM Target Discord-Alert Server v5 — start script (Windows, buyer's PC)
REM Double-click this file. Keep the black window open while the bot runs.
REM The server binds to 127.0.0.1 only — it is not reachable from the internet.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [v5] Python was not found. Install Python 3.11+ from python.org
  echo [v5] and tick "Add python.exe to PATH" during install, then try again.
  pause
  exit /b 1
)
python -c "import fastapi, uvicorn" 2>nul
if errorlevel 1 (
  echo [v5] Installing dependencies (first run only) ...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [v5] pip install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
echo [v5] Starting server on http://127.0.0.1:5000 ...
echo [v5] Keep this window open. Press Ctrl+C to stop.
python server.py
if errorlevel 1 (
  echo.
  echo [v5] Server stopped with an error. See server.log for details.
  pause
)
