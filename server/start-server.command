#!/bin/bash
# Target Discord-Alert Server v5 — start script (Mac, buyer's computer)
# Double-click this file. Keep the Terminal window open while the bot runs.
# The server binds to 127.0.0.1 only — it is not reachable from the internet.
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "[v5] Python 3 was not found. Install Python 3.11+ from python.org, then try again."
  read -p "Press Enter to close."
  exit 1
fi
# Use an isolated folder (.venv) for the server's pieces, so nothing is
# installed into the Mac's own Python. Created once, reused afterwards.
if [ ! -x ".venv/bin/python" ]; then
  echo "[v5] Setting up (first run only, about a minute) ..."
  python3 -m venv .venv 2>/dev/null
  if [ -x ".venv/bin/python" ]; then
    .venv/bin/python -m pip install --quiet -r requirements.txt
  fi
fi
if [ -x ".venv/bin/python" ] && .venv/bin/python -c "import fastapi, uvicorn" 2>/dev/null; then
  PY=".venv/bin/python"
else
  # Fallback: system Python (only if the isolated setup did not work).
  echo "[v5] Using system Python instead ..."
  PY="python3"
  python3 -c "import fastapi, uvicorn" 2>/dev/null || {
    python3 -m pip install -r requirements.txt 2>/dev/null \
      || python3 -m pip install --break-system-packages -r requirements.txt
  }
  if ! python3 -c "import fastapi, uvicorn" 2>/dev/null; then
    echo "[v5] Could not install the server pieces. Check your internet connection and try again."
    read -p "Press Enter to close."
    exit 1
  fi
fi
echo "[v5] Starting server on http://127.0.0.1:5000 ..."
echo "[v5] Keep this window open. Press Ctrl+C to stop."
echo "[v5] The dashboard will open in your browser at http://127.0.0.1:5000/"
echo "[v5] Use the dashboard to add products and change settings - no file editing needed."
# Open the dashboard a few seconds after the server starts.
(sleep 4; open "http://127.0.0.1:5000/") &
"$PY" server.py
if [ $? -ne 0 ]; then
  echo
  echo "[v5] Server stopped with an error. See server.log for details."
  read -p "Press Enter to close."
fi
