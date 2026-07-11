#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Shared viewer asset set (HTML, split CSS/JS, fonts, images, locales, vendor).
# The HTTP server serves these from its __dirname: dist/src/ for the CLI build,
# dist/electron/ for the packaged Electron app — so both get a full copy.
copy_viewer() {
  local dest="$1"
  mkdir -p "$dest/styles" "$dest/js" "$dest/fonts" "$dest/assets" "$dest/locales" "$dest/vendor"
  cp "$ROOT/src/viewer.html" "$ROOT/src/i18n-dom.js" "$dest/"
  cp "$ROOT/src/styles/"*.css "$dest/styles/"
  cp "$ROOT/src/js/"*.js "$dest/js/"
  cp "$ROOT/src/fonts/"*.woff2 "$dest/fonts/"
  cp "$ROOT/src/assets/"*.png "$dest/assets/"
  cp "$ROOT/src/locales/en.json" "$ROOT/src/locales/uk.json" "$dest/locales/"
  cp "$ROOT/src/vendor/i18next.min.js" "$dest/vendor/"
}

copy_viewer "$ROOT/dist/src"
copy_viewer "$ROOT/dist/electron"

# Electron control-panel UI (loaded via file:// from dist/electron/ui/).
UI="$ROOT/dist/electron/ui"
mkdir -p "$UI/css" "$UI/js" "$UI/fonts" "$UI/assets" "$UI/vendor"
cp "$ROOT/electron/ui/index.html" "$UI/"
cp "$ROOT/electron/ui/css/"*.css "$UI/css/"
cp "$ROOT/electron/ui/js/"*.js "$UI/js/"
# Shared design tokens + fonts + header icon are sourced from src/
cp "$ROOT/src/styles/tokens.css" "$UI/css/tokens.css"
cp "$ROOT/src/fonts/"*.woff2 "$UI/fonts/"
cp "$ROOT/src/assets/"*.png "$UI/assets/"
cp "$ROOT/electron/ui/vendor/qrcode.js" "$UI/vendor/"
cp "$ROOT/src/vendor/i18next.min.js" "$UI/vendor/"
cp "$ROOT/src/i18n-dom.js" "$UI/"
