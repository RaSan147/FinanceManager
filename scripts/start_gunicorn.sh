#!/usr/bin/env bash
set -euo pipefail

# Convenience script to start Gunicorn for this project.
# Usage:
#   ./scripts/start_gunicorn.sh
# or with environment overrides:
#   GUNICORN_BIND=127.0.0.1:5002 GUNICORN_TIMEOUT=120 VENV=/path/to/venv ./scripts/start_gunicorn.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
cd "$PROJECT_ROOT"

# Optionally activate a virtualenv if VENV env var points to it
if [ -n "${VENV:-}" ]; then
  # Prefer POSIX layout (bin/activate), but support Windows layout (Scripts/activate)
  if [ -f "$VENV/bin/activate" ]; then
    # shellcheck source=/dev/null
    . "$VENV/bin/activate"
  elif [ -f "$VENV/Scripts/activate" ]; then
    # shellcheck source=/dev/null
    . "$VENV/Scripts/activate"
  else
    echo "VENV is set to '$VENV' but no activate script was found; continuing without activation."
  fi

  # run pip install -r requirements.txt if needed
  if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt
  fi
fi

# Default values (can be overridden via env)
GUNICORN_BIND="${GUNICORN_BIND:-127.0.0.1:5001}"
GUNICORN_TIMEOUT="${GUNICORN_TIMEOUT:-90}"

echo "Starting gunicorn bound to ${GUNICORN_BIND} with timeout ${GUNICORN_TIMEOUT}..."

# If you prefer to use the project gunicorn.conf.py, uncomment the -c option below.
exec gunicorn -c gunicorn.conf.py --bind "${GUNICORN_BIND}" --timeout "${GUNICORN_TIMEOUT}" app:app

# exec gunicorn --bind "${GUNICORN_BIND}" --timeout "${GUNICORN_TIMEOUT}" app:app
