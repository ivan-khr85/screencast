# Screencast

Stream your macOS screen (and system audio) to friends via browser in real time. No accounts, no cloud — just a URL and a password.

## How It Works

1. **FFmpeg** captures your screen (and optionally system audio) using macOS AVFoundation
2. Video is hardware-encoded with `h264_videotoolbox` and output as fragmented MP4
3. A **Node.js HTTP + WebSocket server** receives the MP4 fragments and broadcasts them to connected viewers
4. Viewers open the URL in a browser, enter the password, and watch via **MediaSource Extensions (MSE)**
5. Optionally, a **Cloudflare Tunnel** exposes the server to the internet — no port forwarding needed

```
┌──────────┐     pipe:stdout     ┌────────────┐     WebSocket     ┌─────────┐
│  FFmpeg   │ ─────────────────► │  Node.js   │ ────────────────► │ Browser │
│ (capture) │   fragmented MP4   │  (server)  │   binary frames   │ (viewer)│
└──────────┘                     └────────────┘                   └─────────┘
                                       │
                                 cloudflared tunnel
                                 (optional, for internet access)
```

## Prerequisites

- **macOS** (uses AVFoundation for screen capture)
- **Node.js** >= 20.0.0
- **FFmpeg** with `h264_videotoolbox` support (included in Homebrew's ffmpeg)

```bash
brew install node ffmpeg
```

### For System Audio (optional)

System audio capture requires [BlackHole](https://github.com/ExistentialAudio/BlackHole), a virtual audio driver:

```bash
brew install blackhole-2ch
```

**One-time setup:**

1. Open **Audio MIDI Setup** (Spotlight → "Audio MIDI Setup")
2. Click **+** at bottom-left → **Create Multi-Output Device**
3. Check both your speakers/headphones **and** "BlackHole 2ch"
4. Right-click the Multi-Output Device → **Use This Device For Sound Output**

This routes audio to both your speakers and the virtual device so FFmpeg can capture it.

### For Internet Sharing (optional)

To share your stream outside your local network, install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
brew install cloudflared
```

No Cloudflare account is needed — it uses free quick tunnels.

## Installation

```bash
git clone <repo-url>
cd screencast
npm install
```

Or run directly:

```bash
node bin/cli.js
```

## Usage

```bash
# Basic — auto-detects screen, shares via tunnel with auto-generated password
node bin/cli.js

# LAN only, no audio
node bin/cli.js --no-tunnel --no-audio

# Custom settings
node bin/cli.js --port 9000 --fps 15 --bitrate 3000k --password mysecret --max-viewers 10

# List available capture devices
node bin/cli.js --list-devices
```

Once running, you'll see:

```
  Screen Stream started!

  URL:      https://random-name.trycloudflare.com
  Password: 4c6c5ff8

  Share both with your friends.
  Viewers: 0/5

  Press Ctrl+C to stop.
```

Share the **URL** and **password** with your viewers. They open the link in a browser, enter the password, and the stream starts.

## CLI Options

| Option | Default | Description |
|---|---|---|
| `--port <number>` | `8080` | HTTP/WebSocket server port |
| `--fps <number>` | `30` | Capture frame rate |
| `--bitrate <string>` | `5000k` | Video bitrate |
| `--password <string>` | auto-generated | Password viewers must enter |
| `--max-viewers <number>` | `5` | Maximum concurrent viewers |
| `--no-audio` | audio enabled | Disable system audio capture |
| `--no-tunnel` | tunnel enabled | Disable cloudflared tunnel (LAN only) |
| `--list-devices` | — | List available capture devices and exit |

## Project Structure

```
screencast/
├── bin/
│   └── cli.js            # CLI entry point, argument parsing, orchestration
├── src/
│   ├── capture.js         # FFmpeg screen/audio capture via AVFoundation
│   ├── server.js          # HTTP server + WebSocket streaming with mp4frag
│   ├── auth.js            # Password authentication over WebSocket
│   ├── tunnel.js          # Cloudflare quick tunnel management
│   ├── audio-setup.js     # BlackHole detection and setup guide
│   ├── constants.js       # Default configuration values
│   └── viewer.html        # Browser-based video player (MSE)
├── package.json
└── README.md
```

## Viewer Experience

- Viewers open the URL in any modern browser (Chrome, Firefox, Safari, Edge)
- A password prompt appears — enter the shared password to connect
- Video auto-plays muted; **click the video to toggle mute/unmute**
- The player automatically stays at the live edge (skips ahead if falling behind)
- If the connection drops, it reconnects automatically with exponential backoff
- Old buffer is evicted to prevent memory buildup

## Technical Details

**Video pipeline:**
- Capture: `avfoundation` input with cursor capture
- Codec: `h264_videotoolbox` (hardware-accelerated H.264, software fallback enabled)
- Output: Fragmented MP4 (`frag_every_frame + empty_moov + default_base_moof`)
- Parsing: [mp4frag](https://www.npmjs.com/package/mp4frag) splits the stream into init segment + media segments

**Streaming:**
- Server parses fragmented MP4 into segments and broadcasts via WebSocket
- Late-joining viewers receive the initialization segment + current MIME type immediately
- Backpressure: viewers buffering >2 MB are disconnected to protect the stream
- On FFmpeg restart, all viewers are disconnected and reconnect to get the new init segment

**Authentication:**
- First WebSocket message must be `{"type":"auth","password":"..."}` within 5 seconds
- Wrong password or timeout closes the connection
- Password is auto-generated (8 hex characters) unless specified via `--password`

## Troubleshooting

**"No screen capture devices found"**
- Grant Screen Recording permission: System Settings → Privacy & Security → Screen Recording → Terminal (or your terminal app)

**FFmpeg encoder error (`h264_videotoolbox`)**
- The `-allow_sw 1` flag is set to allow software fallback
- If issues persist, check `ffmpeg -encoders | grep videotoolbox`

**No audio**
- Ensure BlackHole is installed: `brew install blackhole-2ch`
- Verify the Multi-Output Device is set as system output in Audio MIDI Setup
- Run `node bin/cli.js --list-devices` to confirm BlackHole appears

**Tunnel not working**
- Ensure cloudflared is installed: `brew install cloudflared`
- Use `--no-tunnel` to fall back to LAN-only mode
- Cloudflare quick tunnels are temporary and may take a few seconds to establish

**Viewers can't connect**
- Verify the correct URL and password are shared
- Check that the maximum viewer limit hasn't been reached (default: 5)
- For LAN mode, ensure viewers are on the same network

## License

MIT
