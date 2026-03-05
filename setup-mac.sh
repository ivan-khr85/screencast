#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "  Screencast - macOS Setup"
echo "  ========================"
echo ""

# --- Node.js ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
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
  if [ "$FFMPEG_MAJOR" -lt 8 ]; then
    echo "  [!!] FFmpeg $FFMPEG_VER is too old (screen capture broken on modern macOS)."
    echo "       Upgrading..."
    brew upgrade ffmpeg
  else
    echo "  [ok] FFmpeg $FFMPEG_VER"
  fi
else
  echo "  [..] Installing FFmpeg..."
  brew install ffmpeg
fi

# Verify after install/upgrade
if ! command -v ffmpeg &>/dev/null; then
  echo "  [!!] FFmpeg installation failed."
  exit 1
fi

# --- BlackHole (optional, for system audio) ---
echo ""
if ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -qi "blackhole"; then
  echo "  [ok] BlackHole audio driver detected"
else
  echo "  [--] BlackHole not installed (needed for system audio capture)."
  read -rp "       Install BlackHole 2ch? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    brew install blackhole-2ch
    echo ""
    echo "  BlackHole installed. To route system audio through it:"
    echo "    1. Open 'Audio MIDI Setup' (Spotlight > Audio MIDI Setup)"
    echo "    2. Click '+' at bottom-left > 'Create Multi-Output Device'"
    echo "    3. Check both your speakers/headphones AND 'BlackHole 2ch'"
    echo "    4. Right-click the Multi-Output Device > 'Use This Device For Sound Output'"
    echo ""
  else
    echo "       Skipped. Run with --no-audio or install later: brew install blackhole-2ch"
  fi
fi

# --- cloudflared (optional, for public tunnels) ---
echo ""
if command -v cloudflared &>/dev/null; then
  echo "  [ok] cloudflared (tunnel support)"
else
  echo "  [--] cloudflared not installed (needed for public URL tunnels)."
  read -rp "       Install cloudflared? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    brew install cloudflared
  else
    echo "       Skipped. Run with --no-tunnel or install later: brew install cloudflared"
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
