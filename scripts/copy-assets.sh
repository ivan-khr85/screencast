#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Viewer page + assets
mkdir -p "$ROOT/dist/src"
cp "$ROOT/src/viewer.html" \
   "$ROOT/src/viewer.css" \
   "$ROOT/src/viewer.js" \
   "$ROOT/dist/src/"

# esbuild bundles electron/main.ts so __dirname resolves to dist/electron/
# Copy viewer files there too so the HTTP server can find them
mkdir -p "$ROOT/dist/electron"
cp "$ROOT/src/viewer.html" \
   "$ROOT/src/viewer.css" \
   "$ROOT/src/viewer.js" \
   "$ROOT/dist/electron/"

# Electron UI
mkdir -p "$ROOT/dist/electron/ui"
cp "$ROOT/electron/ui/index.html" \
   "$ROOT/electron/ui/styles.css" \
   "$ROOT/electron/ui/app.js" \
   "$ROOT/dist/electron/ui/"
