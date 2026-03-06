# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Screencast is a macOS screen-streaming app. FFmpeg captures the screen (and optionally system audio via BlackHole) using AVFoundation, encodes to fragmented MP4 with `h264_videotoolbox`, pipes it to a Node.js server that parses it with `mp4frag` into init+media segments, and broadcasts them over WebSocket to browser viewers using MediaSource Extensions. An optional Cloudflare quick tunnel exposes the stream to the internet.

There are two interfaces: a CLI (`bin/cli.ts`) and an Electron desktop app (`electron/`).

## Commands

```bash
npm run dev            # Run CLI in development (tsx, no build step)
npm run build          # TypeScript compile + esbuild electron + copy assets
npm start              # Build then run CLI

npm run electron:dev        # Build then launch Electron app
npm run electron:build:mac  # Build distributable .dmg/.zip
npm run electron:build:win  # Build distributable .exe

npm run setup          # Run setup-mac.sh (installs ffmpeg, blackhole, cloudflared via brew)
```

There are no tests or linters configured in this project.

## Architecture

### Data Flow

```
FFmpeg (Capture) → stdout pipe → StreamServer.pushData() → mp4frag → WebSocket broadcast → Browser (MSE)
```

### Core Modules (src/)

- **`capture.ts`** — Spawns FFmpeg with AVFoundation input. Emits `data` (Buffer chunks), `restart`, `log`, and `error` events. Auto-restarts FFmpeg on unexpected exit.
- **`server.ts`** — `StreamServer` class: HTTP server serves `viewer.html`; WebSocket server handles auth, streams mp4 segments, manages viewer chat, enforces backpressure (disconnects viewers with >4MB buffered). Uses private class fields (`#`).
- **`auth.ts`** — WebSocket auth: first message must be `{"type":"auth","password":"..."}` within 5s timeout.
- **`tunnel.ts`** — Wraps `cloudflared tunnel --url` to create temporary Cloudflare tunnels. Parses the tunnel URL from process output.
- **`constants.ts`** — `Config` interface, `DEFAULTS` object, and `LATENCY_PRESETS` (ultra-low/medium/slow) that control GOP size, bufsize, live-edge threshold, and buffer eviction.
- **`viewer.html`** — Self-contained HTML/JS viewer with MSE playback, WebSocket connection, password auth, live-edge seeking, auto-reconnect with exponential backoff, and chat UI.

### Electron App (electron/)

- **`main.ts`** — Main process. Manages window, system tray, IPC handlers (`stream:start`, `stream:stop`, `stream:get-status`, `stream:set-chat`, `devices:list`, `clipboard:copy`, `system:check-readiness`, `system:auto-setup`). Prepends Homebrew paths to `PATH` since macOS GUI apps don't inherit shell PATH.
- **`preload.cts`** — CommonJS preload script (required by Electron). Exposes `window.api` via `contextBridge`.
- **`ui/`** — Static HTML/CSS/JS for the desktop control panel (not TypeScript, not bundled).

### Build

- `tsc` compiles `bin/`, `src/`, `electron/` TypeScript to `dist/`
- `esbuild` bundles `electron/main.ts` into a single CJS file (`dist/electron/main.cjs`) since Electron doesn't support ESM main
- `scripts/copy-assets.sh` copies `viewer.html` and Electron UI static files to `dist/`
- The project uses ESM (`"type": "module"`) with Node16 module resolution; imports use `.js` extensions

### Key Conventions

- Node.js >= 20 required
- Private class fields (`#field`) used throughout for encapsulation
- Dependencies are minimal: `ws`, `mp4frag`, `commander` (runtime); `typescript`, `tsx`, `esbuild`, `electron`, `electron-builder` (dev)
- No framework for the viewer page or Electron UI — plain HTML/CSS/JS
