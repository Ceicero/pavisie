'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The window gets these few functions and nothing else: no Node, no file system, no cookies.
contextBridge.exposeInMainWorld('pavisie', {
  getState: () => ipcRenderer.invoke('app:state'),
  get: (path, query) => ipcRenderer.invoke('api:get', path, query),
  signIn: () => ipcRenderer.invoke('auth:sign-in'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  exportSnapshot: (snapshot) => ipcRenderer.invoke('snapshot:export', snapshot),
});
