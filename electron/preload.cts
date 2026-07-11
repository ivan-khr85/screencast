const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startStream: (config: Record<string, unknown>) =>
    ipcRenderer.invoke('stream:start', config),

  stopStream: () => ipcRenderer.invoke('stream:stop'),

  getStatus: () => ipcRenderer.invoke('stream:get-status'),

  listDevices: () => ipcRenderer.invoke('devices:list'),

  listAudioApps: () => ipcRenderer.invoke('audio:list-apps'),

  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:copy', text),

  setChat: (enabled: boolean) => ipcRenderer.invoke('stream:set-chat', enabled),

  setDebug: (enabled: boolean) => ipcRenderer.invoke('stream:set-debug', enabled),

  clearError: () => ipcRenderer.invoke('stream:clear-error'),

  sendChatMessage: (text: string) => ipcRenderer.invoke('stream:send-chat', text),

  checkReadiness: () => ipcRenderer.invoke('system:check-readiness'),

  getI18n: (): Promise<{ locale: string; resources: Record<string, { translation: unknown }> }> =>
    ipcRenderer.invoke('i18n:get'),

  autoSetup: () => ipcRenderer.invoke('system:auto-setup'),

  onSetupProgress: (callback: (msg: string) => void) => {
    ipcRenderer.on(
      'system:setup-progress',
      (_event: Electron.IpcRendererEvent, msg: string) => callback(msg),
    );
  },

  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => {
    ipcRenderer.on(
      'stream:status-update',
      (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) =>
        callback(status),
    );
  },

  onChatMessage: (callback: (msg: { sender: string; message: string }) => void) => {
    ipcRenderer.on(
      'stream:chat-message',
      (_event: Electron.IpcRendererEvent, msg: { sender: string; message: string }) =>
        callback(msg),
    );
  },

  // desktopCapturer isn't available in a sandboxed preload — the main
  // process enumerates sources via the screen:get-sources handler.
  getScreenSources: (): Promise<
    Array<{ index: string; id: string; name: string; thumbnail: string }>
  > => ipcRenderer.invoke('screen:get-sources'),

  setAdvancedOpen: (open: boolean): Promise<void> =>
    ipcRenderer.invoke('window:set-advanced', open),
});
