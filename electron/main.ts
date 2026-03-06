import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  Notification,
  nativeImage,
  clipboard,
  systemPreferences,
  shell,
} from 'electron';
import path from 'node:path';
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
import { Capture, listDevices } from '../src/capture.js';
import { StreamServer } from '../src/server.js';
import { generatePassword } from '../src/auth.js';
import { Tunnel } from '../src/tunnel.js';
import { detectBlackHole } from '../src/audio-setup.js';
import { DEFAULTS, LATENCY_PRESETS, LatencyMode } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Readiness Check & Auto-Prepare ---

interface ReadinessResult {
  ready: boolean;
  hasBrew: boolean;
  hasFFmpeg: boolean;
  hasBlackHole: boolean;
  hasCloudflared: boolean;
  screenRecording: 'granted' | 'denied' | 'unknown';
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
  });
}

async function checkReadiness(): Promise<ReadinessResult> {
  const [hasBrew, hasFFmpeg, hasCloudflared] = await Promise.all([
    commandExists('brew'),
    commandExists('ffmpeg'),
    commandExists('cloudflared'),
  ]);

  let hasBlackHole = false;
  try {
    const { audioDevices } = await listDevices();
    hasBlackHole = audioDevices.some((d) => d.name.includes('BlackHole'));
  } catch {
    // ffmpeg not installed yet — can't list devices
  }

  let screenRecording: 'granted' | 'denied' | 'unknown' = 'unknown';
  if (process.platform === 'darwin') {
    const access = systemPreferences.getMediaAccessStatus('screen');
    screenRecording = access === 'denied' ? 'denied' : 'granted';
  }

  return {
    ready: hasFFmpeg && hasBlackHole && hasCloudflared && screenRecording !== 'denied',
    hasBrew,
    hasFFmpeg,
    hasBlackHole,
    hasCloudflared,
    screenRecording,
  };
}

function brewInstall(formula: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = cpSpawn('brew', ['install', formula], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`brew install ${formula} failed (exit ${code}): ${stderr}`));
    });
    proc.on('error', reject);
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

  if (!initial.hasFFmpeg) {
    sendProgress('Installing ffmpeg...');
    try {
      await brewInstall('ffmpeg');
      sendProgress('ffmpeg installed.');
    } catch (err) {
      sendProgress(`Failed to install ffmpeg: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!initial.hasBlackHole) {
    sendProgress('Installing BlackHole audio driver...');
    try {
      await brewInstall('blackhole-2ch');
      sendProgress('BlackHole installed. A Multi-Output Device may need to be configured in Audio MIDI Setup.');
    } catch (err) {
      sendProgress(`Failed to install BlackHole: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!initial.hasCloudflared) {
    sendProgress('Installing cloudflared...');
    try {
      await brewInstall('cloudflared');
      sendProgress('cloudflared installed.');
    } catch (err) {
      sendProgress(`Failed to install cloudflared: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (initial.screenRecording === 'denied') {
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
  fps: number;
  bitrate: string;
  quality: string;
  latency: LatencyMode;
  password: string;
  maxViewers: number;
  audio: boolean;
  tunnel: boolean;
  chat: boolean;
}

interface StreamStatus {
  running: boolean;
  url: string | null;
  password: string | null;
  viewers: number;
  maxViewers: number;
  hasAudio: boolean;
  error: string | null;
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
};

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

async function startStream(config: StreamConfig): Promise<void> {
  if (status.running) return;

  // Check screen recording permission on macOS
  if (process.platform === 'darwin') {
    const screenAccess = systemPreferences.getMediaAccessStatus('screen');
    if (screenAccess === 'denied') {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
      throw new Error(
        'Screen Recording permission is required. Grant access to Screencast in System Settings, then try again.',
      );
    }
  }

  const { screens } = await listDevices();
  const screenDevices = screens.filter((d) =>
    /capture screen|screen/i.test(d.name),
  );
  const selectedScreen = screenDevices[0] || screens[0];
  if (!selectedScreen) throw new Error('No screen capture devices found');

  let audioDevice: string | null = null;
  if (config.audio) {
    const bh = await detectBlackHole();
    if (bh) audioDevice = bh.index;
  }

  const password = config.password || generatePassword();
  const port = config.port;
  const preset = LATENCY_PRESETS[config.latency] || LATENCY_PRESETS['medium'];
  const gopSize = Math.max(2, Math.round(config.fps * preset.gopMultiplier));

  server = new StreamServer(password, {
    port,
    fps: config.fps,
    bitrate: config.bitrate,
    maxViewers: config.maxViewers,
    liveEdgeThreshold: preset.liveEdgeThreshold,
    bufferEvictionSeconds: preset.bufferEvictionSeconds,
  });
  server.setChatEnabled(config.chat !== false);
  await server.listen(port);

  capture = new Capture({
    fps: config.fps,
    bitrate: config.bitrate,
    bufsize: preset.bufsize,
    gopSize,
    resolution: config.quality,
  });
  capture.on('data', (chunk) => server?.pushData(chunk));
  capture.on('restart', () => server?.resetParser());
  capture.on('error', (err: Error) => {
    status.error = `FFmpeg: ${err.message}`;
    pushStatus();
  });
  capture.on('log', (msg: string) => {
    if (/^(Starting ffmpeg:|ffmpeg args:|First ffmpeg output:)/.test(msg)) return;
    if (/error|fatal|denied|permission/i.test(msg)) {
      status.error = `FFmpeg: ${msg}`;
      pushStatus();
    }
  });
  capture.start(selectedScreen.index, audioDevice);

  let url = `http://localhost:${port}`;
  if (config.tunnel) {
    tunnelInstance = new Tunnel();
    try {
      url = await tunnelInstance.start(port);
    } catch {
      // Tunnel failed, fall back to local URL
    }
  }

  status = {
    running: true,
    url,
    password,
    viewers: 0,
    maxViewers: config.maxViewers,
    hasAudio: audioDevice !== null,
    error: null,
  };

  server.onViewerCountChange((count) => {
    status.viewers = count;
    pushStatus();
  });

  server.onChat((sender, message) => {
    mainWindow?.webContents.send('stream:chat-message', { sender, message });
    if (Notification.isSupported()) {
      new Notification({ title: sender, body: message, silent: true }).show();
    }
  });

  pushStatus();
}

function stopStream(): void {
  capture?.stop();
  server?.close();
  tunnelInstance?.stop();
  capture = null;
  server = null;
  tunnelInstance = null;

  status = {
    ...status,
    running: false,
    url: null,
    password: null,
    viewers: 0,
    error: null,
  };
  pushStatus();
}

function getResourcesPath(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'resources');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 580,
    resizable: false,
    maximizable: false,
    icon: path.join(getResourcesPath(), 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
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
  const iconName =
    process.platform === 'darwin' ? 'trayTemplate.png' : 'trayTemplate.png';
  const iconPath = path.join(getResourcesPath(), iconName);

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
  server?.setChatEnabled(enabled);
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

ipcMain.handle('clipboard:copy', (_event, text: string) => {
  clipboard.writeText(text);
});

ipcMain.handle('system:check-readiness', async () => {
  return await checkReadiness();
});

ipcMain.handle('system:auto-setup', async (event) => {
  const sendProgress = (msg: string) => {
    event.sender.send('system:setup-progress', msg);
  };
  return await autoSetup(sendProgress);
});

// --- App Lifecycle ---

app.whenReady().then(() => {
  createTray();
  createWindow();

  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !status.running) {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopStream();
});
