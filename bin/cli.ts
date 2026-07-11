#!/usr/bin/env node

import { program } from 'commander';
import { Capture, listDevices } from '../src/capture.js';
import { StreamServer } from '../src/server.js';
import { generatePassword } from '../src/auth.js';
import { Tunnel } from '../src/tunnel.js';
import { isScreenCaptureKitAvailable, listAudioApps } from '../src/audio-setup.js';
import { DEFAULTS, deriveRateControl, AudioConfig, AudioMode } from '../src/constants.js';

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
  screen?: string;
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
  .option('--list-apps', 'List available apps for audio capture and exit')
  .option('--screen <index>', 'Display index to capture (0 = main, see --list-devices)');

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

function requireInt(value: string, name: string, min: number, max: number): number {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`Invalid --${name}: "${value}" (expected integer ${min}-${max})`);
    process.exit(1);
  }
  return n;
}

const port = requireInt(opts.port, 'port', 1, 65535);
const fps = requireInt(opts.fps, 'fps', 1, 120);
const maxViewers = requireInt(opts.maxViewers, 'max-viewers', 1, 100);
if (!/^\d+[kKmM]?$/.test(opts.bitrate)) {
  console.error(`Invalid --bitrate: "${opts.bitrate}" (expected e.g. 8000k)`);
  process.exit(1);
}
const password = opts.password || generatePassword();
const wantAudio = opts.audio !== false;
const wantTunnel = opts.tunnel !== false;

// The default ~100 Mbps bitrate is a LAN preset; through an internet uplink
// it creates standing queues (seconds of latency) and loss. When the tunnel
// is on and the user didn't choose a bitrate, drop to a remote-friendly one.
let bitrate = opts.bitrate;
if (wantTunnel && program.getOptionValueSource('bitrate') !== 'cli') {
  bitrate = '20000k';
  console.log('  Tunnel enabled: using remote-friendly bitrate 20000k (override with --bitrate, or --no-tunnel for LAN max)');
}

// DEFAULTS.maxrate/bufsize only suit the default bitrate — derive otherwise.
const rateControl = bitrate !== DEFAULTS.bitrate ? deriveRateControl(bitrate) : null;

// Detect devices
let screenIndex: string;

if (opts.screen !== undefined) {
  screenIndex = opts.screen;
} else {
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
  fps,
  bitrate,
  maxViewers,
});
server.setHasAudio(audioConfig.mode !== 'none');
await server.listen(port);

// Start capture
const capture = new Capture({
  fps,
  bitrate,
  ...(rateControl ?? {}),
  gopSize: Math.max(2, Math.round(fps / 6)),
});

capture.on('videoRtp', (packet) => server.pushVideoRtp(packet));
capture.on('audioRtp', (packet) => server.pushAudioRtp(packet));

capture.on('restart', () => {
  server.resetConnections();
});

capture.on('log', (msg) => {
  console.error(`  [ffmpeg] ${msg}`);
});

capture.on('error', (err) => {
  console.error(`  [ffmpeg] ${err.message}`);
});

capture.on('fatal', (err: Error) => {
  console.error(`\n  Capture failed permanently: ${err.message}`);
  shutdown();
});

await capture.start(screenIndex, audioConfig);

// Start tunnel
let tunnelUrl: string | null = null;
let tunnel: Tunnel | null = null;

if (wantTunnel) {
  tunnel = new Tunnel();
  tunnel.on('error', (err: Error) => {
    console.error(`  Tunnel error: ${err.message}`);
  });
  tunnel.on('close', (code: number | null) => {
    if (code !== 0 && code !== null) console.error('  Tunnel closed unexpectedly; stream remains reachable on LAN.');
  });
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
  // Give the stream_ended WS frames a moment to flush before the process dies
  setTimeout(() => process.exit(0), 150);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
