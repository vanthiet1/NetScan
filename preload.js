const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    scanNetwork: (params) => ipcRenderer.invoke('scan-network', params || {}),
    stopScan: () => ipcRenderer.invoke('stop-scan'),
    getDeviceInfo: (data) => ipcRenderer.invoke('get-device-info', data),
    getLocalInfo: () => ipcRenderer.invoke('get-local-info'),
    onScanProgress: (callback) => ipcRenderer.on('scan-progress', (event, data) => callback(data)),
    sendNotification: (data) => ipcRenderer.invoke('send-notification', data),
    storeGet: (key) => ipcRenderer.invoke('store-get', key),
    storeSet: (data) => ipcRenderer.invoke('store-set', data),
    isElectron: true
});
