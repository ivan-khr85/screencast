#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Viewer page
mkdir -p "$ROOT/dist/src"
cp "$ROOT/src/viewer.html" "$ROOT/dist/src/viewer.html"

# Electron UI
mkdir -p "$ROOT/dist/electron/ui"
cp "$ROOT/electron/ui/index.html" \
   "$ROOT/electron/ui/styles.css" \
   "$ROOT/electron/ui/app.js" \
   "$ROOT/dist/electron/ui/"
