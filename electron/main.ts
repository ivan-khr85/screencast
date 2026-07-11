import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Tray,
  Menu,
  Notification,
  nativeImage,
  clipboard,
  screen,
  systemPreferences,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile, spawn as cpSpawn } from 'node:child_process';

// macOS GUI apps don't inherit the shell PATH, so Homebrew binaries
// (ffmpeg, cloudflared) aren't found. Prepend common install locations.
if (process.platform === 'darwin') {
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/local/bin',
  ];
  process.env.PATH = [...extraPaths, process.env.PATH].join(':');
}
import { Capture, listDevices, checkSckVideoSupport } from '../src/capture.js';
import { StreamServer } from '../src/server.js';
import { generatePassword } from '../src/auth.js';
import { Tunnel } from '../src/tunnel.js';
import { isScreenCaptureKitAvailable, listAudioApps } from '../src/audio-setup.js';
import { DEFAULTS, deriveRateControl, AudioConfig, AudioMode } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Readiness Check & Auto-Prepare ---

type ScreenRecordingStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

interface ReadinessResult {
  ready: boolean;
  hasBrew: boolean;
  hasFFmpeg: boolean;
  ffmpegBroken: boolean;
  hasScAudio: boolean;
  hasCloudflared: boolean;
  hasSckVideo: boolean;
  screenRecording: ScreenRecordingStatus;
}

function commandExists(cmd: string): Promise<boolean> {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(checker, [cmd], (err) => resolve(!err));
  });
}

// `which` alone isn't enough for ffmpeg — a binary whose dylibs were removed
// by a later brew upgrade still resolves on PATH but dies instantly (dyld
// "Library not loaded"), so verify it actually runs.
function commandRuns(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(!err));
  });
}

async function checkReadiness(): Promise<ReadinessResult> {
  const [hasBrew, ffmpegOnPath, hasCloudflared] = await Promise.all([
    commandExists('brew'),
    commandExists('ffmpeg'),
    commandExists('cloudflared'),
  ]);
  const hasFFmpeg = ffmpegOnPath && await commandRuns('ffmpeg', ['-version']);
  const ffmpegBroken = ffmpegOnPath && !hasFFmpeg;

  const hasScAudio = isScreenCaptureKitAvailable();
  const hasSckVideo = hasFFmpeg ? await checkSckVideoSupport() : false;

  let screenRecording: ScreenRecordingStatus = 'unknown';
  if (process.platform === 'darwin') {
    screenRecording = systemPreferences.getMediaAccessStatus('screen') as ScreenRecordingStatus;
  }

  const screenOk = process.platform !== 'darwin' || screenRecording === 'granted';

  return {
    ready: hasFFmpeg && hasCloudflared && screenOk,
    hasBrew,
    hasFFmpeg,
    ffmpegBroken,
    hasScAudio,
    hasCloudflared,
    hasSckVideo,
    screenRecording,
  };
}

