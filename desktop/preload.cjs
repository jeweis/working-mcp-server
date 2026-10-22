'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workingDesktop', Object.freeze({
  request: payload => ipcRenderer.invoke('working:state', payload),
  credentials: () => ipcRenderer.invoke('working:credentials'),
  setApiKey: payload => ipcRenderer.invoke('working:key', payload),
  chooseDirectory: () => ipcRenderer.invoke('working:directory'),
  updates: (action,payload) => ipcRenderer.invoke('working:updates',action,payload),
  tunnel: (action, payload) => ipcRenderer.invoke('working:tunnel', action, payload),
  openGuide: target => ipcRenderer.invoke('working:guide', target),
  copyText: text => ipcRenderer.invoke('working:copy', text)
}));
