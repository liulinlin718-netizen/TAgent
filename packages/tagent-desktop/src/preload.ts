import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  windowControls: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.send('window-controls', action),
});
