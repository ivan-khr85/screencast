# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

iCast is a macOS (and partially Windows) screen-streaming app that delivers the screen to browser viewers over **WebRTC**. FFmpeg captures and H.264-encodes the screen, emits RTP to a local UDP socket; the Node.js server forwards those RTP packets into a `werift` `RTCPeerConnection` per viewer. Audio is captured by the Swift `sc-audio` helper (ScreenCaptureKit, macOS 13+) as raw PCM, encoded to Opus RTP by a second FFmpeg. Signaling (auth, SDP offer/answer, chat) runs over WebSocket on the same HTTP server that serves the viewer page. An optional Cloudflare quick tunnel exposes the stream to the internet.

There are two interfaces: a CLI (`bin/cli.ts`) and an Electron desktop app (`electron/`). Both UIs (browser viewer and Electron control panel) are localized in English and Ukrainian via a vendored i18next.

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
                                                                             fallback tee: pushVideoRtp/pushAudioRtp ─► RemuxPipeline (lazy ffmpeg: RTP→fMP4, -c:v copy + AAC) ─► binary WS frames ─► MSE in browser
```

Signaling over WebSocket: `auth` → `webrtc_ready` → server sends `webrtc_offer` (candidate-less SDP + ICE servers) → both sides trickle `ice_candidate`/`ice_complete` → browser replies `webrtc_answer` immediately after `setLocalDescription` (it must NOT wait for gathering — werift latches on `a=end-of-candidates` in the answer and would ignore every candidate trickled afterwards; symmetrically, the server must NOT await werift's `setLocalDescription`, which resolves only after full gathering). New viewers are gated until the next H.264 GOP start (SPS/IDR detection in `isH264GopStartRtp`) so they always start on a clean keyframe.

**WS media fallback:** when WebRTC can't connect (ICE `failed`, no connection ~9s after the answer, or two 4011 close cycles), the viewer sends `transport_fallback` and the server streams fragmented MP4 over the same WebSocket: `fallback_start` JSON (mime with codecs), then binary frames — `0x01`+init segment, `0x02`+media segment (skipped per-viewer while `bufferedAmount` > 8 MB; safe, every segment starts on an IDR). `?ws=1` on the viewer URL forces this transport (the hash carries the password). It works through the Cloudflare tunnel on any NAT/firewall at ~1–2 s latency; `fallbackEnabled: false` (CLI `--no-ws-fallback`) disables it. The server pings every 25 s (protocol ping detects dead sockets; a parallel `{type:"ping"}` feeds the browser's 60 s watchdog) and sends `stream_restarting` when the capture pipeline restarts in place.

### Core Modules (src/)

- **`capture.ts`** — Spawns capture/encode child processes and forwards their RTP. macOS video: FFmpeg `screencapturekit` input (macOS 15+/Darwin 23+) or `avfoundation`; if FFmpeg lacks SCK support it falls back to `sc-audio capture-screen` (raw NV12) piped into an FFmpeg encoder. Windows: `ddagrab` or `gdigrab` + best available H.264 encoder (NVENC → AMF → QSV → libx264). Audio: `sc-audio capture` → FFmpeg libopus (macOS) or WASAPI loopback (Windows). Emits `videoRtp`/`audioRtp` (Buffer), `restart` (callers must `server.restartStreams()` — renegotiates viewers in place without dropping their sockets), `log`, `error`, and `fatal` (restart attempts exhausted — exponential backoff, max 6). Pipeline restarts are guarded against double-scheduling; child kills escalate SIGTERM → SIGKILL after 3s.
- **`server.ts`** — `StreamServer`: HTTP server serves the viewer page and its assets from an exact-match allowlist (`viewer.html`, `/styles/*.css`, `/js/*.js`, `/fonts/*.woff2`, `/assets/icon-128.png`, `/i18n-dom.js`, `/vendor/i18next.min.js`, `/locales/{en,uk}.json` — anything else is 404; query strings are stripped so `/?ws=1` resolves); WebSocket server (64KB inbound `maxPayload`) handles auth (per-IP throttle: 10 failures/60s), one `RTCPeerConnection` per viewer with trickle ICE (`ice_candidate` messages validated and capped at 64/connection; repeated `webrtc_ready` is ignored via map membership), `bundlePolicy: "max-bundle"`, keyframe gating, the WS media fallback (`transport_fallback` → tees RTP into `RemuxPipeline`, broadcasts init/segments, 30s lazy shutdown after the last fallback viewer leaves, ≤3 respawns), 25s keepalive (protocol ping + JSON ping, dead sockets terminated), viewer chat (rate limit 5 msgs/5s per viewer), `maxViewers` enforced at connect and at viewer registration. `restartStreams()` renegotiates everyone in place; `resetConnections()` (hard drop) remains for stop paths.
- **`remux.ts`** — `RemuxPipeline`: lazily spawned FFmpeg that reads the teed RTP via a temp SDP file on loopback UDP ports (payload types sniffed from live packets), `-c:v copy` + AAC audio (Opus-in-MP4 MSE support is not universal), outputs `frag_keyframe+empty_moov` fMP4 on stdout; a streaming box parser groups `ftyp…moov` into the init segment and each `moof`+`mdat` into one media segment; the mime (`avc1.XXXXXX`) is derived from the avcC box. Only runs while ≥1 fallback viewer exists.
- **`auth.ts`** — WebSocket auth: first message must be `{"type":"auth","password":"..."}` within 5s timeout; comparison is constant-time (sha256 + `timingSafeEqual`). Passwords are 12 hex chars by default.
- **`tunnel.ts`** — Wraps `cloudflared tunnel --url`. Emits `error`/`close` only to subscribers (guarded emit); 30s startup timeout kills the process. The tunnel carries only HTTP/WS (viewer page + signaling + the WS media fallback); WebRTC media is direct UDP and never traverses it.
- **`constants.ts`** — `Config` interface and `DEFAULTS` (fps, bitrate/maxrate/bufsize, gopSize, maxViewers, passwordLength, STUN-only `iceServers`, `fallbackEnabled`). The very high default bitrates (~100 Mbps) are intentional for LAN streaming; both CLI and Electron drop the default to 12000k when the tunnel is on. If you add a TURN server, mind werift's `parseIceServers` limits (first `stun:`/`turn:` string URL only, no `turns:`, no `?transport=tcp` — see the comment in DEFAULTS).
- **`audio-setup.ts`** — Resolves the `sc-audio` binary path (dev vs packaged Electron), lists apps for per-app audio capture.
- **Viewer page** — `viewer.html` at `src/` root; CSS split under `src/styles/` (`tokens.css`, `viewer-base.css`, `viewer-player.css`, `viewer-chat.css`), JS under `src/js/` (`viewer.js`, `viewer-chat.js`, `viewer-stats.js`, `viewer-mse.js`, `viewer-debug.js`). WebRTC playback into a `<video>` with automatic MSE fallback (`viewer-mse.js`: append queue, live-edge chasing, buffer eviction; forced via `?ws=1`), password auth (auto-connect via `#password` URL hash), auto-reconnect with exponential backoff (single pending timer; a separate `webrtcFailCycles` counter survives reconnects and flips the session to the WS transport), 60s no-message watchdog, mute toggle, stats overlay showing the active transport + ICE pair type, host-gated debug panel (`viewer-debug.js`, toggled by the `debug_enabled` message: connection/WebRTC/RTP/MSE/player internals with copy-to-clipboard). All server-sent values rendered via `textContent` — never `innerHTML`. CSP meta tag; no inline event handlers.
- **i18n** — `src/locales/en.json`/`uk.json` (nested keys: `ui.*` for the Electron panel, `viewer.*` for the browser, `common.*` shared); `src/i18n-dom.js` exposes globals `applyI18n(root)` (translates `data-i18n*` attributes) and `pickLanguage()` (saved `localStorage['icast:lang']` → `uk`-prefixed system locale → `en`); `src/vendor/i18next.min.js` is a vendored UMD global (both UIs are unbundled). The viewer fetches locale JSON over HTTP; the Electron UI can't `fetch()` under `file://`, so the `i18n:get` IPC handler in `electron/main.ts` reads locale JSON from disk and returns `{locale, resources}` (cached).
- **Shared design assets** — `src/styles/tokens.css` is the single source of design tokens and `@font-face` rules, used by both the viewer and the Electron UI; `src/fonts/` holds self-hosted woff2 (Inter 400/500/600/700, Manrope 600/700); `src/assets/icon-128.png` is the brand icon.

### Swift Helper (swift/sc-audio/)

A Swift Package using ScreenCaptureKit. Despite the name it does both audio and video:

- `capture [--app <bundleID>]` — system or per-app audio as raw PCM (f32le, 48kHz, stereo) on stdout
- `capture-screen --display <idx> --fps <n>` — raw NV12 frames on stdout (JSON `{"width","height"}` header line on stderr) — the video fallback when FFmpeg lacks SCK
- `list` — running apps as JSON

Both `capture` and `capture-screen` accept `--output <path>` to write to a file/FIFO instead of stdout.

### Electron App (electron/)

- **`main.ts`** — Main process. Window, tray, single-instance lock, IPC handlers (`stream:start/stop/get-status/set-chat/set-debug/send-chat/clear-error`, `devices:list`, `audio:list-apps`, `screen:get-sources`, `clipboard:copy`, `system:check-readiness`, `system:auto-setup`, `i18n:get`). Renderer-supplied config is clamped/validated in the main process. `StreamStatus` carries `startedAt` and `health` (`good | recovering | degraded`): a capture `restart` sets `recovering` (settles back to `good` after 10s), capture error/fatal sets `degraded`. `startStream` has a re-entry guard and cleans up (server/capture/tunnel) if any startup step throws. `desktopCapturer` runs here (sandboxed preloads can't access it) — exposed via `screen:get-sources`. Prepends Homebrew paths to `PATH` since macOS GUI apps don't inherit shell PATH.
- **`preload.cts`** — CommonJS preload script (required by Electron). Exposes `window.api` via `contextBridge`; pure `ipcRenderer.invoke` bridge, no Electron modules used directly.
- **`ui/`** — Static HTML/CSS/JS control panel (not TypeScript, not bundled); CSS in `css/`, JS in `js/`. Shares `tokens.css`, fonts, and `i18n-dom.js` from `src/` (copied in at build time); vendored `ui/vendor/qrcode.js` renders the share-URL QR code. CSP meta tag; event listeners bound in JS, no inline handlers.

### Build

- `tsc` compiles `bin/`, `src/`, `electron/` TypeScript to `dist/`
- `esbuild` bundles `electron/main.ts` into a single CJS file (`dist/electron/main.cjs`) since Electron doesn't support ESM main
- `swift build -c release` in `swift/sc-audio/` produces the `sc-audio` binary (shipped via electron-builder `extraResources`)
- `scripts/copy-assets.sh` — `copy_viewer()` copies the full viewer asset set (html, `styles/`, `js/`, `fonts/`, `assets/`, `locales/`, `vendor/`, `i18n-dom.js`) into BOTH `dist/src` (CLI) and `dist/electron` (packaged app), since the HTTP server serves from its own `__dirname`; then assembles the Electron control-panel UI in `dist/electron/ui/`, pulling shared `tokens.css`/fonts/icon/`i18n-dom.js` from `src/`
- The project uses ESM (`"type": "module"`) with Node16 module resolution; imports use `.js` extensions

### Key Conventions

- Node.js >= 20, macOS 13+ (for ScreenCaptureKit)
- Private class fields (`#field`) used throughout for encapsulation
- Dependencies are minimal: `werift`, `werift-rtp`, `ws`, `commander` (runtime); `typescript`, `tsx`, `esbuild`, `electron`, `electron-builder` (dev)
- No framework or bundler for the viewer page or Electron UI — plain HTML/CSS/JS with two vendored libs loaded as globals (`i18next`, `qrcode.js`)
- Untrusted input is validated at every boundary: CLI flags, renderer IPC config, WebSocket JSON; server-sent values are rendered with `textContent` in both UIs
- `README.md` describes the old pre-WebRTC architecture (MSE/mp4frag over WebSocket) and is outdated — trust this file and the code over the README
