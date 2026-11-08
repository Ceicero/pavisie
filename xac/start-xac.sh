#!/usr/bin/env bash
# XAC launcher for macOS and Linux. Usage: ./start-xac.sh [--profile deep] [--cli] [--plan]
set -euo pipefail
cd "$(dirname "$0")"

red() { printf '\033[38;5;196m%s\033[0m\n' "$*"; }

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  red "Python 3.9+ is required."
  if [ "$(uname)" = "Darwin" ]; then echo "  Install it with: brew install python   (or https://www.python.org/downloads/)"
  else echo "  Install it with your package manager, e.g.: sudo apt install python3"; fi
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  red "Ollama (the local model runtime XAC uses) is not installed."
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      read -r -p "Install it now with Homebrew? [y/N] " ok
      if [[ "$ok" =~ ^[Yy]$ ]]; then brew install ollama; else exit 1; fi
    else
      echo "  Download the Mac app from https://ollama.com/download, then run this script again."; exit 1
    fi
  else
    echo "  The official installer is: curl -fsSL https://ollama.com/install.sh | sh"
    read -r -p "Run the official installer now? [y/N] " ok
    if [[ "$ok" =~ ^[Yy]$ ]]; then curl -fsSL https://ollama.com/install.sh | sh; else exit 1; fi
  fi
fi

exec "$PY" run_xac.py "$@"
