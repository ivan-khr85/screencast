# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Screencast is a macOS (and partially Windows) screen-streaming app that delivers the screen to browser viewers over **WebRTC**. FFmpeg captures and H.264-encodes the screen, emits RTP to a local UDP socket; the Node.js server forwards those RTP packets into a `werift` `RTCPeerConnection` per viewer. Audio is captured by the Swift `sc-audio` helper (ScreenCaptureKit, macOS 13+) as raw PCM, encoded to Opus RTP by a second FFmpeg. Signaling (auth, SDP offer/answer, chat) runs over WebSocket on the same HTTP server that serves the viewer page. An optional Cloudflare quick tunnel exposes the stream to the internet.

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
video: FFmpeg (screencapturekit/avfoundation/ddagrab) ─H264 RTP─► UDP 127.0.0.1 ─► Capture 'videoRtp' ─► StreamServer.pushVideoRtp ─┐
   or: sc-audio capture-screen ─NV12 stdout─► FFmpeg encoder ─H264 RTP─► UDP ──────┘                                                ├─► werift RTCPeerConnection per viewer ─► Browser
audio: sc-audio capture ─PCM stdout─► FFmpeg (libopus) ─Opus RTP─► UDP ─► Capture 'audioRtp' ─► StreamServer.pushAudioRtp ──────────┘
```

Signaling over WebSocket: `auth` → `webrtc_ready` → server sends `webrtc_offer` (SDP + ICE servers) → browser replies `webrtc_answer`. New viewers are gated until the next H.264 GOP start (SPS/IDR detection in `isH264GopStartRtp`) so they always start on a clean keyframe.

### Core Modules (src/)

- **`capture.ts`** — Spawns capture/encode child processes and forwards their RTP. macOS video: FFmpeg `screencapturekit` input (macOS 15+/Darwin 23+) or `avfoundation`; if FFmpeg lacks SCK support it falls back to `sc-audio capture-screen` (raw NV12) piped into an FFmpeg encoder. Windows: `ddagrab` or `gdigrab` + best available H.264 encoder (NVENC → AMF → QSV → libx264). Audio: `sc-audio capture` → FFmpeg libopus (macOS) or WASAPI loopback (Windows). Emits `videoRtp`/`audioRtp` (Buffer), `restart` (callers must `server.resetConnections()`), `log`, `error`, and `fatal` (restart attempts exhausted — exponential backoff, max 6). Pipeline restarts are guarded against double-scheduling; child kills escalate SIGTERM → SIGKILL after 3s.
- **`server.ts`** — `StreamServer`: HTTP server serves `viewer.html`/`.css`/`.js` from an exact-match allowlist; WebSocket server (64KB `maxPayload`) handles auth (per-IP throttle: 10 failures/60s), one `RTCPeerConnection` per viewer (repeated `webrtc_ready` is ignored), keyframe gating, viewer chat (rate limit 5 msgs/5s per viewer), `maxViewers` enforced both at connect and again before registering a finished peer connection.
- **`auth.ts`** — WebSocket auth: first message must be `{"type":"auth","password":"..."}` within 5s timeout; comparison is constant-time (sha256 + `timingSafeEqual`). Passwords are 12 hex chars by default.
- **`tunnel.ts`** — Wraps `cloudflared tunnel --url`. Emits `error`/`close` only to subscribers (guarded emit); 30s startup timeout kills the process.
- **`constants.ts`** — `Config` interface and `DEFAULTS` (fps, bitrate/maxrate/bufsize, gopSize, maxViewers, passwordLength, STUN/TURN `iceServers`). The very high default bitrates (~100 Mbps) are intentional for LAN streaming.
- **`audio-setup.ts`** — Resolves the `sc-audio` binary path (dev vs packaged Electron), lists apps for per-app audio capture.
- **`viewer.html`/`.css`/`.js`** — Browser viewer: WebRTC playback into a `<video>`, password auth (auto-connect via `#password` URL hash), auto-reconnect with exponential backoff (single pending timer), mute toggle, stats overlay (rendered via `textContent` — never `innerHTML`), chat UI. CSP meta tag; no inline event handlers.

### Swift Helper (swift/sc-audio/)

A Swift Package using ScreenCaptureKit. Despite the name it does both audio and video:

- `capture [--app <bundleID>]` — system or per-app audio as raw PCM (f32le, 48kHz, stereo) on stdout
- `capture-screen --display <idx> --fps <n>` — raw NV12 frames on stdout (JSON `{"width","height"}` header line on stderr) — the video fallback when FFmpeg lacks SCK
- `list` — running apps as JSON

### Electron App (electron/)

- **`main.ts`** — Main process. Window, tray, single-instance lock, IPC handlers (`stream:start/stop/get-status/set-chat`, `devices:list`, `audio:list-apps`, `screen:get-sources`, `clipboard:copy`, `system:check-readiness`, `system:auto-setup`). Renderer-supplied config is clamped/validated in the main process. `startStream` has a re-entry guard and cleans up (server/capture/tunnel) if any startup step throws. `desktopCapturer` runs here (sandboxed preloads can't access it) — exposed via `screen:get-sources`. Prepends Homebrew paths to `PATH` since macOS GUI apps don't inherit shell PATH.
- **`preload.cts`** — CommonJS preload script (required by Electron). Exposes `window.api` via `contextBridge`; pure `ipcRenderer.invoke` bridge, no Electron modules used directly.
- **`ui/`** — Static HTML/CSS/JS control panel (not TypeScript, not bundled). CSP meta tag; event listeners bound in `app.js`, no inline handlers.

### Build

- `tsc` compiles `bin/`, `src/`, `electron/` TypeScript to `dist/`
- `esbuild` bundles `electron/main.ts` into a single CJS file (`dist/electron/main.cjs`) since Electron doesn't support ESM main
- `swift build -c release` in `swift/sc-audio/` produces the `sc-audio` binary (shipped via electron-builder `extraResources`)
- `scripts/copy-assets.sh` copies viewer files and Electron UI static files to `dist/`
- The project uses ESM (`"type": "module"`) with Node16 module resolution; imports use `.js` extensions

### Key Conventions

- Node.js >= 20, macOS 13+ (for ScreenCaptureKit)
- Private class fields (`#field`) used throughout for encapsulation
- Dependencies are minimal: `werift`, `werift-rtp`, `ws`, `commander` (runtime); `typescript`, `tsx`, `esbuild`, `electron`, `electron-builder` (dev)
- No framework for the viewer page or Electron UI — plain HTML/CSS/JS
- Untrusted input is validated at every boundary: CLI flags, renderer IPC config, WebSocket JSON; server-sent values are rendered with `textContent` in both UIs
