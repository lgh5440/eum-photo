// Electron main process — 이음 포토 데스크탑
// CJS 변환 (Electron 36+ ESM main 로딩 버그 회피 — issue #47413).
// preload.cjs와 동일하게 CJS로 통일.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { existsSync, watch: fsWatch } = require('node:fs')

// EUM_FORCE_DIST=1 이면 dev 서버 무시하고 dist/index.html 을 file:// 로 직접 로드.
const FORCE_DIST = process.env.EUM_FORCE_DIST === '1'
const isDev = !app.isPackaged && !FORCE_DIST
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

let mainWindow = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '이음 포토',
    backgroundColor: '#FFF8EC',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL(DEV_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ===== IPC: 작업 폴더 / OS 통합 =====

ipcMain.handle('eum:ping', () => ({ ok: true, version: app.getVersion(), platform: process.platform }))

ipcMain.handle('eum:pickDirectory', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: options?.title || '작업 폴더 선택',
    defaultPath: options?.defaultPath,
  })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
})

ipcMain.handle('eum:openInExplorer', async (_event, targetPath) => {
  if (!targetPath) return { ok: false, reason: 'no path' }
  try {
    if (existsSync(targetPath)) {
      await shell.openPath(targetPath)
      return { ok: true }
    }
    return { ok: false, reason: 'not found' }
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) }
  }
})

// ===== IPC: fs (파일·디렉토리 직접 조작) =====

ipcMain.handle('eum:fs:ensureDir', async (_event, dirPath) => {
  await fs.mkdir(dirPath, { recursive: true })
  return { ok: true, path: dirPath }
})

ipcMain.handle('eum:fs:readFile', async (_event, filePath) => {
  const buf = await fs.readFile(filePath)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})

ipcMain.handle('eum:fs:writeFile', async (_event, filePath, data) => {
  let payload
  if (data instanceof Uint8Array) payload = Buffer.from(data)
  else if (data instanceof ArrayBuffer) payload = Buffer.from(new Uint8Array(data))
  else if (typeof data === 'string') payload = data
  else payload = Buffer.from(data)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, payload)
  return { ok: true }
})

ipcMain.handle('eum:fs:listDir', async (_event, dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const items = await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dirPath, e.name)
        let size = 0
        let mtime = 0
        if (e.isFile()) {
          try {
            const st = await fs.stat(full)
            size = st.size
            mtime = st.mtimeMs
          } catch {
            // ignore
          }
        }
        return {
          name: e.name,
          path: full,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          size,
          mtime,
        }
      }),
    )
    return { ok: true, items }
  } catch (err) {
    return { ok: false, items: [], reason: err?.message ?? String(err) }
  }
})

ipcMain.handle('eum:fs:remove', async (_event, targetPath, options) => {
  try {
    await fs.rm(targetPath, { recursive: !!options?.recursive, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
})

ipcMain.handle('eum:fs:emptyDir', async (_event, dirPath) => {
  try {
    if (!existsSync(dirPath)) return { ok: true }
    const entries = await fs.readdir(dirPath)
    await Promise.all(
      entries.map((name) =>
        fs.rm(path.join(dirPath, name), { recursive: true, force: true }).catch(() => {}),
      ),
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
})

ipcMain.handle('eum:fs:exists', async (_event, p) => existsSync(p))

ipcMain.handle('eum:fs:stat', async (_event, p) => {
  try {
    const st = await fs.stat(p)
    return {
      ok: true,
      size: st.size,
      mtime: st.mtimeMs,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
    }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
})

// 파일·디렉토리 rename
ipcMain.handle('eum:fs:rename', async (_event, oldPath, newPath) => {
  try {
    await fs.rename(oldPath, newPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
})

// 파일 복사
ipcMain.handle('eum:fs:copyFile', async (_event, srcPath, destPath) => {
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.copyFile(srcPath, destPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
})

// ===== Watcher: 폴더 변경 자동 감지 =====
const watchers = new Map()

ipcMain.handle('eum:fs:watch', async (event, dirPath, options) => {
  if (!existsSync(dirPath)) return { ok: false, reason: 'not found' }
  const watchId = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const recursive = !!options?.recursive
  let lastEmit = 0
  const debounceMs = options?.debounceMs ?? 500

  const watcher = fsWatch(dirPath, { recursive }, (eventType, filename) => {
    const now = Date.now()
    if (now - lastEmit < debounceMs) return
    lastEmit = now
    if (!event.sender.isDestroyed()) {
      event.sender.send('eum:fs:watch:event', { watchId, eventType, filename })
    }
  })

  watcher.on('error', (err) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('eum:fs:watch:event', { watchId, error: err.message })
    }
  })

  watchers.set(watchId, watcher)
  return { ok: true, watchId }
})

ipcMain.handle('eum:fs:unwatch', async (_event, watchId) => {
  const w = watchers.get(watchId)
  if (w) {
    try { w.close() } catch { /* ignore */ }
    watchers.delete(watchId)
  }
  return { ok: true }
})

app.on('before-quit', () => {
  for (const w of watchers.values()) {
    try { w.close() } catch { /* ignore */ }
  }
  watchers.clear()
})
