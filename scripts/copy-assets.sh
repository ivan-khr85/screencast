#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Viewer page + assets
mkdir -p "$ROOT/dist/src"
cp "$ROOT/src/viewer.html" \
   "$ROOT/src/viewer.css" \
   "$ROOT/src/viewer.js" \
   "$ROOT/dist/src/"

# Electron UI
mkdir -p "$ROOT/dist/electron/ui"
cp "$ROOT/electron/ui/index.html" \
   "$ROOT/electron/ui/styles.css" \
   "$ROOT/electron/ui/app.js" \
   "$ROOT/dist/electron/ui/"
