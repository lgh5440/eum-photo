// Electron preload — renderer(앱)에 안전한 IPC API를 window.eum 으로 노출
// contextIsolation=true 환경에서 contextBridge로만 노출. fs/path 직접 노출 X.

const { contextBridge, ipcRenderer } = require('electron')

const watchListeners = new Map()  // watchId -> callback

ipcRenderer.on('eum:fs:watch:event', (_event, payload) => {
  const cb = watchListeners.get(payload.watchId)
  if (cb) cb(payload)
})

contextBridge.exposeInMainWorld('eum', {
  isElectron: true,
  ping: () => ipcRenderer.invoke('eum:ping'),
  pickDirectory: (options) => ipcRenderer.invoke('eum:pickDirectory', options),
  openInExplorer: (path) => ipcRenderer.invoke('eum:openInExplorer', path),
  fs: {
    ensureDir: (path) => ipcRenderer.invoke('eum:fs:ensureDir', path),
    readFile: (path) => ipcRenderer.invoke('eum:fs:readFile', path),
    writeFile: (path, data) => ipcRenderer.invoke('eum:fs:writeFile', path, data),
    listDir: (path) => ipcRenderer.invoke('eum:fs:listDir', path),
    remove: (path, options) => ipcRenderer.invoke('eum:fs:remove', path, options),
    emptyDir: (path) => ipcRenderer.invoke('eum:fs:emptyDir', path),
    exists: (path) => ipcRenderer.invoke('eum:fs:exists', path),
    stat: (path) => ipcRenderer.invoke('eum:fs:stat', path),
    watch: async (path, options, onEvent) => {
      const result = await ipcRenderer.invoke('eum:fs:watch', path, options)
      if (result.ok && result.watchId) {
        watchListeners.set(result.watchId, onEvent)
      }
      return result
    },
    unwatch: async (watchId) => {
      watchListeners.delete(watchId)
      return ipcRenderer.invoke('eum:fs:unwatch', watchId)
    },
  },
})
