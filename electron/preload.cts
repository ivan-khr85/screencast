const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startStream: (config: Record<string, unknown>) =>
    ipcRenderer.invoke('stream:start', config),

  stopStream: () => ipcRenderer.invoke('stream:stop'),

  getStatus: () => ipcRenderer.invoke('stream:get-status'),

  listDevices: () => ipcRenderer.invoke('devices:list'),

  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:copy', text),

  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => {
    ipcRenderer.on(
      'stream:status-update',
      (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) =>
        callback(status),
    );
  },
});
