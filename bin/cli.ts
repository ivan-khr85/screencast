#!/usr/bin/env node

import { program } from 'commander';
import { Capture, listDevices } from '../src/capture.js';
import { StreamServer } from '../src/server.js';
import { generatePassword } from '../src/auth.js';
import { Tunnel } from '../src/tunnel.js';
import { isScreenCaptureKitAvailable, listAudioApps } from '../src/audio-setup.js';
import { DEFAULTS, AudioConfig, AudioMode } from '../src/constants.js';

interface CliOptions {
  port: string;
  fps: string;
  bitrate: string;
  password?: string;
  maxViewers: string;
  audio: boolean;
  audioMode?: string;
  audioApp?: string;
  tunnel: boolean;
  listDevices?: boolean;
  listApps?: boolean;
}

program
  .name('screencast')
  .description('Stream your macOS screen + audio to friends via browser')
  .option('--port <number>', 'Server port', String(DEFAULTS.port))
  .option('--fps <number>', 'Frames per second', String(DEFAULTS.fps))
  .option('--bitrate <string>', 'Video bitrate', DEFAULTS.bitrate)
  .option('--password <string>', 'Custom password (default: auto-generated)')
  .option('--max-viewers <number>', 'Maximum concurrent viewers', String(DEFAULTS.maxViewers))
  .option('--no-audio', 'Disable audio capture')
  .option('--audio-mode <mode>', 'Audio mode: system, app, none (default: system)')
  .option('--audio-app <bundleID>', 'Bundle ID of app to capture audio from')
  .option('--no-tunnel', 'Disable cloudflared tunnel (LAN only)')
  .option('--list-devices', 'List available capture devices and exit')
  .option('--list-apps', 'List available apps for audio capture and exit');

program.parse();
const opts = program.opts<CliOptions>();

if (opts.listDevices) {
  try {
    const { screens, audioDevices } = await listDevices();
    console.log('\nVideo devices:');
    for (const d of screens) console.log(`  [${d.index}] ${d.name}`);
    console.log('\nAudio devices:');
    for (const d of audioDevices) console.log(`  [${d.index}] ${d.name}`);
    console.log();
  } catch (err) {
    console.error('Failed to list devices. Is FFmpeg installed?');
    console.error((err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  process.exit(0);
}

if (opts.listApps) {
  const apps = await listAudioApps();
  if (apps.length === 0) {
    console.log('\nNo apps found. Is sc-audio built? Run: npm run build:swift\n');
  } else {
    console.log('\nApps available for audio capture:');
    for (const app of apps) console.log(`  ${app.name} (${app.bundleID})`);
    console.log();
  }
  process.exit(0);
}

const port = parseInt(opts.port, 10);
const fps = parseInt(opts.fps, 10);
const maxViewers = parseInt(opts.maxViewers, 10);
const password = opts.password || generatePassword();
const wantAudio = opts.audio !== false;
const wantTunnel = opts.tunnel !== false;

// Detect devices
let screenIndex = '1';

try {
  const { screens } = await listDevices();
  const screenDevices = screens.filter((d) => /capture screen|screen/i.test(d.name));
  const selectedScreen = screenDevices[0] || screens[0];

  if (!selectedScreen) {
    console.error('No screen capture devices found.');
    process.exit(1);
  }
  screenIndex = selectedScreen.index;
} catch (err) {
  console.error('Failed to detect devices. Is FFmpeg installed?');
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Resolve audio config
let audioConfig: AudioConfig = { mode: 'none' };

if (wantAudio) {
  const explicitMode = opts.audioMode as AudioMode | undefined;

  if (explicitMode === 'none') {
    audioConfig = { mode: 'none' };
  } else if (explicitMode === 'app' && opts.audioApp) {
    audioConfig = { mode: 'app', appBundleId: opts.audioApp };
  } else if (isScreenCaptureKitAvailable()) {
    audioConfig = explicitMode === 'app' && opts.audioApp
      ? { mode: 'app', appBundleId: opts.audioApp }
      : { mode: 'system' };
  } else {
    console.log('\n  Audio capture requires the sc-audio helper (ScreenCaptureKit, macOS 13+).');
    console.log('  Build it with: npm run build:swift');
    console.log('  Continuing without audio...\n');
  }
}

// Start server
const server = new StreamServer(password, {
  port,
  maxViewers,
});
await server.listen(port);

// Start capture
const capture = new Capture({
  fps,
  bitrate: opts.bitrate,
  gopSize: fps,
});

capture.on('data', (chunk) => server.pushData(chunk));

capture.on('restart', () => {
  server.resetParser();
});

capture.on('log', (msg) => {
  console.error(`  [ffmpeg] ${msg}`);
});

capture.on('error', (err) => {
  console.error(`  [ffmpeg] ${err.message}`);
});

capture.start(screenIndex, audioConfig);

// Start tunnel
let tunnelUrl: string | null = null;
let tunnel: Tunnel | null = null;

if (wantTunnel) {
  tunnel = new Tunnel();
  try {
    tunnelUrl = await tunnel.start(port);
  } catch (err) {
    console.error(`\n  Tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Continuing in LAN-only mode.\n');
  }
}

// Display info
const viewerMax = maxViewers;
let viewerCount = 0;

function printStatus(): void {
  console.log(`
  ─── Screen Stream ───
  URL:      ${tunnelUrl || `http://localhost:${port}`}
  Password: ${password}
  Link:     ${tunnelUrl || `http://localhost:${port}`}#${password}
  Viewers:  ${viewerCount}/${viewerMax}
${audioConfig.mode === 'none' ? '  (no audio)' : `  Audio: ${audioConfig.mode}${audioConfig.appBundleId ? ` (${audioConfig.appBundleId})` : ''}`}  Press Ctrl+C to stop.
  ─────────────────────
`);
}

server.onViewerCountChange((count) => {
  viewerCount = count;
  printStatus();
});

printStatus();

// Graceful shutdown
function shutdown(): void {
  console.log('\n  Shutting down...');
  capture.stop();
  server.close();
  if (tunnel) tunnel.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
