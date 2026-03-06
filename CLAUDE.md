# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Screencast is a macOS screen-streaming app. FFmpeg captures the screen using AVFoundation, encodes to fragmented MP4 with `h264_videotoolbox`, and pipes it to a Node.js server. A separate Swift helper (`sc-audio`) captures system audio via ScreenCaptureKit (macOS 13+) as raw PCM and pipes it alongside the video. The server parses video with `mp4frag` into init+media segments, and broadcasts both video and audio over WebSocket to browser viewers using MediaSource Extensions and the Web Audio API. An optional Cloudflare quick tunnel exposes the stream to the internet.

There are two interfaces: a CLI (`bin/cli.ts`) and an Electron desktop app (`electron/`).

## Commands

```bash
npm run dev            # Run CLI in development (tsx, no build step)
npm run build          # TypeScript compile + esbuild electron + build swift + copy assets
npm run build:swift    # Build the sc-audio Swift helper only
npm start              # Build then run CLI

npm run electron:dev        # Build then launch Electron app
npm run electron:build:mac  # Build distributable .dmg/.zip
npm run electron:build:win  # Build distributable .exe

npm run setup          # Run setup-mac.sh (installs ffmpeg, cloudflared via brew)
```

There are no tests or linters configured in this project.

## Architecture

### Data Flow

```
FFmpeg (screen) ──stdout pipe──► StreamServer.pushData() ──► mp4frag ──► tagged 0x00 ──┐
                                                                                       ├──► WebSocket broadcast ──► Browser
sc-audio (audio) ─stdout pipe──► StreamServer.pushAudio() ─────────► tagged 0x01 ──────┘
```

Binary WebSocket frames use a 1-byte tag prefix: `0x00` = video (mp4 segment), `0x01` = raw PCM audio (f32le, 48kHz, stereo).

### Core Modules (src/)

- **`capture.ts`** — Spawns FFmpeg for video and `sc-audio` for audio as separate child processes. Video uses AVFoundation input, emits `data` (Buffer chunks) and `restart` events. Audio emits `audio` chunks. Both auto-restart on unexpected exit.
- **`server.ts`** — `StreamServer` class: HTTP server serves `viewer.html`/`.css`/`.js`; WebSocket server handles auth, streams tagged binary segments, manages viewer chat, enforces backpressure (disconnects viewers with >4MB buffered).
- **`auth.ts`** — WebSocket auth: first message must be `{"type":"auth","password":"..."}` within 5s timeout.
- **`tunnel.ts`** — Wraps `cloudflared tunnel --url` to create temporary Cloudflare tunnels.
- **`constants.ts`** — `Config` interface, `DEFAULTS` object, and `LATENCY_PRESETS` (ultra-low/medium/slow) that control GOP size, bufsize, live-edge threshold, and buffer eviction.
- **`audio-setup.ts`** — Resolves the `sc-audio` binary path (handles dev vs packaged Electron), lists available apps for per-app audio capture.
- **`viewer.html`/`.css`/`.js`** — Browser viewer with MSE video playback, Web Audio API for PCM audio, WebSocket connection, password auth, live-edge seeking, auto-reconnect with exponential backoff, and chat UI.

### Swift Audio Helper (swift/sc-audio/)

A Swift Package using ScreenCaptureKit to capture system or per-app audio as raw PCM (f32le, 48kHz, stereo) written to stdout. Includes silence padding (20ms timer) to maintain continuous audio flow. Commands: `capture` (with optional `--app <bundleID>`) and `list` (outputs running apps as JSON).

### Electron App (electron/)

- **`main.ts`** — Main process. Manages window, system tray, IPC handlers (`stream:start`, `stream:stop`, `stream:get-status`, `stream:set-chat`, `devices:list`, `audio:list-apps`, `clipboard:copy`, `system:check-readiness`, `system:auto-setup`). Prepends Homebrew paths to `PATH` since macOS GUI apps don't inherit shell PATH.
- **`preload.cts`** — CommonJS preload script (required by Electron). Exposes `window.api` via `contextBridge`.
- **`ui/`** — Static HTML/CSS/JS for the desktop control panel (not TypeScript, not bundled).

### Build

- `tsc` compiles `bin/`, `src/`, `electron/` TypeScript to `dist/`
- `esbuild` bundles `electron/main.ts` into a single CJS file (`dist/electron/main.cjs`) since Electron doesn't support ESM main
- `swift build -c release` in `swift/sc-audio/` produces the `sc-audio` binary
- `scripts/copy-assets.sh` copies viewer files and Electron UI static files to `dist/`
- The project uses ESM (`"type": "module"`) with Node16 module resolution; imports use `.js` extensions

### Key Conventions

- Node.js >= 20, macOS 13+ (for ScreenCaptureKit audio)
- Private class fields (`#field`) used throughout for encapsulation
- Dependencies are minimal: `ws`, `mp4frag`, `commander` (runtime); `typescript`, `tsx`, `esbuild`, `electron`, `electron-builder` (dev)
- No framework for the viewer page or Electron UI — plain HTML/CSS/JS
