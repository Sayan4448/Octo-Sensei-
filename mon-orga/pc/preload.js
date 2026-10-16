// The only bridge between the page and the PC app: window.desktop, the same calls the phone app offers.
const { contextBridge, ipcRenderer } = require('electron')
const call = (name, ...args) => ipcRenderer.invoke(name, ...args)

contextBridge.exposeInMainWorld('desktop', {
  version: ipcRenderer.sendSync('version'),
  load: () => call('load'),
  save: doc => call('save', doc),
  loadSettings: () => call('loadSettings'),
  saveSettings: s => call('saveSettings', s),
  exportFile: (name, mime, text) => call('exportFile', name, mime, text),
  importFile: accept => call('importFile', accept),
  openUrl: url => call('openUrl', url),
  copy: text => call('copy', text),
  testAlarm: loud => call('testAlarm', loud),
  syncInfo: () => call('syncInfo'),
  syncConnect: (address, code) => call('syncConnect', address, code),
  syncScan: () => call('syncScan'),
  syncNow: () => call('syncNow'),
  syncForget: () => call('syncForget'),
  onChange: f => ipcRenderer.on('changed', () => f()),
  onAction: f => ipcRenderer.on('action', (e, a) => f(a)),
})
