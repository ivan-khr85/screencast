#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Viewer page + assets
mkdir -p "$ROOT/dist/src/locales" "$ROOT/dist/src/vendor"
cp "$ROOT/src/viewer.html" \
   "$ROOT/src/viewer.css" \
   "$ROOT/src/viewer.js" \
   "$ROOT/src/i18n-dom.js" \
   "$ROOT/dist/src/"
cp "$ROOT/src/locales/en.json" "$ROOT/src/locales/uk.json" "$ROOT/dist/src/locales/"
cp "$ROOT/src/vendor/i18next.min.js" "$ROOT/dist/src/vendor/"

# esbuild bundles electron/main.ts so __dirname resolves to dist/electron/
# Copy viewer files there too so the HTTP server can find them
mkdir -p "$ROOT/dist/electron/locales" "$ROOT/dist/electron/vendor"
cp "$ROOT/src/viewer.html" \
   "$ROOT/src/viewer.css" \
   "$ROOT/src/viewer.js" \
   "$ROOT/src/i18n-dom.js" \
   "$ROOT/dist/electron/"
cp "$ROOT/src/locales/en.json" "$ROOT/src/locales/uk.json" "$ROOT/dist/electron/locales/"
cp "$ROOT/src/vendor/i18next.min.js" "$ROOT/dist/electron/vendor/"

# Electron UI
mkdir -p "$ROOT/dist/electron/ui/vendor"
cp "$ROOT/electron/ui/index.html" \
   "$ROOT/electron/ui/styles.css" \
   "$ROOT/electron/ui/app.js" \
   "$ROOT/dist/electron/ui/"
cp "$ROOT/electron/ui/vendor/qrcode.js" "$ROOT/dist/electron/ui/vendor/"
cp "$ROOT/src/vendor/i18next.min.js" "$ROOT/dist/electron/ui/vendor/"
cp "$ROOT/src/i18n-dom.js" "$ROOT/dist/electron/ui/"
