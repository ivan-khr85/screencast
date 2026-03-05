import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  systemPreferences,
  shell,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { DEFAULTS } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StreamConfig {
  port: number;
  fps: number;
  bitrate: string;
  password: string;
  maxViewers: number;
  audio: boolean;
  tunnel: boolean;
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
            `${status.url}?p=${encodeURIComponent(status.password!)}`,
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

  server = new StreamServer(password, {
    port,
    maxViewers: config.maxViewers,
  });
  await server.listen(port);

  capture = new Capture({
    fps: config.fps,
    bitrate: config.bitrate,
    gopSize: config.fps,
  });
  capture.on('data', (chunk) => server!.pushData(chunk));
  capture.on('restart', () => server!.resetParser());
  capture.on('error', (err: Error) => {
    status.error = `FFmpeg: ${err.message}`;
    pushStatus();
  });
  capture.on('log', (msg: string) => {
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