function brewCommand(subcommand: 'install' | 'upgrade', formula: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = cpSpawn('brew', [subcommand, formula], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // brew can stall on network issues — don't leave the UI awaiting forever
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`brew ${subcommand} ${formula} timed out after 10 minutes`));
    }, 10 * 60 * 1000);
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`brew ${subcommand} ${formula} failed (exit ${code}): ${stderr}`));
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function autoSetup(
  sendProgress: (msg: string) => void,
): Promise<ReadinessResult> {
  const initial = await checkReadiness();

  if (!initial.hasBrew) {
    sendProgress('Homebrew is not installed. Please install it from https://brew.sh first.');
    return initial;
  }

  if (initial.ffmpegBroken) {
    sendProgress('ffmpeg is installed but broken (missing library). Upgrading...');
    try {
      await brewCommand('upgrade', 'ffmpeg');
      sendProgress('ffmpeg upgraded.');
    } catch (err) {
      sendProgress(`Failed to upgrade ffmpeg: ${err instanceof Error ? err.message : err}`);
    }
  } else if (!initial.hasFFmpeg) {
    sendProgress('Installing ffmpeg...');
    try {
      await brewCommand('install', 'ffmpeg');
      sendProgress('ffmpeg installed.');
    } catch (err) {
      sendProgress(`Failed to install ffmpeg: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!initial.hasCloudflared) {
    sendProgress('Installing cloudflared...');
    try {
      await brewCommand('install', 'cloudflared');
      sendProgress('cloudflared installed.');
    } catch (err) {
      sendProgress(`Failed to install cloudflared: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (initial.screenRecording === 'denied' || initial.screenRecording === 'restricted') {
    sendProgress('Screen Recording permission required. Opening System Settings...');
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }

  const result = await checkReadiness();
  if (result.ready) {
    sendProgress('All dependencies are ready!');
  }
  return result;
}

interface StreamConfig {
  port: number;
  fps: number | 'original';
  bitrate: string;
  password: string;
  maxViewers: number;
  audioMode: AudioMode;
  audioAppBundleId?: string;
  tunnel: boolean;
  chat: boolean;
  screenIndex?: string;
}

type TunnelStatus = 'off' | 'starting' | 'up' | 'failed' | 'down';
type StreamHealth = 'good' | 'recovering' | 'degraded';

interface StreamStatus {
  running: boolean;
  url: string | null;
  password: string | null;
  viewers: number;
  maxViewers: number;
  hasAudio: boolean;
  error: string | null;
  chatEnabled: boolean;
  tunnelStatus: TunnelStatus;
  phase: string | null;
  startedAt: number | null;
  health: StreamHealth | null;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: StreamServer | null = null;
let capture: Capture | null = null;
let tunnelInstance: Tunnel | null = null;

let status: StreamStatus = {
  running: false,
  url: null,
  password: null,
  viewers: 0,
  maxViewers: DEFAULTS.maxViewers,
  hasAudio: false,
  error: null,
  chatEnabled: true,
  tunnelStatus: 'off',
  phase: null,
  startedAt: null,
  health: null,
};

let healthRecoveryTimer: NodeJS.Timeout | null = null;

function setHealth(health: StreamHealth): void {
  if (healthRecoveryTimer) {
    clearTimeout(healthRecoveryTimer);
    healthRecoveryTimer = null;
  }
  status.health = health;
  if (health === 'recovering') {
    // Capture pipeline is restarting; assume it settles unless another
    // restart or error arrives within the window.
    healthRecoveryTimer = setTimeout(() => {
      healthRecoveryTimer = null;
      if (status.running && status.health === 'recovering') {
        status.health = 'good';
        pushStatus();
      }
    }, 10_000);
  }
  pushStatus();
}

function pushStatus(): void {
  mainWindow?.webContents.send('stream:status-update', status);
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Show Window',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
  ];

  if (status.running) {
    if (status.url) {
      template.push({ label: `URL: ${status.url}`, enabled: false });
      template.push({
        label: 'Copy URL',
        click: () => clipboard.writeText(status.url!),
      });
    }
    if (status.password) {
      template.push({
        label: 'Copy Password',
        click: () => clipboard.writeText(status.password!),
      });
    }
    if (status.url && status.password) {
      template.push({
        label: 'Copy Link (auto-connect)',
        click: () =>
          clipboard.writeText(
            `${status.url}#${status.password!}`,
          ),
      });
    }
    template.push({
      label: `Viewers: ${status.viewers}/${status.maxViewers}`,
      enabled: false,
    });
    const tunnelLabels: Record<TunnelStatus, string> = {
      off: 'Sharing: LAN only',
      starting: 'Tunnel: starting…',
      up: 'Sharing: public via Cloudflare',
      failed: 'Tunnel failed — LAN only',
      down: 'Tunnel down — LAN only',
    };
    template.push({ label: tunnelLabels[status.tunnelStatus], enabled: false });
    template.push({ type: 'separator' });
    template.push({ label: 'Stop Stream', click: () => stopStream() });
  } else {
    template.push({ label: 'Not streaming', enabled: false });
  }

  template.push({ type: 'separator' });
  template.push({
    label: 'Quit',
    click: () => {
      stopStream();
      app.quit();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(
    status.running
      ? `Screencast - ${status.viewers} viewer${status.viewers !== 1 ? 's' : ''}`
      : 'Screencast',
  );
}

// Renderer input crosses a trust boundary — clamp every number so a cleared
// field (NaN) or hostile value can't reach listen()/ffmpeg args.
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// 'original' fps = native refresh rate of the streamed display. desktopCapturer
// source order is assumed to match screen.getAllDisplays() (same assumption the
// UI already makes for ffmpeg device indices); mismatches fall back to primary.
function displayRefreshRate(screenIndex?: string): number {
  const displays = screen.getAllDisplays();
  const idx = parseInt(screenIndex ?? '0', 10);
  const hz = displays[idx]?.displayFrequency || screen.getPrimaryDisplay().displayFrequency;
  return clampInt(Math.round(hz), 1, 120, 60);
}

let starting = false;

async function startStream(config: StreamConfig): Promise<void> {
  // `starting` blocks re-entry during the async startup window,
  // before status.running is set at the end of #doStartStream.
  if (status.running || starting) return;
  starting = true;
  try {
    await doStartStream(config);
  } catch (err) {
    // Partial failure must not leave the server bound or children running —
    // otherwise the next start hits EADDRINUSE until the app is quit.
    stopStream();
    throw err;
  } finally {
    starting = false;
  }
}

async function doStartStream(config: StreamConfig): Promise<void> {
  console.log('[main] startStream:', JSON.stringify(config));

  config.port = clampInt(config.port, 1024, 65535, DEFAULTS.port);
  if (config.fps === 'original') {
    config.fps = displayRefreshRate(config.screenIndex);
    console.log(`[main] fps 'original' resolved to ${config.fps}`);
  } else {
    config.fps = clampInt(config.fps, 1, 120, 30);
  }
  config.maxViewers = clampInt(config.maxViewers, 1, 50, DEFAULTS.maxViewers);
  if (typeof config.bitrate !== 'string' || !/^\d+[kKmM]?$/.test(config.bitrate)) {
    config.bitrate = DEFAULTS.bitrate;
  }

  // DEFAULTS.maxrate/bufsize are tuned for the ~100 Mbps LAN preset; for any
  // other bitrate they would defeat the cap, so derive them from the target.
  let maxrate = DEFAULTS.maxrate;
  let bufsize = DEFAULTS.bufsize;
  if (config.bitrate !== DEFAULTS.bitrate) {
    const derived = deriveRateControl(config.bitrate);
    if (derived) ({ maxrate, bufsize } = derived);
  }

  const setPhase = (phase: string): void => {
    status.phase = phase;
    pushStatus();
  };

  // Check screen recording permission on macOS
  if (process.platform === 'darwin') {
    const screenAccess = systemPreferences.getMediaAccessStatus('screen');
    if (screenAccess === 'denied' || screenAccess === 'restricted') {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
      throw new Error(
        'Screen Recording permission is required. Grant access to Screencast in System Settings, then try again.',
      );
    }
    if (screenAccess === 'not-determined') {
      console.log('[main] screen recording permission not determined — macOS will prompt on first capture');
    }
  }

  let screenIndex: string;
  if (config.screenIndex) {
    screenIndex = config.screenIndex;
    console.log(`[main] using screenIndex from config: ${screenIndex}`);
  } else {
    const { screens } = await listDevices();
    console.log('[main] listDevices screens:', JSON.stringify(screens));
    const screenDevices = screens.filter((d) => /capture screen|screen/i.test(d.name));
    const selected = screenDevices[0] || screens[0];
    if (!selected) throw new Error('No screen capture devices found');
    screenIndex = selected.index;
    console.log(`[main] auto-selected: index=${screenIndex} name="${selected.name}"`);
  }

  const audioConfig: AudioConfig = config.audioMode === 'none'
    ? { mode: 'none' }
    : config.audioMode === 'app' && config.audioAppBundleId
      ? { mode: 'app', appBundleId: config.audioAppBundleId }
      : { mode: config.audioMode || 'system' };

  const password = config.password || generatePassword();
  const port = config.port;
  const gopSize = Math.max(2, Math.round(config.fps / 6));

  // Phase codes — the renderer maps them to localized text
  setPhase('server');
  server = new StreamServer(password, {
    port,
    fps: config.fps,
    bitrate: config.bitrate,
    maxViewers: config.maxViewers,
  });
  server.setHasAudio(audioConfig.mode !== 'none');
  server.setChatEnabled(config.chat !== false);

  // Register callbacks before listen() — a viewer connecting during startup
  // must not go uncounted.
  server.onViewerCountChange((count) => {
    status.viewers = count;
    pushStatus();
  });
  server.onChat((sender, message) => {
    mainWindow?.webContents.send('stream:chat-message', { sender, message });
    // The in-window chat panel already shows the message when the user is
    // looking at the app — only notify when they aren't.
    const windowInFocus = !!mainWindow && mainWindow.isVisible() && mainWindow.isFocused();
    if (!windowInFocus && Notification.isSupported()) {
      new Notification({ title: sender, body: message, silent: true }).show();
    }
  });

  await server.listen(port);

  setPhase('capture');
  capture = new Capture({
    fps: config.fps,
    bitrate: config.bitrate,
    maxrate,
    bufsize,
    gopSize,
  });
  capture.on('videoRtp', (packet) => server?.pushVideoRtp(packet));
  capture.on('audioRtp', (packet) => server?.pushAudioRtp(packet));
  capture.on('restart', () => {
    server?.resetConnections();
    if (status.running) setHealth('recovering');
  });
  capture.on('error', (err: Error) => {
    console.error('[main] capture error:', err.message);
    status.error = `FFmpeg: ${err.message}`;
    if (status.running) setHealth('degraded');
    else pushStatus();
  });
  capture.on('fatal', (err: Error) => {
    console.error('[main] capture fatal:', err.message);
    stopStream();
    // after stopStream — it resets status.error to null
    status.error = `Capture failed: ${err.message}`;
    pushStatus();
  });
  capture.on('log', (msg: string) => {
    console.log(`[capture-log] ${msg}`);
    // Screencapturekit unavailability is expected on this system — the Swift
    // fallback handles it silently. Don't surface these as UI errors.
    if (/unknown input format|Error opening input file/i.test(msg)) return;
    if (/error|fatal|denied|permission|library not loaded|dyld\[/i.test(msg)) {
      status.error = `FFmpeg: ${msg}`;
      if (status.running) setHealth('degraded');
      else pushStatus();
    }
  });
  console.log(`[main] calling capture.start(${screenIndex}, ${JSON.stringify(audioConfig)})`);
  await capture.start(screenIndex, audioConfig);
  console.log('[main] capture.start() returned');

  let url = `http://localhost:${port}`;
  let tunnelStatus: TunnelStatus = 'off';
  if (config.tunnel) {
    setPhase('tunnel');
    tunnelStatus = 'starting';
    tunnelInstance = new Tunnel();
    tunnelInstance.on('error', (err: Error) => {
      console.error('[main] tunnel error:', err.message);
    });
    tunnelInstance.on('close', () => {
      // cloudflared died mid-stream — the public URL is dead, show the LAN one
      if (status.running && status.url?.includes('trycloudflare')) {
        status.url = `http://localhost:${port}`;
        status.tunnelStatus = 'down';
        pushStatus();
      }
    });
    try {
      url = await tunnelInstance.start(port);
      tunnelStatus = 'up';
    } catch {
      // Tunnel failed, fall back to local URL
      tunnelStatus = 'failed';
    }
  }

  status = {
    running: true,
    url,
    password,
    viewers: server.viewerCount,
    maxViewers: config.maxViewers,
    hasAudio: audioConfig.mode !== 'none',
    error: null,
    chatEnabled: config.chat !== false,
    tunnelStatus,
    phase: null,
    startedAt: Date.now(),
    health: 'good',
  };

  pushStatus();
}

function stopStream(): void {
  capture?.stop();
  server?.close();
  tunnelInstance?.stop();
  capture = null;
  server = null;
  tunnelInstance = null;

  if (healthRecoveryTimer) {
    clearTimeout(healthRecoveryTimer);
    healthRecoveryTimer = null;
  }

  status = {
    ...status,
    running: false,
    url: null,
    password: null,
    viewers: 0,
    hasAudio: false,
    error: null,
    tunnelStatus: 'off',
    phase: null,
    startedAt: null,
    health: null,
  };
  pushStatus();
}

function getResourcesPath(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'resources');
}

// Two default window heights: the compact idle screen, and the tall layout
// where Advanced Settings (incl. the live display preview) fits without
// scrolling. The tall one is capped to the display's work area.
const COLLAPSED_HEIGHT = 580;
function expandedHeight(): number {
  return Math.min(1120, screen.getPrimaryDisplay().workAreaSize.height - 24);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: COLLAPSED_HEIGHT,
    minWidth: 420,
    minHeight: 580,
    resizable: true,
    maximizable: false,
    icon: path.join(getResourcesPath(), 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b1326',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.on('close', (e) => {
    if (status.running && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  const iconPath = path.join(getResourcesPath(), 'trayTemplate.png');

  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon.setTemplateImage(true);
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

// --- IPC Handlers ---

ipcMain.handle(
  'stream:start',
  async (_event, config: StreamConfig) => {
    try {
      await startStream(config);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status.error = message;
      pushStatus();
      return { success: false, error: message };
    }
  },
);

ipcMain.handle('stream:stop', () => {
  stopStream();
  return { success: true };
});

ipcMain.handle('stream:get-status', () => status);

ipcMain.handle('stream:set-chat', (_event, enabled: boolean) => {
  server?.setChatEnabled(!!enabled);
  status.chatEnabled = !!enabled;
  pushStatus();
});

ipcMain.handle('stream:clear-error', () => {
  status.error = null;
  pushStatus();
});

ipcMain.handle('stream:send-chat', (_event, text: unknown) => {
  if (typeof text !== 'string') return { success: false };
  const message = text.trim().slice(0, 500);
  if (!message || !server) return { success: false };
  return { success: server.sendHostChat(message) };
});

ipcMain.handle('devices:list', async () => {
  try {
    return await listDevices();
  } catch (err) {
    return {
      screens: [],
      audioDevices: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('audio:list-apps', async () => {
  try {
    return await listAudioApps();
  } catch {
    return [];
  }
});

// desktopCapturer only works in the main process — sandboxed preloads
// (Electron 20+) don't get it, so the renderer asks via IPC.
ipcMain.handle('screen:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 200 },
  });
  return sources.map((s, i) => ({
    index: String(i),
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('clipboard:copy', (_event, text: string) => {
  clipboard.writeText(text);
});

// Grow/shrink the window when the renderer toggles Advanced Settings so the
// panel always fits without scrolling.
ipcMain.handle('window:set-advanced', (_event, open: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const height = open === true ? expandedHeight() : COLLAPSED_HEIGHT;
  const [width] = mainWindow.getSize();
  mainWindow.setSize(width, height, true);
});

ipcMain.handle('system:check-readiness', async () => {
  return await checkReadiness();
});

// The control panel loads over file:// where CSP blocks fetch() of local
// JSON, so locale resources are handed over via IPC instead.
let i18nCache: { locale: string; resources: Record<string, { translation: unknown }> } | null = null;
ipcMain.handle('i18n:get', () => {
  if (!i18nCache) {
    const resources: Record<string, { translation: unknown }> = {};
    for (const lng of ['en', 'uk'] as const) {
      try {
        const raw = fs.readFileSync(path.join(__dirname, 'locales', `${lng}.json`), 'utf8');
        resources[lng] = { translation: JSON.parse(raw) };
      } catch (err) {
        console.error(`[main] failed to load locale ${lng}:`, err);
      }
    }
    i18nCache = { locale: app.getLocale(), resources };
  }
  return i18nCache;
});

ipcMain.handle('system:auto-setup', async (event) => {
  const sendProgress = (msg: string) => {
    event.sender.send('system:setup-progress', msg);
  };
  return await autoSetup(sendProgress);
});

// --- App Lifecycle ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    createTray();
    createWindow();

    app.on('activate', () => {
      if (!mainWindow) createWindow();
      else mainWindow.show();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !status.running) {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopStream();
});
