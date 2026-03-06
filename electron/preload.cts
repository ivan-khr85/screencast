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
});
