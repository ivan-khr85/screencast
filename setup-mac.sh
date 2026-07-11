#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "  iCast - macOS Setup"
echo "  ==================="
echo ""

# --- Node.js ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "${NODE_VER#v}" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  [!!] Node.js $NODE_VER is too old (>= 20 required)."
    echo "       Upgrade via: brew install node"
    exit 1
  fi
  echo "  [ok] Node.js $NODE_VER"
else
  echo "  [!!] Node.js not found."
  echo "       Install via: brew install node"
  exit 1
fi

# --- Homebrew ---
if ! command -v brew &>/dev/null; then
  echo "  [!!] Homebrew not found."
  echo "       Install via: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  exit 1
fi
echo "  [ok] Homebrew"

# --- FFmpeg ---
if command -v ffmpeg &>/dev/null; then
  FFMPEG_VER=$(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')
  FFMPEG_MAJOR=$(echo "$FFMPEG_VER" | cut -d. -f1)
  if [ "$FFMPEG_MAJOR" -lt 7 ] 2>/dev/null; then
    echo "  [!!] FFmpeg $FFMPEG_VER is too old (7+ required for the encoding pipeline)."
    if brew list --formula ffmpeg &>/dev/null; then
      echo "       Upgrading..."
      if ! brew upgrade ffmpeg; then
        echo "  [!!] brew upgrade ffmpeg failed. Upgrade manually and re-run setup."
        exit 1
      fi
    else
      echo "  [!!] ffmpeg on PATH is not managed by Homebrew. Upgrade it manually to 7+."
      exit 1
    fi
  else
    echo "  [ok] FFmpeg $FFMPEG_VER"
  fi
else
  echo "  [..] Installing FFmpeg..."
  if ! brew install ffmpeg; then
    echo "  [!!] brew install ffmpeg failed."
    exit 1
  fi
fi

# Verify after install/upgrade
if ! command -v ffmpeg &>/dev/null; then
  echo "  [!!] FFmpeg installation failed."
  exit 1
fi

# --- sc-audio helper (ScreenCaptureKit audio + video fallback, macOS 13+) ---
echo ""
MACOS_VER=$(sw_vers -productVersion | cut -d. -f1)
if [ "$MACOS_VER" -ge 13 ]; then
  if command -v swift &>/dev/null; then
    echo "  [..] Building sc-audio helper (incremental)..."
    (cd swift/sc-audio && swift build -c release)
    echo "  [ok] sc-audio helper (ScreenCaptureKit audio + video fallback)"
  else
    echo "  [!!] Swift not found. The sc-audio helper is required for audio capture"
    echo "       and is the video capture fallback when FFmpeg lacks ScreenCaptureKit."
    echo "       Install Xcode Command Line Tools: xcode-select --install"
    exit 1
  fi
else
  echo "  [--] macOS $MACOS_VER detected. Audio capture requires macOS 13+."
fi

# --- cloudflared (optional, for public tunnels) ---
echo ""
if command -v cloudflared &>/dev/null; then
  echo "  [ok] cloudflared (tunnel support)"
else
  echo "  [--] cloudflared not installed (needed for public URL tunnels)."
  if [ -t 0 ]; then
    read -rp "       Install cloudflared? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      brew install cloudflared
    else
      echo "       Skipped. Run with --no-tunnel or install later: brew install cloudflared"
    fi
  else
    echo "       Skipped (non-interactive). Run with --no-tunnel or install later: brew install cloudflared"
  fi
fi

# --- npm dependencies ---
echo ""
echo "  [..] Installing npm dependencies..."
npm install --silent
echo "  [ok] npm dependencies"

# --- Screen Recording Permission ---
echo ""
echo "  [!!] Screen Recording permission is required."
echo "       Go to: System Settings > Privacy & Security > Screen Recording"
echo "       Grant access to your terminal app (Terminal, iTerm2, VSCode, etc)."
echo ""

# --- Summary ---
echo "  Setup complete! Run the app with:"
echo ""
echo "    npm run dev              # development (no build step)"
echo "    npm start                # production build + run"
echo "    npm run electron:dev     # Electron desktop app"
echo ""
