import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Camera,
  Download,
  Eye,
  FolderInput,
  ImagePlus,
  Maximize2,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  UserRoundPlus,
  XCircle,
} from 'lucide-react'
import './App.css'

type PhotoStatus = 'keep' | 'featured' | 'public_candidate' | 'exclude'
type StatusFilter = PhotoStatus | 'all'
type FaceFilter = 'all' | 'has_face' | 'no_face' | 'not_scanned'
type WorkFolderAccess = 'checking' | 'none' | 'ready' | 'needs-permission' | 'loading' | 'error' | 'unsupported'

type FaceBox = {
  x: number
  y: number
  width: number
  height: number
}

type PhotoItem = {
  id: string
  file: File
  url: string
  name: string
  size: number
  modifiedAt: Date
  dateKey: string
  hash: string
  blurScore: number
  width: number
  height: number
  studentTags: string[]
  personFolderIds: string[]
  eventTag: string
  status: PhotoStatus
  faceCount: number | null
  faceBoxes: FaceBox[]
  faceScanStatus: 'idle' | 'done' | 'unsupported' | 'error'
  // 「복사」로 만들어진 사본인지 표시. true면 메인 그리드(hideSorted)에서 숨고,
  // 디스크 저장 시 「원본」 폴더에는 저장 X (정리/사람/ 폴더에만). 원본 photo는 그대로 메인에 유지.
  isAlias?: boolean
}

type PersonFolder = {
  id: string
  name: string
  parentId: string | null
  diskPhotoCount?: number
  representativePhotoId: string
  photoIds: string[]
  candidatePhotoIds: string[]
  candidateScores: Record<string, number>
}

type SavedPhotoState = {
  key: string
  name: string
  size: number
  modifiedAt: number
  dateKey: string
  eventTag: string
  studentTags: string[]
  status: PhotoStatus
  faceCount: number | null
  faceBoxes: FaceBox[]
  faceScanStatus: PhotoItem['faceScanStatus']
  // 캐시된 분석 결과 — 복원 시 재분석 회피
  hash?: string
  blurScore?: number
  width?: number
  height?: number
}

type SavedPersonFolder = {
  id: string
  name: string
  parentId?: string | null
  representativePhotoKey: string
  photoKeys: string[]
  candidatePhotoKeys: string[]
  candidateScoresByKey?: Record<string, number>
}

type ProjectSaveFile = {
  app: 'eum-photo'
  version: 1
  savedAt: string
  eventInput: string
  photos: SavedPhotoState[]
  personFolders: SavedPersonFolder[]
}

type SaveResult = {
  method: 'folder' | 'zip' | 'drive'
  rootName: string
  totalPhotos: number
  folderCounts: Record<string, number>
  locationHint: string
  savedAt: number
}

type ArchivedPlanSummary = {
  id: string
  savedAt: string
  eventName: string
  earliestDate: string
  photoCount: number
  peopleCounts: Record<string, number>
}

const ARCHIVE_STORAGE_KEY = 'eum-photo:cumulative-stats:v1'

type PlanPhotoRecord = {
  originalName: string
  suggestedFolder: string
  suggestedName: string
  students: string[]
  people: string[]
  event: string
  date: string
  status: PhotoStatus
  statusLabel: string
  duplicate: boolean
  blurScore: number
  size: number
  width: number
  height: number
  faceCount: number | null
  consent?: {
    state: 'all_yes' | 'has_no' | 'unknown' | 'partial'
    yes: string[]
    no: string[]
    unknown: string[]
  }
}

type PlanExportFile = {
  app: 'eum-photo'
  type: 'plan'
  version: 1
  exportedAt: string
  event: {
    name: string
    earliestDate: string
    photoCount: number
  }
  people: Array<{
    name: string
    photoCount: number
    representativeOriginalName: string
  }>
  rosterMatch?: {
    rosterSize: number
    covered: Array<{ name: string; count: number }>
    uncovered: Array<{ name: string; count: number }>
    orphanTags: Array<{ name: string; count: number }>
  }
  photos: PlanPhotoRecord[]
}

type AnalysisResult = Pick<PhotoItem, 'hash' | 'blurScore' | 'width' | 'height'>

type FaceDetectorConstructor = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
  detect: (source: ImageBitmapSource) => Promise<Array<{ boundingBox?: DOMRectReadOnly }>>
}

type WritableFileStreamHandle = {
  write: (data: Blob | BufferSource | string) => Promise<void>
  close: () => Promise<void>
}

type WritableFileHandle = {
  kind?: 'file'
  name?: string
  createWritable: () => Promise<WritableFileStreamHandle>
  getFile?: () => Promise<File>
}

type WritableDirectoryHandle = {
  name: string
  kind?: 'directory'
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<WritableDirectoryHandle>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandle>
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>
  entries?: () => AsyncIterableIterator<[string, WritableDirectoryHandle | WritableFileHandle]>
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>
}

type GoogleTokenResponse = { access_token: string; expires_in: number; error?: string }
type GoogleTokenClient = {
  callback: (response: GoogleTokenResponse) => void
  requestAccessToken: (overrideOptions?: { prompt?: string }) => void
}

// Electron preload (electron/preload.cjs) 가 contextBridge 로 노출하는 API.
// Web 환경에서는 undefined — `window.eum?.isElectron` 으로 분기 가능.
type EumFsListItem = {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  size: number
  mtime: number
}
type EumFsListResult = { ok: boolean; items: EumFsListItem[]; reason?: string }
type EumFsStatResult =
  | { ok: true; size: number; mtime: number; isFile: boolean; isDirectory: boolean }
  | { ok: false; reason: string }
type EumWatchResult = { ok: boolean; watchId?: string; reason?: string }
type EumWatchEvent = { watchId: string; eventType?: string; filename?: string | null; error?: string }

type EumElectronApi = {
  isElectron: true
  ping: () => Promise<{ ok: boolean; version: string; platform: string }>
  pickDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openInExplorer: (path: string) => Promise<{ ok: boolean; reason?: string }>
  fs: {
    ensureDir: (path: string) => Promise<{ ok: boolean; path: string }>
    readFile: (path: string) => Promise<ArrayBuffer>
    writeFile: (path: string, data: ArrayBuffer | Uint8Array | string) => Promise<{ ok: boolean }>
    listDir: (path: string) => Promise<EumFsListResult>
    remove: (path: string, options?: { recursive?: boolean }) => Promise<{ ok: boolean; reason?: string }>
    emptyDir: (path: string) => Promise<{ ok: boolean; reason?: string }>
    exists: (path: string) => Promise<boolean>
    stat: (path: string) => Promise<EumFsStatResult>
    watch: (
      path: string,
      options: { recursive?: boolean; debounceMs?: number } | undefined,
      onEvent: (e: EumWatchEvent) => void,
    ) => Promise<EumWatchResult>
    unwatch: (watchId: string) => Promise<{ ok: boolean }>
  }
}

declare global {
  interface Window {
    FaceDetector?: FaceDetectorConstructor
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<WritableDirectoryHandle>
    eum?: EumElectronApi
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: GoogleTokenResponse) => void
          }) => GoogleTokenClient
        }
      }
    }
  }
}

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GOOGLE_GSI_SRC = 'https://accounts.google.com/gsi/client'

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-eum-script="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve()
      else {
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error(`script load failed: ${src}`)), { once: true })
      }
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.defer = true
    script.dataset.eumScript = src
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    })
    script.addEventListener('error', () => reject(new Error(`script load failed: ${src}`)))
    document.head.appendChild(script)
  })
}

async function requestGoogleAccessToken(clientId: string): Promise<string> {
  await loadScriptOnce(GOOGLE_GSI_SRC)
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) throw new Error('Google Identity Services를 불러오지 못했습니다.')

  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        if (response.error) reject(new Error(response.error))
        else if (response.access_token) resolve(response.access_token)
        else reject(new Error('access token이 비어 있습니다.'))
      },
    })
    client.requestAccessToken()
  })
}

async function driveCreateFolder(token: string, name: string, parentId?: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  })
  if (!response.ok) throw new Error(`Drive 폴더 생성 실패 (${response.status})`)
  const json = (await response.json()) as { id: string }
  return json.id
}

async function driveUploadFile(
  token: string,
  parentId: string,
  filename: string,
  mimeType: string,
  body: Blob | string,
): Promise<void> {
  const metadata = { name: filename, parents: [parentId] }
  const boundary = `eum-photo-${crypto.randomUUID()}`
  const blob = typeof body === 'string' ? new Blob([body], { type: mimeType }) : body
  const arrayBuffer = await blob.arrayBuffer()
  const encoder = new TextEncoder()
  const part1 = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  )
  const part3 = encoder.encode(`\r\n--${boundary}--`)
  const multipart = new Blob([part1, arrayBuffer, part3])

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  })
  if (!response.ok) throw new Error(`Drive 업로드 실패: ${filename} (${response.status})`)
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
const BLUR_THRESHOLD = 18
const STATUS_OPTIONS: Array<{
  value: PhotoStatus
  label: string
  shortLabel: string
  description: string
  icon: typeof Archive
}> = [
  { value: 'keep', label: '쓸 사진', shortLabel: '쓸 사진', description: '나중에 쓸 수도 있는 보통 사진', icon: Archive },
  { value: 'featured', label: '잘 나온 사진', shortLabel: '잘 나옴', description: '가장 잘 찍힌 사진 (대표 사진)', icon: Star },
  { value: 'public_candidate', label: '단톡방 OK', shortLabel: '공유 OK', description: '학부모 단톡방·교회 카페에 올려도 되는 사진', icon: Eye },
  { value: 'exclude', label: '안 쓸 사진', shortLabel: '안 씀', description: '흐림·불필요·민감 — 결과물에서 빼는 사진', icon: XCircle },
]
const STATUS_LABELS = new Map(STATUS_OPTIONS.map((option) => [option.value, option.label]))
const STATUS_FOLDER_LABELS: Record<PhotoStatus, string> = {
  keep: '내부보관',
  featured: '대표사진',
  public_candidate: '공개후보',
  exclude: '제외검토',
}
const CANDIDATE_DISTANCE_LIMIT = 82

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function isUnassignedFolderName(value: string) {
  return UNASSIGNED_FOLDER_NAMES.has(normalizeTag(value).toLowerCase())
}

function csvEscape(value: string | number) {
  const raw = String(value)
  return `"${raw.replace(/"/g, '""')}"`
}

function safePathSegment(value: string) {
  return normalizeTag(value)
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/\.+$/g, '')
    .slice(0, 80) || '미지정'
}

function getFileExtension(filename: string) {
  const match = filename.match(/\.([a-zA-Z0-9]+)$/)
  return match?.[1]?.toLowerCase() || 'jpg'
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function getHashDistance(first: string, second: string) {
  const limit = Math.min(first.length, second.length)
  let distance = Math.abs(first.length - second.length)

  for (let index = 0; index < limit; index += 1) {
    if (first[index] !== second[index]) distance += 1
  }

  return distance
}

async function analyzeImage(file: File): Promise<AnalysisResult> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    bitmap = await createImageBitmap(file)
  }
  const width = bitmap.width
  const height = bitmap.height
  const sampleSize = 16
  const canvas = document.createElement('canvas')
  canvas.width = sampleSize
  canvas.height = sampleSize
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  if (!ctx) {
    bitmap.close()
    return { hash: file.name, blurScore: 0, width: 0, height: 0 }
  }

  ctx.drawImage(bitmap, 0, 0, sampleSize, sampleSize)
  const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data
  const grays: number[] = []

  for (let index = 0; index < data.length; index += 4) {
    grays.push(Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114))
  }

  const average = grays.reduce((sum, value) => sum + value, 0) / grays.length
  const hash = grays.map((value) => (value >= average ? '1' : '0')).join('')
  let edgeTotal = 0
  let edgeCount = 0

  for (let row = 1; row < sampleSize - 1; row += 1) {
    for (let col = 1; col < sampleSize - 1; col += 1) {
      const center = grays[row * sampleSize + col]
      const right = grays[row * sampleSize + col + 1]
      const bottom = grays[(row + 1) * sampleSize + col]
      edgeTotal += Math.abs(center - right) + Math.abs(center - bottom)
      edgeCount += 2
    }
  }

  bitmap.close()
  return {
    hash,
    blurScore: Math.round(edgeTotal / Math.max(1, edgeCount)),
    width,
    height,
  }
}

function downloadText(filename: string, body: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([body], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function getPhotoStorageKey(photo: Pick<PhotoItem, 'name' | 'size' | 'modifiedAt'>) {
  return `${photo.name}|${photo.size}|${photo.modifiedAt.getTime()}`
}

const PHOTO_BLOB_DB = 'eum-photo-blobs'
const PHOTO_BLOB_STORE = 'photos'
const PROJECT_AUTOSAVE_KEY = 'eum-photo:autosave:v1'
const FOLDERS_TREE_KEY = 'eum-photo:folders-tree:v1'
const SAVED_FOLDER_HANDLE_KEY = 'savedFolderHandle'
const SAVED_FOLDER_NAME_KEY = 'savedFolderName'
// Electron 데스크탑 모드 — 작업 폴더의 OS 절대 경로 (Web FS handle 대신 사용)
const SAVED_FOLDER_PATH_KEY = 'savedFolderPath'
const WORK_ROOT_DIR = 'EUM-Photo'
const ORIGINAL_DIR = '원본'
const ORGANIZED_DIR = '정리'
const INTERNAL_KEEP_DIR = '내부보관'
const UNASSIGNED_FOLDER_NAMES = new Set(['미지정', '미분류', '미배정', '없음', 'unknown', 'unassigned'])

type SavedFolderTreeEntry = {
  id: string
  name: string
  parentId: string | null
  diskPhotoCount?: number
}

function loadFolderTreeFromLocal(): PersonFolder[] {
  try {
    const raw = localStorage.getItem(FOLDERS_TREE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as SavedFolderTreeEntry[])
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string')
      .filter((entry) => !isUnassignedFolderName(entry.name))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        parentId: entry.parentId ?? null,
        diskPhotoCount: entry.diskPhotoCount ?? 0,
        representativePhotoId: '',
        photoIds: [],
        candidatePhotoIds: [],
        candidateScores: {},
      }))
  } catch {
    return []
  }
}

function openPhotoBlobDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_BLOB_DB, 1)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PHOTO_BLOB_STORE)) {
        req.result.createObjectStore(PHOTO_BLOB_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
  })
}

async function putPhotoBlob(key: string, file: File) {
  const db = await openPhotoBlobDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PHOTO_BLOB_STORE, 'readwrite')
    tx.objectStore(PHOTO_BLOB_STORE).put({
      key,
      name: file.name,
      type: file.type,
      modifiedAt: file.lastModified,
      blob: file,
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

type StoredBlobInfo = { blob: Blob; name: string; type: string; modifiedAt: number }

async function getAllPhotoBlobs(): Promise<Map<string, StoredBlobInfo>> {
  const db = await openPhotoBlobDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_BLOB_STORE, 'readonly')
    const req = tx.objectStore(PHOTO_BLOB_STORE).getAll()
    req.onsuccess = () => {
      const map = new Map<string, StoredBlobInfo>()
      for (const item of req.result as Array<StoredBlobInfo & { key: string }>) {
        map.set(item.key, { blob: item.blob, name: item.name, type: item.type, modifiedAt: item.modifiedAt })
      }
      resolve(map)
    }
    req.onerror = () => reject(req.error)
  })
}

async function getPhotoBlob(key: string): Promise<Blob | null> {
  const db = await openPhotoBlobDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_BLOB_STORE, 'readonly')
    const req = tx.objectStore(PHOTO_BLOB_STORE).get(key)
    req.onsuccess = () => {
      const item = req.result as (StoredBlobInfo & { key: string }) | undefined
      resolve(item ? item.blob : null)
    }
    req.onerror = () => reject(req.error)
  })
}

async function deletePhotoBlobsFromIDB(keys: string[]) {
  if (!keys.length) return
  const db = await openPhotoBlobDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PHOTO_BLOB_STORE, 'readwrite')
    const store = tx.objectStore(PHOTO_BLOB_STORE)
    for (const key of keys) store.delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

const APP_META_DB = 'eum-photo-meta'
const APP_META_STORE = 'meta'

function openMetaDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(APP_META_DB, 1)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(APP_META_STORE)) {
        req.result.createObjectStore(APP_META_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
  })
}

async function putMeta<T>(key: string, value: T): Promise<void> {
  const db = await openMetaDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_META_STORE, 'readwrite')
    tx.objectStore(APP_META_STORE).put({ key, value })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function getMeta<T>(key: string): Promise<T | null> {
  const db = await openMetaDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_META_STORE, 'readonly')
    const req = tx.objectStore(APP_META_STORE).get(key)
    req.onsuccess = () => resolve((req.result?.value as T) ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function deleteMeta(key: string): Promise<void> {
  const db = await openMetaDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_META_STORE, 'readwrite')
    tx.objectStore(APP_META_STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function verifyDirectoryPermission(handle: WritableDirectoryHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true
  const opts = { mode: 'readwrite' as const }
  let perm = await handle.queryPermission(opts)
  if (perm === 'granted') return true
  perm = await handle.requestPermission(opts)
  return perm === 'granted'
}

async function queryDirectoryPermissionGranted(handle: WritableDirectoryHandle): Promise<boolean> {
  if (!handle.queryPermission) return true
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' as const })
    return perm === 'granted'
  } catch {
    return false
  }
}

function displayFolderName(name: string): string {
  const trimmed = (name ?? '').replace(/[\\/]+$/, '').trim()
  if (!trimmed || trimmed === '\\' || trimmed === '/') return '선택한 위치'
  return trimmed
}

function mergePersonFoldersByName(current: PersonFolder[], incoming: PersonFolder[]) {
    const merged = current.filter((folder) => !isUnassignedFolderName(folder.name))
  const indexByName = new Map(merged.map((folder, index) => [folder.name, index]))
  const indexById = new Map(merged.map((folder, index) => [folder.id, index]))

  for (const folder of incoming) {
    const existingIndex = indexById.get(folder.id) ?? indexByName.get(folder.name)
    if (existingIndex === undefined) {
      merged.push(folder)
      indexByName.set(folder.name, merged.length - 1)
      indexById.set(folder.id, merged.length - 1)
      continue
    }

    const existing = merged[existingIndex]
    merged[existingIndex] = {
      ...existing,
      ...folder,
      id: existing.id,
      name: existing.name,
      parentId: existing.parentId ?? folder.parentId ?? null,
      diskPhotoCount: folder.diskPhotoCount ?? existing.diskPhotoCount ?? 0,
      representativePhotoId: folder.representativePhotoId || existing.representativePhotoId,
      photoIds: [...new Set([...existing.photoIds, ...folder.photoIds])],
      candidatePhotoIds: [...new Set([...existing.candidatePhotoIds, ...folder.candidatePhotoIds])],
      candidateScores: { ...existing.candidateScores, ...folder.candidateScores },
    }
  }

  return merged.filter((folder) => !isUnassignedFolderName(folder.name))
}

async function getDirectoryIfExists(parent: WritableDirectoryHandle, name: string) {
  try {
    return await parent.getDirectoryHandle(name, { create: false })
  } catch {
    return null
  }
}

async function resolveInternalKeepDirectory(root: WritableDirectoryHandle) {
  const candidates: string[][] = [
    [WORK_ROOT_DIR, ORGANIZED_DIR, INTERNAL_KEEP_DIR],
    [ORGANIZED_DIR, INTERNAL_KEEP_DIR],
    [INTERNAL_KEEP_DIR],
    [],
  ]

  for (const path of candidates) {
    let current: WritableDirectoryHandle | null = root
    for (const segment of path) {
      current = current ? await getDirectoryIfExists(current, segment) : null
      if (!current) break
    }
    if (current && (path.length > 0 || current.name === INTERNAL_KEEP_DIR)) {
      return current
    }
  }

  return null
}

async function listChildDirectoryNames(directory: WritableDirectoryHandle) {
  const names: string[] = []
  if (!directory.entries) return names
  for await (const [name, child] of directory.entries()) {
    if (child.kind === 'directory') names.push(name)
  }
  return names.sort((a, b) => a.localeCompare(b, 'ko'))
}

function isImageFilename(name: string) {
  return /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(name)
}

async function countImageFiles(directory: WritableDirectoryHandle): Promise<number> {
  if (!directory.entries) return 0
  let count = 0
  for await (const [name, child] of directory.entries()) {
    if (child.kind === 'file' && isImageFilename(name)) {
      count += 1
    }
  }
  return count
}

async function listChildDirectorySummaries(directory: WritableDirectoryHandle) {
  const summaries: Array<{ name: string; files: File[] }> = []
  if (!directory.entries) return summaries
  for await (const [name, child] of directory.entries()) {
    if (child.kind !== 'directory') continue
    const normalized = normalizeTag(name)
    if (!normalized || isUnassignedFolderName(normalized)) continue
    const files: File[] = []
    if ((child as WritableDirectoryHandle).entries) {
      for await (const [filename, fileChild] of (child as WritableDirectoryHandle).entries!()) {
        if (fileChild.kind === 'file' && isImageFilename(filename) && (fileChild as WritableFileHandle).getFile) {
          files.push(await (fileChild as WritableFileHandle).getFile!())
        }
      }
    }
    summaries.push({
      name: normalized,
      files,
    })
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

async function clearAllPhotoBlobs() {
  const db = await openPhotoBlobDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PHOTO_BLOB_STORE, 'readwrite')
    tx.objectStore(PHOTO_BLOB_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function parseCsvLine(line: string) {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const nextChar = line[index + 1]

    if (char === '"' && nextChar === '"') {
      current += '"'
      index += 1
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }

  cells.push(current)
  return cells.map(normalizeTag)
}

type ConsentState = 'yes' | 'no' | 'unknown'

function parseConsentValue(value: string): ConsentState {
  const cell = value.trim().toLowerCase()
  if (!cell) return 'unknown'
  if (/^(y|yes|true|1|동의|예|허용|허락|o|ㅇ)$/.test(cell)) return 'yes'
  if (/^(n|no|false|0|미동의|아니오|거부|불허|x|ㄴ)$/.test(cell)) return 'no'
  return 'unknown'
}

function parseRoster(text: string): { names: string[]; consent: Record<string, ConsentState> } {
  const rows = text
    .split(/\r?\n/)
    .map((line) => parseCsvLine(line))
    .filter((row) => row.some(Boolean))

  if (!rows.length) return { names: [], consent: {} }

  const headerIndex = rows.findIndex((row) => row.some((cell) => /^(이름|성명|학생명|name)$/i.test(cell)))
  const headerRow = headerIndex >= 0 ? rows[headerIndex] : null
  const nameColumnIndex = headerRow?.findIndex((cell) => /^(이름|성명|학생명|name)$/i.test(cell)) ?? 0
  const consentColumnIndex =
    headerRow?.findIndex((cell) => /^(공개동의|공개 동의|초상권|초상권 동의|consent|공개여부)$/i.test(cell)) ?? -1
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows
  const namesInOrder: string[] = []
  const consent: Record<string, ConsentState> = {}

  dataRows.forEach((row) => {
    const name = normalizeTag(row[nameColumnIndex] ?? row.find(Boolean) ?? '')
    if (!name || name.length > 40) return
    if (!namesInOrder.includes(name)) namesInOrder.push(name)
    if (consentColumnIndex >= 0) {
      consent[name] = parseConsentValue(row[consentColumnIndex] ?? '')
    }
  })

  return { names: namesInOrder, consent }
}

async function getOrCreateDirectory(root: WritableDirectoryHandle, segments: string[]) {
  let current = root

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true })
  }

  return current
}

async function writeFileToDirectory(directory: WritableDirectoryHandle, filename: string, data: Blob | BufferSource | string) {
  const fileHandle = await directory.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(data)
  await writable.close()
}

// 디렉토리 안 모든 항목 (파일·하위 폴더) 삭제. 디렉토리 자체는 유지.
async function emptyDirectory(directory: WritableDirectoryHandle): Promise<void> {
  if (!directory.entries || !directory.removeEntry) return
  const names: string[] = []
  for await (const [name] of directory.entries()) {
    names.push(name)
  }
  await Promise.all(
    names.map((name) =>
      directory.removeEntry!(name, { recursive: true }).catch(() => {
        // 잠긴 파일·권한 등은 조용히 무시
      }),
    ),
  )
}

// 작업을 N개씩 묶어 동시에 실행 (브라우저 동시 I/O 한계 고려)
async function runInBatches<T>(items: T[], batchSize: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += batchSize) {
    const slice = items.slice(start, start + batchSize)
    await Promise.all(slice.map((item, j) => worker(item, start + j)))
  }
}

async function readPhotoBuffer(photo: PhotoItem) {
  // 1순위: photo.file (메모리 상의 File 객체)
  try {
    return await photo.file.arrayBuffer()
  } catch (fileError) {
    // 2순위: blob: URL (같은 객체에 묶여있어 보통 같이 무효화되지만 시도)
    try {
      const response = await fetch(photo.url)
      if (response.ok) return await response.arrayBuffer()
    } catch {
      // fall through
    }
    // 3순위: IndexedDB에 보관된 원본 Blob (import 시 자동 저장됨)
    try {
      const stored = await getPhotoBlob(getPhotoStorageKey(photo))
      if (stored) return await stored.arrayBuffer()
    } catch {
      // fall through
    }
    throw new Error(
      `「${photo.name}」 파일을 읽을 수 없습니다. 「작업 폴더 열기」로 사진을 다시 불러온 뒤 저장해 주세요.`,
      { cause: fileError },
    )
  }
}

type SingleModeStageProps = {
  photo: PhotoItem
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
  onClassify: (status: PhotoStatus, label: string) => void
  rosterNames: string[]
  rosterConsent: Record<string, ConsentState>
  onQuickTag: (name: string) => void
  consent: { yes: string[]; no: string[]; unknown: string[] } | undefined
}

function SingleModeStage({
  photo,
  index,
  total,
  onPrev,
  onNext,
  onClassify,
  rosterNames,
  rosterConsent,
  onQuickTag,
  consent,
}: SingleModeStageProps) {
  const progressPercent = total > 0 ? Math.round(((index + 1) / total) * 100) : 0
  const isLast = index >= total - 1
  const consentDenied = consent && consent.no.length > 0
  const consentUnknown = consent && !consent.no.length && consent.unknown.length > 0 && !consent.yes.length
  const shownTags = photo.studentTags

  return (
    <div className="single-mode-stage">
      <div className="single-mode-progress">
        <strong>
          {index + 1} / {total}
        </strong>
        <div className="single-mode-progress-bar">
          <div className="single-mode-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <span>{progressPercent}%</span>
      </div>
      <div className="single-mode-photo">
        <img src={photo.url} alt={photo.name} />
        {consentDenied && (
          <div className="single-mode-consent-warning">⚠ 단톡방 공유 안 됨: {consent.no.join(', ')}</div>
        )}
        {!consentDenied && consentUnknown && (
          <div className="single-mode-consent-soft">동의 확인 필요: {consent.unknown.join(', ')}</div>
        )}
      </div>
      <div className="single-mode-tags">
        <strong>이 사진에 누가 있나요?</strong>
        {shownTags.length > 0 && (
          <div className="single-mode-current-tags">
            {shownTags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        {rosterNames.length > 0 ? (
          <div className="single-mode-roster">
            {rosterNames.map((name) => {
              const consentState = rosterConsent[name]
              const already = shownTags.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => onQuickTag(name)}
                  disabled={already}
                  className={
                    already
                      ? 'roster-chip-covered'
                      : consentState === 'no'
                      ? 'consent-no'
                      : consentState === 'unknown'
                      ? 'consent-unknown'
                      : ''
                  }
                  title={already ? '이미 추가된 이름' : `「${name}」 태그 추가`}
                >
                  {already ? '✓ ' : ''}
                  {name}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="single-mode-roster-hint">
            학생 명단을 불러오면 여기서 한 번에 태그할 수 있어요.
          </p>
        )}
      </div>
      <div className="single-mode-actions">
        <button type="button" className="single-mode-keep" onClick={() => onClassify('keep', '쓸 사진')}>
          <Archive size={28} />
          <span>쓸 사진</span>
          <small>나중에 쓸 수도 있는 사진</small>
        </button>
        <button type="button" className="single-mode-exclude" onClick={() => onClassify('exclude', '안 쓸 사진')}>
          <XCircle size={28} />
          <span>안 쓸 사진</span>
          <small>흐림·불필요 — 결과에서 빠짐</small>
        </button>
      </div>
      <div className="single-mode-actions-secondary">
        <button type="button" onClick={() => onClassify('featured', '잘 나온 사진')}>
          <Star size={20} />
          <span>잘 나온 사진</span>
        </button>
        <button type="button" onClick={() => onClassify('public_candidate', '단톡방 OK')}>
          <Eye size={20} />
          <span>단톡방 OK</span>
        </button>
      </div>
      <div className="single-mode-nav">
        <button type="button" onClick={onPrev} disabled={index <= 0} title="이전 사진">
          <ArrowLeft size={18} />
          이전
        </button>
        <span className="single-mode-current-status">현재: {STATUS_LABELS.get(photo.status) ?? photo.status}</span>
        <button type="button" onClick={onNext} disabled={isLast} title="다음 사진 (분류 안 하고 넘김)">
          건너뛰기
          <ArrowRight size={18} />
        </button>
      </div>
    </div>
  )
}

function App() {
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [personNameInput, setPersonNameInput] = useState('')
  const [personFolders, setPersonFolders] = useState<PersonFolder[]>(() => loadFolderTreeFromLocal())
  const [rosterNames, setRosterNames] = useState<string[]>([])
  const [rosterConsent, setRosterConsent] = useState<Record<string, ConsentState>>({})
  const [rosterMessage, setRosterMessage] = useState('')
  const [eventInput, setEventInput] = useState('')
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [faceFilter, setFaceFilter] = useState<FaceFilter>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null)
  const [viewerPhotoId, setViewerPhotoId] = useState<string | null>(null)
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState({ done: 0, total: 0 })
  const [isZipping, setIsZipping] = useState(false)
  const [isFolderSaving, setIsFolderSaving] = useState(false)
  const [isDriveSaving, setIsDriveSaving] = useState(false)
  const [isPlanMenuOpen, setIsPlanMenuOpen] = useState(false)
  const planMenuRef = useRef<HTMLDivElement | null>(null)
  const [isResultModalOpen, setIsResultModalOpen] = useState(false)
  const [isSingleMode, setIsSingleMode] = useState(false)
  const GRID_ZOOM_SIZES = [120, 140, 160, 180, 200, 240, 280, 340, 420, 520] as const
  const [gridZoom, setGridZoom] = useState(3)
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(new Set())
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [folderContextMenu, setFolderContextMenu] = useState<{ folderId: string; x: number; y: number } | null>(null)
  const [photoContextMenu, setPhotoContextMenu] = useState<{ photoId: string; x: number; y: number } | null>(null)
  const [savedFolderHandle, setSavedFolderHandle] = useState<WritableDirectoryHandle | null>(null)
  // Electron mode: OS 절대 경로 (Web FS handle 대신 모든 IO에 사용)
  const [savedFolderPath, setSavedFolderPath] = useState<string>('')
  const [savedFolderName, setSavedFolderName] = useState<string>('')
  const [workFolderAccess, setWorkFolderAccess] = useState<WorkFolderAccess>('checking')
  const [workFolderHint, setWorkFolderHint] = useState('최근 작업 폴더를 확인하는 중입니다.')
  const [saveMethod, setSaveMethod] = useState<'local' | 'drive'>('local')
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(true)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [folderDrillIn, setFolderDrillIn] = useState<{ folderId: string; mode: 'photos' | 'candidates' } | null>(null)
  const [hideSorted, setHideSorted] = useState(true)
  const [undoSnapshot, setUndoSnapshot] = useState<{
    photos: PhotoItem[]
    personFolders: PersonFolder[]
    label: string
  } | null>(null)
  const [isFaceScanning, setIsFaceScanning] = useState(false)
  const [, setFaceScanMessage] = useState('')
  const [projectMessage, setProjectMessage] = useState('')
  const [archivedPlans, setArchivedPlans] = useState<ArchivedPlanSummary[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const raw = window.localStorage.getItem(ARCHIVE_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (entry): entry is ArchivedPlanSummary =>
          Boolean(entry) && typeof entry.id === 'string' && typeof entry.peopleCounts === 'object',
      )
    } catch {
      return []
    }
  })
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const projectInputRef = useRef<HTMLInputElement | null>(null)
  const rosterInputRef = useRef<HTMLInputElement | null>(null)
  const importedWorkPhotoKeysRef = useRef<Set<string>>(new Set())
  const activeIndex = photos.findIndex((photo) => photo.id === activePhotoId)
  const activePhoto = activeIndex >= 0 ? photos[activeIndex] : null
  const viewerIndex = photos.findIndex((photo) => photo.id === viewerPhotoId)
  const viewerPhoto = viewerIndex >= 0 ? photos[viewerIndex] : null
  const personFolderById = useMemo(
    () => new Map(personFolders.map((folder) => [folder.id, folder])),
    [personFolders],
  )

  const duplicateHashes = useMemo(() => {
    const counts = new Map<string, number>()
    photos.forEach((photo) => counts.set(photo.hash, (counts.get(photo.hash) ?? 0) + 1))
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([hash]) => hash))
  }, [photos])

  const stats = useMemo(() => {
    const dates = new Set(photos.map((photo) => photo.dateKey))
    const duplicates = photos.filter((photo) => duplicateHashes.has(photo.hash)).length
    const blurry = photos.filter((photo) => photo.blurScore < BLUR_THRESHOLD).length
    const tagged = photos.filter((photo) => photo.studentTags.length > 0).length
    const featured = photos.filter((photo) => photo.status === 'featured').length
    const excluded = photos.filter((photo) => photo.status === 'exclude').length
    const peopleAssigned = photos.filter((photo) => photo.personFolderIds.length > 0).length
    const facePhotos = photos.filter((photo) => (photo.faceCount ?? 0) > 0).length

    return { dates: dates.size, duplicates, blurry, tagged, featured, excluded, peopleAssigned, facePhotos }
  }, [duplicateHashes, photos])

  const rosterMatch = useMemo(() => {
    const counts = new Map<string, number>()
    const allTagSet = new Set<string>()

    photos.forEach((photo) => {
      const seen = new Set<string>()
      photo.studentTags.forEach((tag) => seen.add(tag))
      photo.personFolderIds.forEach((folderId) => {
        const name = personFolderById.get(folderId)?.name
        if (name) seen.add(name)
      })
      seen.forEach((name) => {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        allTagSet.add(name)
      })
    })

    const rosterSet = new Set(rosterNames)
    const entries = rosterNames.map((name) => ({ name, count: counts.get(name) ?? 0 }))
    const covered = entries.filter((entry) => entry.count > 0)
    const uncovered = entries.filter((entry) => entry.count === 0)
    const orphanTags = [...allTagSet]
      .filter((name) => !rosterSet.has(name))
      .map((name) => ({ name, count: counts.get(name) ?? 0 }))
      .sort((a, b) => b.count - a.count)

    return { entries, covered, uncovered, orphanTags, hasRoster: rosterNames.length > 0 }
  }, [personFolderById, photos, rosterNames])

  const photoConsentByPhotoId = useMemo(() => {
    const result = new Map<string, { yes: string[]; no: string[]; unknown: string[] }>()
    if (!Object.keys(rosterConsent).length) return result

    photos.forEach((photo) => {
      const names = new Set<string>([
        ...photo.studentTags,
        ...photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter((name): name is string => Boolean(name)),
      ])
      if (!names.size) return

      const buckets = { yes: [] as string[], no: [] as string[], unknown: [] as string[] }
      names.forEach((name) => {
        const state = rosterConsent[name]
        if (state === 'yes') buckets.yes.push(name)
        else if (state === 'no') buckets.no.push(name)
        else if (state === 'unknown') buckets.unknown.push(name)
      })

      if (buckets.yes.length || buckets.no.length || buckets.unknown.length) {
        result.set(photo.id, buckets)
      }
    })

    return result
  }, [personFolderById, photos, rosterConsent])

  const sortedCount = useMemo(
    () => photos.filter((photo) => photo.status !== 'keep' || photo.studentTags.length > 0 || photo.personFolderIds.length > 0).length,
    [photos],
  )

  const workflowSteps = useMemo(() => {
    const hasPhotos = photos.length > 0
    const hasEvent = Boolean(normalizeTag(eventInput))
    const allSorted = hasPhotos && sortedCount === photos.length
    const sortStarted = sortedCount > 0
    const photoStep = hasPhotos ? 'done' : 'active'
    const eventStep = !hasPhotos ? 'idle' : hasEvent ? 'done' : 'active'
    const sortStep = !hasPhotos
      ? 'idle'
      : !hasEvent
      ? 'idle'
      : allSorted
      ? 'done'
      : sortStarted
      ? 'active'
      : 'active'
    const resultStep = allSorted && hasEvent ? 'active' : 'idle'

    return [
      {
        key: 'photos',
        label: '사진 추가',
        hint: hasPhotos ? `${photos.length}장 추가됨` : '사진을 끌어오세요',
        state: photoStep as 'idle' | 'active' | 'done',
      },
      {
        key: 'event',
        label: '행사명',
        hint: hasEvent ? `「${normalizeTag(eventInput)}」` : '행사명을 적어 주세요',
        state: eventStep as 'idle' | 'active' | 'done',
      },
      {
        key: 'sort',
        label: '사진 분류',
        hint: hasPhotos ? `${sortedCount}/${photos.length}장 분류됨` : '아직',
        state: sortStep as 'idle' | 'active' | 'done',
      },
      {
        key: 'result',
        label: '결과 받기',
        hint: resultStep === 'active' ? '준비 완료' : '분류 끝나면',
        state: resultStep as 'idle' | 'active' | 'done',
      },
    ]
  }, [eventInput, photos.length, sortedCount])

  const reviewIssues = useMemo(() => {
    return photos
      .flatMap((photo) => {
        const labels: string[] = []
        const hasName = photo.studentTags.length > 0 || photo.personFolderIds.length > 0

        if (photo.status === 'public_candidate' && !hasName) labels.push('공유 사진에 이름이 안 적혀 있어요')
        if (photo.status === 'featured' && photo.blurScore < BLUR_THRESHOLD) labels.push('잘 나온 사진인데 흐릿해요')
        if (photo.status === 'featured' && duplicateHashes.has(photo.hash)) labels.push('잘 나온 사진과 비슷한 사진이 또 있어요')
        if (photo.status !== 'exclude' && photo.faceScanStatus === 'done' && photo.faceCount === 0) labels.push('얼굴이 안 보여요')

        const consent = photoConsentByPhotoId.get(photo.id)
        if (consent && photo.status === 'public_candidate') {
          if (consent.no.length) labels.push(`단톡방 공유 안 됨: ${consent.no.join(', ')}`)
          else if (consent.unknown.length && !consent.yes.length) labels.push('단톡방 공유 동의 확인 필요')
        }

        return labels.map((label) => ({ id: `${photo.id}-${label}`, photo, label }))
      })
      .slice(0, 12)
  }, [duplicateHashes, photoConsentByPhotoId, photos])

  const visiblePhotos = useMemo(() => {
    const query = normalizeTag(searchText).toLowerCase()

    if (folderDrillIn) {
      const folder = personFolders.find((f) => f.id === folderDrillIn.folderId)
      if (!folder) return []
      const idSet = new Set(folderDrillIn.mode === 'candidates' ? folder.candidatePhotoIds : folder.photoIds)
      return photos.filter((photo) => idSet.has(photo.id))
    }

    return photos.filter((photo) => {
      // 「정리 안 된 사진만 보기」 토글: 분류·태그·인물폴더 셋 다 손 안 댄 사진만
      if (hideSorted) {
        const isSorted =
          photo.status !== 'keep' || photo.studentTags.length > 0 || photo.personFolderIds.length > 0
        if (isSorted) return false
      }
      if (statusFilter !== 'all' && photo.status !== statusFilter) return false
      if (faceFilter === 'has_face' && (photo.faceCount ?? 0) <= 0) return false
      if (faceFilter === 'no_face' && photo.faceScanStatus !== 'done') return false
      if (faceFilter === 'no_face' && (photo.faceCount ?? 0) !== 0) return false
      if (faceFilter === 'not_scanned' && photo.faceScanStatus !== 'idle') return false
      if (!query) return true

      const people = photo.personFolderIds
        .map((folderId) => personFolderById.get(folderId)?.name)
        .filter(Boolean)
        .join(' ')
      const haystack = [
        photo.name,
        photo.eventTag,
        photo.dateKey,
        STATUS_LABELS.get(photo.status) ?? photo.status,
        photo.studentTags.join(' '),
        people,
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(query)
    })
  }, [faceFilter, folderDrillIn, hideSorted, personFolderById, personFolders, photos, searchText, statusFilter])

  const groups = useMemo(() => {
    const grouped = new Map<string, PhotoItem[]>()
    visiblePhotos.forEach((photo) => {
      const label = `${photo.dateKey}/${photo.eventTag || '미분류'}`
      grouped.set(label, [...(grouped.get(label) ?? []), photo])
    })
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visiblePhotos])

  async function buildPhotoItemsFromFiles(
    imageFiles: File[],
    options?: { personFolderId?: string; failures?: Array<{ name: string; reason: string }> },
  ) {
    return (
      await Promise.all(
        imageFiles.map(async (file): Promise<PhotoItem | null> => {
          try {
            const analysis = await analyzeImage(file)
            const modifiedAt = new Date(file.lastModified)
            setAnalysisProgress((prev) => ({ done: prev.done + 1, total: prev.total }))
            return {
              id: `${file.name}-${file.lastModified}-${file.size}-${crypto.randomUUID()}`,
              file,
              url: URL.createObjectURL(file),
              name: file.name,
              size: file.size,
              modifiedAt,
              dateKey: getDateKey(modifiedAt),
              eventTag: normalizeTag(eventInput) || '주일학교',
              studentTags: [],
              personFolderIds: options?.personFolderId ? [options.personFolderId] : [],
              status: 'keep',
              faceCount: null,
              faceBoxes: [],
              faceScanStatus: 'idle',
              ...analysis,
            }
          } catch (error) {
            setAnalysisProgress((prev) => ({ done: prev.done + 1, total: prev.total }))
            const reason = error instanceof Error ? error.message : '알 수 없음'
            options?.failures?.push({ name: file.name, reason })
            return null
          }
        }),
      )
    ).filter((item): item is PhotoItem => item !== null)
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return

    const allFiles = [...files]
    const imageFiles = allFiles.filter((file) => IMAGE_TYPES.includes(file.type) || file.type.startsWith('image/'))
    if (!imageFiles.length) {
      setProjectMessage('사진 파일이 없습니다. JPG/PNG/WebP/HEIC 사진을 선택해 주세요.')
      return
    }

    const heicFiles = imageFiles.filter(
      (file) =>
        file.type === 'image/heic' ||
        file.type === 'image/heif' ||
        /\.heic$/i.test(file.name) ||
        /\.heif$/i.test(file.name),
    )
    const heicSupported =
      typeof document !== 'undefined' &&
      (document.createElement('canvas').toDataURL('image/heic').startsWith('data:image/heic') ||
        /AppleWebKit/.test(navigator.userAgent) && /Mac|iPhone|iPad/.test(navigator.userAgent))

    setAnalysisProgress({ done: 0, total: imageFiles.length })
    setIsAnalyzing(true)
    const failures: Array<{ name: string; reason: string }> = []

    try {
      const nextItems: PhotoItem[] = (
        await Promise.all(
          imageFiles.map(async (file): Promise<PhotoItem | null> => {
            try {
              const analysis = await analyzeImage(file)
              const modifiedAt = new Date(file.lastModified)
              setAnalysisProgress((prev) => ({ done: prev.done + 1, total: prev.total }))

              const item: PhotoItem = {
                id: `${file.name}-${file.lastModified}-${file.size}-${crypto.randomUUID()}`,
                file,
                url: URL.createObjectURL(file),
                name: file.name,
                size: file.size,
                modifiedAt,
                dateKey: getDateKey(modifiedAt),
                eventTag: normalizeTag(eventInput) || '주일학교',
                studentTags: [],
                personFolderIds: [],
                status: 'keep',
                faceCount: null,
                faceBoxes: [],
                faceScanStatus: 'idle',
                ...analysis,
              }
              return item
            } catch (error) {
              setAnalysisProgress((prev) => ({ done: prev.done + 1, total: prev.total }))
              const reason = error instanceof Error ? error.message : '알 수 없음'
              failures.push({ name: file.name, reason })
              return null
            }
          }),
        )
      ).filter((item): item is PhotoItem => item !== null)

      if (nextItems.length) {
        setPhotos((current) => [...nextItems, ...current])
        setActivePhotoId((current) => current ?? nextItems[0]?.id ?? null)
        // IndexedDB에 Blob 자동 저장 (다음 세션 자동 복원용)
        Promise.all(nextItems.map((item) => putPhotoBlob(getPhotoStorageKey(item), item.file))).catch((err) => {
          console.warn('사진 Blob 자동 저장 실패:', err)
        })
      }

      const heicWarning =
        heicFiles.length > 0 && !heicSupported
          ? ` HEIC 사진 ${heicFiles.length}장이 포함되어 있어요. 이 브라우저에서 사진이 안 보이면 PC에서 JPG로 변환한 뒤 다시 넣어 주세요.`
          : ''
      const failureNames = failures.slice(0, 3).map((f) => f.name).join(', ')
      const failureNote =
        failures.length > 0
          ? ` 일부 사진(${failures.length}장)을 읽지 못했습니다${failureNames ? ': ' + failureNames + (failures.length > 3 ? ' 등' : '') : ''}.`
          : ''
      const message = `${nextItems.length}장을 추가했어요.${heicWarning}${failureNote}`
      if (heicWarning || failureNote || nextItems.length === 0) {
        setProjectMessage(message)
      }
    } finally {
      setIsAnalyzing(false)
      setAnalysisProgress({ done: 0, total: 0 })
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const toggleSelected = useCallback((id: string) => {
    setActivePhotoId(id)
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
    )
  }, [])

  const moveActivePhoto = useCallback((direction: -1 | 1) => {
    if (!photos.length) return
    const currentIndex = activeIndex >= 0 ? activeIndex : 0
    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), photos.length - 1)
    setActivePhotoId(photos[nextIndex].id)
  }, [activeIndex, photos])

  async function importRoster(files: FileList | null) {
    const file = files?.[0]
    if (!file) return

    try {
      const buffer = await file.arrayBuffer()
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      // UTF-8로 디코딩 시 한글이 깨지면 CP949(EUC-KR)로 재시도
      if (/[�]/.test(text)) {
        try {
          text = new TextDecoder('euc-kr', { fatal: false }).decode(buffer)
        } catch {
          // EUC-KR 미지원 환경(드문) — 일단 UTF-8 결과 사용
        }
      }
      const { names, consent } = parseRoster(text)
      setRosterNames(names)
      setRosterConsent(consent)
      const consentEntries = Object.values(consent)
      const consentMessage = consentEntries.length
        ? ` · 공개 동의 ${consentEntries.filter((value) => value === 'yes').length} / 미동의 ${consentEntries.filter((value) => value === 'no').length} / 미확인 ${consentEntries.filter((value) => value === 'unknown').length}`
        : ''
      if (!names.length) {
        setRosterMessage(
          '명단에서 이름을 찾지 못했습니다. CSV 첫 행에 「이름」/「성명」/「학생명」/「name」 같은 헤더가 있는지 확인해 주세요.',
        )
      } else {
        setRosterMessage(`${names.length}명의 명단을 불러왔습니다.${consentMessage}`)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '알 수 없음'
      setRosterMessage(`CSV 명단을 읽지 못했습니다: ${reason}. 엑셀에서 「CSV UTF-8」로 다시 저장해 보세요.`)
    } finally {
      if (rosterInputRef.current) rosterInputRef.current.value = ''
    }
  }

  function applyRosterName(name: string) {
    if (!selectedIds.length) {
      // 선택된 사진이 없으면 「이름으로 사진 보기」로 동작 — 검색에 이름 적용
      setSearchText(name)
      setProjectMessage(`「${name}」 이름으로 필터링했어요. 사진 카드를 클릭해서 선택한 뒤 명단 칩을 다시 누르면 일괄 태그됩니다.`)
      return
    }

    captureSnapshot(`${selectedIds.length}장에 「${name}」 태그`)
    setPhotos((current) =>
      current.map((photo) =>
        selectedIds.includes(photo.id)
          ? { ...photo, studentTags: [...new Set([...photo.studentTags, name])] }
          : photo,
      ),
    )
  }

  function createPersonFolderFromActive() {
    const name = normalizeTag(personNameInput)
    if (!name) return

    captureSnapshot(`「${name}」 폴더 만들기`)
    const folderId = `person-${crypto.randomUUID()}`
    setPersonFolders((current) => [
      ...current,
      {
        id: folderId,
        name,
        parentId: null,
        representativePhotoId: '',
        photoIds: [],
        candidatePhotoIds: [],
        candidateScores: {},
      },
    ])
    setPersonNameInput('')
  }

  function movePhotosToFolder(photoIds: string[], folderId: string, mode: 'auto' | 'move' | 'copy' = 'auto') {
    if (!photoIds.length) return
    const folder = personFolders.find((entry) => entry.id === folderId)
    if (!folder) return
    const idSet = new Set(photoIds)

    const photoById = new Map(photos.map((photo) => [photo.id, photo]))
    const moveSet = new Set<string>()
    const copySet = new Set<string>()
    for (const id of photoIds) {
      const photo = photoById.get(id)
      // 보호 대상: 얼굴 검출이 끝나지 않았거나(unknown) 2인 이상인 사진은 항상 복사
      const shouldProtect = !photo || photo.faceScanStatus !== 'done' || (photo.faceCount ?? 0) >= 2
      if (mode === 'copy') {
        copySet.add(id)
        continue
      }
      if (shouldProtect) {
        copySet.add(id)
        continue
      }
      // 여기까지 왔으면 mode === 'move' || mode === 'auto'이고 개인사진(faceCount 0~1)
      moveSet.add(id)
    }

    // 복사 = 독립 사본 (alias) photo 생성. 원본은 메인에 그대로 유지.
    // 같은 사진을 같은 폴더에 두 번 복사하는 것 방지: 이미 alias가 있으면 skip.
    const existingAliasKeys = new Set(
      photos
        .filter((p) => p.isAlias)
        .map((p) => `${p.personFolderIds[0] ?? ''}:${getPhotoStorageKey(p)}`),
    )
    const newAliases: PhotoItem[] = []
    for (const id of copySet) {
      const orig = photoById.get(id)
      if (!orig) continue
      const aliasKey = `${folderId}:${getPhotoStorageKey(orig)}`
      if (existingAliasKeys.has(aliasKey)) continue
      newAliases.push({
        ...orig,
        id: `alias-${crypto.randomUUID()}`,
        personFolderIds: [folderId],
        isAlias: true,
      })
    }

    captureSnapshot(
      `${photoIds.length}장 → 「${folder.name}」` +
        (moveSet.size && copySet.size
          ? ` (이동 ${moveSet.size} · 복사 ${copySet.size})`
          : moveSet.size
          ? ' 이동'
          : ' 복사'),
    )

    const newAliasIds = newAliases.map((p) => p.id)
    setPersonFolders((current) =>
      current.map((f) => {
        if (f.id === folderId) {
          // 이동된 원본 id + 새 alias id를 폴더에 추가
          return {
            ...f,
            photoIds: [...new Set([...f.photoIds, ...moveSet, ...newAliasIds])],
            candidatePhotoIds: f.candidatePhotoIds.filter((id) => !idSet.has(id)),
            candidateScores: Object.fromEntries(
              Object.entries(f.candidateScores).filter(([id]) => !idSet.has(id)),
            ),
          }
        }
        // 다른 폴더에서는 「이동」된 원본만 빠져나감 (복사는 다른 폴더에 영향 X)
        const filtered = f.photoIds.filter((id) => !moveSet.has(id))
        if (filtered.length === f.photoIds.length) return f
        return { ...f, photoIds: filtered }
      }),
    )
    setPhotos((current) => {
      const updated = current.map((photo) => {
        if (!moveSet.has(photo.id)) return photo
        // 「이동」된 원본만 personFolderIds 갱신 (복사 원본은 변경 X)
        return { ...photo, personFolderIds: [folderId] }
      })
      // 새 alias photo들을 photos 배열 앞에 추가 (최신이 위로)
      return newAliases.length ? [...newAliases, ...updated] : updated
    })
    setSelectedIds((current) => current.filter((id) => !idSet.has(id)))

    const movedCount = moveSet.size
    const copiedCount = newAliases.length
    const skippedDup = copySet.size - copiedCount
    const parts: string[] = []
    if (movedCount) parts.push(`이동 ${movedCount}장`)
    if (copiedCount) parts.push(`복사 ${copiedCount}장`)
    if (skippedDup) parts.push(`이미 복사됨 ${skippedDup}장 건너뜀`)
    setProjectMessage(`${parts.join(' · ') || `${photoIds.length}장`} → 「${folder.name}」`)
  }

  function removePhotosFromFolder(photoIds: string[], folderId: string) {
    if (!photoIds.length) return
    const folder = personFolders.find((entry) => entry.id === folderId)
    if (!folder) return
    const idSet = new Set(photoIds)
    // alias 사진은 폴더에서 빼면 photos에서도 제거 (alias는 폴더에 종속됨)
    const aliasIdsToDelete = new Set(
      photos.filter((p) => idSet.has(p.id) && p.isAlias).map((p) => p.id),
    )
    captureSnapshot(`${photoIds.length}장을 「${folder.name}」 폴더에서 빼기`)
    setPersonFolders((current) =>
      current.map((f) =>
        f.id === folderId
          ? {
              ...f,
              photoIds: f.photoIds.filter((id) => !idSet.has(id)),
              candidatePhotoIds: f.candidatePhotoIds.filter((id) => !idSet.has(id)),
              candidateScores: Object.fromEntries(
                Object.entries(f.candidateScores).filter(([id]) => !idSet.has(id)),
              ),
            }
          : f,
      ),
    )
    setPhotos((current) =>
      current
        .filter((photo) => !aliasIdsToDelete.has(photo.id))
        .map((photo) =>
          idSet.has(photo.id)
            ? { ...photo, personFolderIds: photo.personFolderIds.filter((id) => id !== folderId) }
            : photo,
        ),
    )
    // alias의 url은 원본과 같은 blob을 가리키므로 revoke 안 함 (원본이 깨짐 방지)
    setSelectedIds((current) => current.filter((id) => !idSet.has(id)))
    setProjectMessage(`${photoIds.length}장을 「${folder.name}」 폴더에서 뺐어요. 메인 화면의 원본은 그대로 있어요.`)
  }

  function deletePhotos(photoIds: string[]) {
    if (!photoIds.length) return
    const idSet = new Set(photoIds)
    const targets = photos.filter((photo) => idSet.has(photo.id))
    if (!targets.length) return
    const confirmMsg =
      targets.length === 1
        ? `「${targets[0].name}」 사진 1장을 지웁니다. 폴더 배정·태그·분류도 함께 지워져요.`
        : `사진 ${targets.length}장을 지웁니다. 폴더 배정·태그·분류도 함께 지워져요.`
    if (!window.confirm(confirmMsg)) return

    captureSnapshot(`사진 ${targets.length}장 삭제`)
    // IDB blob과 url revoke는 storageKey 기준. 같은 storageKey를 다른 photo(원본·alias)가
    // 들고 있으면 blob/url 보존. 모두 사라질 때만 정리.
    const remainingByKey = new Map<string, number>()
    for (const p of photos) {
      const k = getPhotoStorageKey(p)
      remainingByKey.set(k, (remainingByKey.get(k) ?? 0) + 1)
    }
    for (const t of targets) {
      const k = getPhotoStorageKey(t)
      remainingByKey.set(k, (remainingByKey.get(k) ?? 0) - 1)
    }
    const keysFullyRemoved = targets
      .map(getPhotoStorageKey)
      .filter((k) => (remainingByKey.get(k) ?? 0) <= 0)
    // url revoke: alias가 아닌 원본 사진이고, 같은 키를 가진 다른 사진이 없을 때만
    targets.forEach((photo) => {
      if (!photo.isAlias && (remainingByKey.get(getPhotoStorageKey(photo)) ?? 0) <= 0) {
        URL.revokeObjectURL(photo.url)
      }
    })
    if (keysFullyRemoved.length) {
      deletePhotoBlobsFromIDB(keysFullyRemoved).catch((err) => console.warn('사진 Blob 삭제 실패:', err))
    }
    setPhotos((current) => current.filter((photo) => !idSet.has(photo.id)))
    setPersonFolders((current) =>
      current.map((folder) => ({
        ...folder,
        photoIds: folder.photoIds.filter((id) => !idSet.has(id)),
        candidatePhotoIds: folder.candidatePhotoIds.filter((id) => !idSet.has(id)),
        candidateScores: Object.fromEntries(
          Object.entries(folder.candidateScores).filter(([id]) => !idSet.has(id)),
        ),
      })),
    )
    setSelectedIds((current) => current.filter((id) => !idSet.has(id)))
    if (activePhotoId && idSet.has(activePhotoId)) setActivePhotoId(null)
    if (viewerPhotoId && idSet.has(viewerPhotoId)) closeViewer()
    setProjectMessage(`사진 ${targets.length}장을 지웠어요.`)
  }

  function addSubFolder(parentId: string) {
    const parent = personFolders.find((entry) => entry.id === parentId)
    if (!parent) return
    const next = window.prompt(`「${parent.name}」 안에 만들 새 폴더 이름`, '')
    if (!next) return
    const trimmed = normalizeTag(next)
    if (!trimmed) return
    captureSnapshot(`「${parent.name}」 안에 「${trimmed}」 폴더 만들기`)
    const folderId = `person-${crypto.randomUUID()}`
    setPersonFolders((current) => [
      ...current,
      {
        id: folderId,
        name: trimmed,
        parentId,
        representativePhotoId: '',
        photoIds: [],
        candidatePhotoIds: [],
        candidateScores: {},
      },
    ])
    setCollapsedFolderIds((current) => {
      const next = new Set(current)
      next.delete(parentId)
      return next
    })
  }

  function findSimilarCandidates(folderId: string) {
    const folder = personFolderById.get(folderId)
    if (!folder) return
    const repId = folder.representativePhotoId || folder.photoIds[0]
    const representative = photos.find((photo) => photo.id === repId)
    if (!representative) return

    const candidates = photos
      .filter((photo) => photo.id !== representative.id)
      .filter((photo) => !photo.personFolderIds.includes(folderId))
      .map((photo) => ({
        id: photo.id,
        distance: getHashDistance(representative.hash, photo.hash),
      }))
      .filter((candidate) => candidate.distance <= CANDIDATE_DISTANCE_LIMIT)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 40)
    const candidatePhotoIds = candidates.map((candidate) => candidate.id)
    const candidateScores = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        Math.max(1, Math.round((1 - candidate.distance / CANDIDATE_DISTANCE_LIMIT) * 100)),
      ]),
    )

    setPersonFolders((current) =>
      current.map((item) => (item.id === folderId ? { ...item, candidatePhotoIds, candidateScores } : item)),
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function scanPeoplePhotos() {
    if (!photos.length || isFaceScanning) return

    if (!window.FaceDetector) {
      setFaceScanMessage('이 브라우저는 로컬 얼굴 검출을 지원하지 않습니다. Chrome/Edge 최신 버전에서 다시 시도해 주세요.')
      setPhotos((current) =>
        current.map((photo) => ({ ...photo, faceCount: null, faceBoxes: [], faceScanStatus: 'unsupported' })),
      )
      return
    }

    setIsFaceScanning(true)
    setFaceScanMessage('사진에서 얼굴을 찾는 중입니다.')
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 20 })

    try {
      const updates = await Promise.all(
        photos.map(async (photo) => {
          try {
            const bitmap = await createImageBitmap(photo.file)
            const faces = await detector.detect(bitmap)
            const faceBoxes = faces
              .map((face) => face.boundingBox)
              .filter((box): box is DOMRectReadOnly => Boolean(box))
              .map((box) => ({
                x: box.x / bitmap.width,
                y: box.y / bitmap.height,
                width: box.width / bitmap.width,
                height: box.height / bitmap.height,
              }))
            bitmap.close()
            return { id: photo.id, faceCount: faces.length, faceBoxes, faceScanStatus: 'done' as const }
          } catch {
            return { id: photo.id, faceCount: null, faceBoxes: [], faceScanStatus: 'error' as const }
          }
        }),
      )
      const updateMap = new Map(updates.map((update) => [update.id, update]))

      setPhotos((current) =>
        current.map((photo) => {
          const update = updateMap.get(photo.id)
          return update
            ? { ...photo, faceCount: update.faceCount, faceBoxes: update.faceBoxes, faceScanStatus: update.faceScanStatus }
            : photo
        }),
      )
      setFaceScanMessage(`인물 사진 후보 ${updates.filter((update) => (update.faceCount ?? 0) > 0).length}장을 찾았습니다.`)
    } finally {
      setIsFaceScanning(false)
    }
  }

  const setStatusForPhotos = useCallback((ids: string[], status: PhotoStatus) => {
    if (!ids.length) return
    setPhotos((current) =>
      current.map((photo) => (ids.includes(photo.id) ? { ...photo, status } : photo)),
    )
  }, [])

  function classifyAndAdvance(status: PhotoStatus, statusLabel: string) {
    const targetId = activePhotoId ?? photos[0]?.id
    if (!targetId) return
    captureSnapshot(`「${statusLabel}」로 분류`)
    setStatusForPhotos([targetId], status)
    const targetIndex = photos.findIndex((photo) => photo.id === targetId)
    if (targetIndex >= 0 && targetIndex < photos.length - 1) {
      setActivePhotoId(photos[targetIndex + 1].id)
    } else {
      setProjectMessage('마지막 사진까지 분류했어요. 「결과 받기」를 누를 차례입니다.')
    }
  }

  function removeStudentTagFromPhoto(photoId: string, tag: string) {
    captureSnapshot(`「${tag}」 태그 제거`)
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === photoId
          ? { ...photo, studentTags: photo.studentTags.filter((existing) => existing !== tag) }
          : photo,
      ),
    )
  }

  function removePersonFolderFromPhoto(photoId: string, folderId: string) {
    const folderName = personFolderById.get(folderId)?.name ?? '사람별 모음'
    captureSnapshot(`「${folderName}」 모음에서 빼기`)
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === photoId
          ? { ...photo, personFolderIds: photo.personFolderIds.filter((id) => id !== folderId) }
          : photo,
      ),
    )
    setPersonFolders((current) =>
      current.map((folder) =>
        folder.id === folderId
          ? { ...folder, photoIds: folder.photoIds.filter((id) => id !== photoId) }
          : folder,
      ),
    )
  }

  function quickTagActive(name: string) {
    const targetId = activePhotoId ?? photos[0]?.id
    if (!targetId) return
    captureSnapshot(`사진에 「${name}」 태그`)
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === targetId
          ? { ...photo, studentTags: [...new Set([...photo.studentTags, name])] }
          : photo,
      ),
    )
  }

  const moveViewerPhoto = useCallback((direction: -1 | 1) => {
    if (!photos.length) return
    const currentIndex = viewerIndex >= 0 ? viewerIndex : activeIndex >= 0 ? activeIndex : 0
    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), photos.length - 1)
    setViewerPhotoId(photos[nextIndex].id)
    setActivePhotoId(photos[nextIndex].id)
    setSelectedFaceIndex(null)
  }, [activeIndex, photos, viewerIndex])

  function openViewer(photoId: string) {
    setViewerPhotoId(photoId)
    setActivePhotoId(photoId)
    setSelectedFaceIndex(null)
  }

  function closeViewer() {
    setViewerPhotoId(null)
    setSelectedFaceIndex(null)
  }

  function createPersonFolderFromSelectedFace() {
    if (!viewerPhoto || selectedFaceIndex === null) return
    const name = normalizeTag(personNameInput)
    if (!name) return

    const folderId = `person-${crypto.randomUUID()}`
    setPersonFolders((current) => [
      ...current,
      {
        id: folderId,
        name,
        parentId: null,
        representativePhotoId: viewerPhoto.id,
        photoIds: [viewerPhoto.id],
        candidatePhotoIds: [],
        candidateScores: {},
      },
    ])
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === viewerPhoto.id
          ? { ...photo, personFolderIds: [...new Set([...photo.personFolderIds, folderId])] }
          : photo,
      ),
    )
    setPersonNameInput('')
  }

  function renamePersonFolder(folderId: string) {
    const folder = personFolders.find((entry) => entry.id === folderId)
    if (!folder) return
    const next = window.prompt(`「${folder.name}」 새 이름`, folder.name)
    if (!next) return
    const trimmed = normalizeTag(next)
    if (!trimmed || trimmed === folder.name) return
    setPersonFolders((current) =>
      current.map((entry) => (entry.id === folderId ? { ...entry, name: trimmed } : entry)),
    )
  }

  function deletePersonFolder(folderId: string) {
    const folder = personFolders.find((entry) => entry.id === folderId)
    if (!folder) return
    const childCount = personFolders.filter((entry) => entry.parentId === folderId).length
    const childMsg = childCount > 0 ? `\n하위 폴더 ${childCount}개는 한 단계 위로 옮겨집니다.` : ''
    if (!window.confirm(`인물 폴더 「${folder.name}」을 지웁니다. 사진 자체는 남고 폴더 배정만 풀립니다.${childMsg}`)) return
    setPersonFolders((current) =>
      current
        .filter((entry) => entry.id !== folderId)
        .map((entry) => (entry.parentId === folderId ? { ...entry, parentId: folder.parentId ?? null } : entry)),
    )
    if (activeFolderId === folderId) setActiveFolderId(null)
    if (folderDrillIn?.folderId === folderId) setFolderDrillIn(null)
    setPhotos((current) =>
      current.map((photo) =>
        photo.personFolderIds.includes(folderId)
          ? { ...photo, personFolderIds: photo.personFolderIds.filter((id) => id !== folderId) }
          : photo,
      ),
    )
  }

  function captureSnapshot(label: string) {
    setUndoSnapshot({
      photos: photos.map((photo) => ({
        ...photo,
        studentTags: [...photo.studentTags],
        personFolderIds: [...photo.personFolderIds],
        faceBoxes: photo.faceBoxes.map((box) => ({ ...box })),
      })),
      personFolders: personFolders.map((folder) => ({
        ...folder,
        photoIds: [...folder.photoIds],
        candidatePhotoIds: [...folder.candidatePhotoIds],
        candidateScores: { ...folder.candidateScores },
      })),
      label,
    })
  }

  function performUndo() {
    if (!undoSnapshot) return
    setPhotos(undoSnapshot.photos)
    setPersonFolders(undoSnapshot.personFolders)
    setProjectMessage(`되돌렸어요: ${undoSnapshot.label}`)
    setUndoSnapshot(null)
  }

  function clearAll() {
    if (!photos.length) return
    const message = `사진 ${photos.length}장과 인물 폴더, 선별 상태가 모두 사라집니다. 계속할까요?\n\n저장하지 않은 작업은 「중간 저장」을 먼저 누르세요.`
    if (!window.confirm(message)) return

    photos.forEach((photo) => URL.revokeObjectURL(photo.url))
    clearAllPhotoBlobs().catch((err) => console.warn('사진 Blob 일괄 삭제 실패:', err))
    try { localStorage.removeItem(PROJECT_AUTOSAVE_KEY) } catch {}
    try { localStorage.removeItem(FOLDERS_TREE_KEY) } catch {}
    setPhotos([])
    setPersonFolders([])
    setSelectedIds([])
    setActivePhotoId(null)
    closeViewer()
  }

  function clearArchivedPlansWithConfirm() {
    if (!archivedPlans.length) return
    if (!window.confirm(`누적 통계 기록 ${archivedPlans.length}건이 모두 사라집니다. 계속할까요?`)) return
    clearArchivedPlans()
  }

  function buildPlanRows() {
    return [
      [
        'original_name',
        'suggested_folder',
        'suggested_name',
        'students',
        'people',
        'event',
        'date',
        'status',
        'duplicate',
        'blur_score',
        'size',
      ],
      ...photos.map((photo, index) => {
        const students = photo.studentTags.length ? photo.studentTags.join('+') : '미지정'
        const people = photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter(Boolean)
          .join('+')
        const peopleOrStudents = people || students
        const folder = `${photo.dateKey}_${photo.eventTag}/${peopleOrStudents}`
        const extension = photo.name.includes('.') ? photo.name.split('.').pop() : 'jpg'
        const suggestedName = `${photo.dateKey}_${photo.eventTag}_${peopleOrStudents}_${String(index + 1).padStart(3, '0')}.${extension}`

        return [
          photo.name,
          folder,
          suggestedName,
          photo.studentTags.join(', '),
          people,
          photo.eventTag,
          photo.dateKey,
          STATUS_LABELS.get(photo.status) ?? photo.status,
          duplicateHashes.has(photo.hash) ? 'YES' : 'NO',
          photo.blurScore,
          photo.size,
        ]
      }),
    ]
  }

  function buildPlanRecords(): PlanPhotoRecord[] {
    return photos.map((photo, index) => {
      const students = photo.studentTags.length ? photo.studentTags.join('+') : '미지정'
      const peopleNames = photo.personFolderIds
        .map((folderId) => personFolderById.get(folderId)?.name)
        .filter((name): name is string => Boolean(name))
      const peopleOrStudents = peopleNames.join('+') || students
      const folder = `${photo.dateKey}_${photo.eventTag}/${peopleOrStudents}`
      const extension = photo.name.includes('.') ? photo.name.split('.').pop() : 'jpg'
      const suggestedName = `${photo.dateKey}_${photo.eventTag}_${peopleOrStudents}_${String(index + 1).padStart(3, '0')}.${extension}`

      const consent = photoConsentByPhotoId.get(photo.id)
      let consentBlock: PlanPhotoRecord['consent']
      if (consent) {
        const state: NonNullable<PlanPhotoRecord['consent']>['state'] = consent.no.length
          ? 'has_no'
          : consent.yes.length && !consent.unknown.length
          ? 'all_yes'
          : consent.yes.length
          ? 'partial'
          : 'unknown'
        consentBlock = { state, yes: consent.yes, no: consent.no, unknown: consent.unknown }
      }

      return {
        originalName: photo.name,
        suggestedFolder: folder,
        suggestedName,
        students: photo.studentTags,
        people: peopleNames,
        event: photo.eventTag,
        date: photo.dateKey,
        status: photo.status,
        statusLabel: STATUS_LABELS.get(photo.status) ?? photo.status,
        duplicate: duplicateHashes.has(photo.hash),
        blurScore: photo.blurScore,
        size: photo.size,
        width: photo.width,
        height: photo.height,
        faceCount: photo.faceCount,
        ...(consentBlock ? { consent: consentBlock } : {}),
      }
    })
  }

  function buildPlanExport(): PlanExportFile {
    const records = buildPlanRecords()
    const earliestDate = photos.reduce<string | null>((acc, photo) => {
      if (!acc || photo.dateKey < acc) return photo.dateKey
      return acc
    }, null)

    const people = personFolders.map((folder) => {
      const representative = photos.find((photo) => photo.id === folder.representativePhotoId)
      return {
        name: folder.name,
        photoCount: folder.photoIds.length,
        representativeOriginalName: representative?.name ?? '',
      }
    })

    return {
      app: 'eum-photo',
      type: 'plan',
      version: 1,
      exportedAt: new Date().toISOString(),
      event: {
        name: normalizeTag(eventInput) || '주일학교',
        earliestDate: earliestDate ?? getDateKey(new Date()),
        photoCount: records.length,
      },
      people,
      ...(rosterMatch.hasRoster
        ? {
            rosterMatch: {
              rosterSize: rosterMatch.entries.length,
              covered: rosterMatch.covered,
              uncovered: rosterMatch.uncovered,
              orphanTags: rosterMatch.orphanTags,
            },
          }
        : {}),
      photos: records,
    }
  }

  function exportPlan() {
    const rows = buildPlanRows()

    downloadText(
      `eum-photo-plan-${getDateKey(new Date())}.csv`,
      rows.map((row) => row.map(csvEscape).join(',')).join('\n'),
    )
  }

  function persistArchivedPlans(next: ArchivedPlanSummary[]) {
    setArchivedPlans(next)
    try {
      window.localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(next))
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown'
      if (reason === 'QuotaExceededError' || /Quota/.test(reason)) {
        setProjectMessage('누적 통계 저장 공간이 가득 찼어요. 「기록 비우기」로 오래된 기록부터 정리해 주세요.')
      } else {
        // 시크릿 모드 등 storage 차단 — 조용히 무시
      }
    }
  }

  function archiveCurrentPlan() {
    if (!photos.length) return
    const plan = buildPlanExport()
    const peopleCounts: Record<string, number> = {}
    plan.photos.forEach((record) => {
      const seen = new Set<string>([...record.people, ...record.students])
      seen.forEach((name) => {
        peopleCounts[name] = (peopleCounts[name] ?? 0) + 1
      })
    })
    const summary: ArchivedPlanSummary = {
      id: `plan-${Date.now()}-${crypto.randomUUID()}`,
      savedAt: plan.exportedAt,
      eventName: plan.event.name,
      earliestDate: plan.event.earliestDate,
      photoCount: plan.event.photoCount,
      peopleCounts,
    }
    persistArchivedPlans([summary, ...archivedPlans])
    setProjectMessage(`'${summary.eventName}' 행사를 누적 통계에 추가했습니다.`)
  }

  function removeArchivedPlan(id: string) {
    persistArchivedPlans(archivedPlans.filter((entry) => entry.id !== id))
  }

  function clearArchivedPlans() {
    if (!archivedPlans.length) return
    persistArchivedPlans([])
    setProjectMessage('누적 통계 기록을 비웠습니다.')
  }

  function exportPlanJson() {
    if (!photos.length) return

    downloadText(
      `eum-photo-plan-${getDateKey(new Date())}.json`,
      JSON.stringify(buildPlanExport(), null, 2),
      'application/json;charset=utf-8',
    )
    setProjectMessage('정리안을 JSON으로 내보냈습니다. 이음 스쿨 import용으로 사용할 수 있습니다.')
  }

  function exportProject() {
    if (!photos.length) return

    const photoById = new Map(photos.map((photo) => [photo.id, photo]))
    const project: ProjectSaveFile = {
      app: 'eum-photo',
      version: 1,
      savedAt: new Date().toISOString(),
      eventInput,
      photos: photos.map((photo) => ({
        key: getPhotoStorageKey(photo),
        name: photo.name,
        size: photo.size,
        modifiedAt: photo.modifiedAt.getTime(),
        dateKey: photo.dateKey,
        eventTag: photo.eventTag,
        studentTags: photo.studentTags,
        status: photo.status,
        faceCount: photo.faceCount,
        faceBoxes: photo.faceBoxes,
        faceScanStatus: photo.faceScanStatus,
      })),
      personFolders: personFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId ?? null,
        representativePhotoKey: getPhotoStorageKey(photoById.get(folder.representativePhotoId) ?? photos[0]),
        photoKeys: folder.photoIds
          .map((photoId) => photoById.get(photoId))
          .filter((photo): photo is PhotoItem => Boolean(photo))
          .map(getPhotoStorageKey),
        candidatePhotoKeys: folder.candidatePhotoIds
          .map((photoId) => photoById.get(photoId))
          .filter((photo): photo is PhotoItem => Boolean(photo))
          .map(getPhotoStorageKey),
        candidateScoresByKey: Object.fromEntries(
          folder.candidatePhotoIds
            .map((photoId) => {
              const photo = photoById.get(photoId)
              return photo ? [getPhotoStorageKey(photo), folder.candidateScores[photoId] ?? 0] : null
            })
            .filter((item): item is [string, number] => Boolean(item)),
        ),
      })),
    }

    downloadText(
      `eum-photo-project-${getDateKey(new Date())}.json`,
      JSON.stringify(project, null, 2),
      'application/json;charset=utf-8',
    )
    setProjectMessage('현재 작업 상태를 JSON으로 저장했습니다.')
  }

  // Electron native fs IPC 기반 폴더 import — Web FS API 의존 X.
  // root 안의 EUM-Photo/원본/ 사진을 모두 import + EUM-Photo/정리/<상태>/<사람>/ 트리에서 사람 폴더 자동 생성.
  // _정리안.json 메타도 함께 복원.
  async function loadFromSavedFolderElectron(rootPath: string): Promise<boolean> {
    const eum = window.eum
    if (!eum?.isElectron) return false

    // 1) EUM-Photo 디렉토리 결정 (root 안에 있거나, root 자체가 EUM-Photo)
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const join = (...parts: string[]) => parts.filter(Boolean).join(sep).replace(/[\\/]+/g, sep)
    const candidateEum = join(rootPath, 'EUM-Photo')
    const eumDirPath = (await eum.fs.exists(candidateEum)) ? candidateEum : rootPath

    const originalDirPath = join(eumDirPath, '원본')
    if (!(await eum.fs.exists(originalDirPath))) {
      window.alert(`「${eumDirPath}\\원본」 폴더를 찾을 수 없어요.\n선택한 폴더가 EUM-Photo의 부모 폴더이거나 EUM-Photo 자체인지 확인해 주세요.`)
      return false
    }

    setProjectMessage('작업 폴더 사진을 불러오는 중…')

    // 2) 원본 폴더의 이미지 파일 목록
    const listed = await eum.fs.listDir(originalDirPath)
    if (!listed.ok) {
      window.alert(`원본 폴더 읽기 실패: ${listed.reason ?? '알 수 없음'}`)
      return false
    }
    const imageItems = listed.items.filter(
      (it) => it.isFile && /\.(jpe?g|png|webp|heic|heif)$/i.test(it.name),
    )
    if (!imageItems.length) {
      window.alert('「원본」 폴더에서 사진을 찾지 못했어요.')
      return false
    }

    // 3) 사진을 readFile로 가져와 File로 wrap → DataTransfer로 묶어 handleFiles 호출
    const collectedFiles: File[] = []
    for (const it of imageItems) {
      try {
        const buffer = await eum.fs.readFile(it.path)
        const ext = (it.name.split('.').pop() || 'png').toLowerCase()
        const mime =
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
          ext === 'png' ? 'image/png' :
          ext === 'webp' ? 'image/webp' :
          ext === 'heic' || ext === 'heif' ? 'image/heic' :
          'image/png'
        const blob = new Blob([buffer], { type: mime })
        const file = new File([blob], it.name, { type: mime, lastModified: it.mtime || Date.now() })
        collectedFiles.push(file)
      } catch (err) {
        console.warn(`사진 읽기 실패 「${it.name}」:`, err)
      }
    }
    if (!collectedFiles.length) {
      window.alert('사진을 읽지 못했어요. 폴더 권한을 확인해 주세요.')
      return false
    }

    const dt = new DataTransfer()
    collectedFiles.forEach((f) => dt.items.add(f))
    await handleFiles(dt.files)

    // 4) _정리안.json 메타 복원 시도
    const planJsonPath = join(eumDirPath, '_정리안.json')
    let projectMeta: ProjectSaveFile | null = null
    if (await eum.fs.exists(planJsonPath)) {
      try {
        const buffer = await eum.fs.readFile(planJsonPath)
        const text = new TextDecoder('utf-8').decode(buffer)
        const parsed = JSON.parse(text) as Partial<ProjectSaveFile>
        if (parsed && parsed.app === 'eum-photo') {
          projectMeta = {
            app: 'eum-photo',
            version: parsed.version ?? 1,
            savedAt: parsed.savedAt ?? new Date().toISOString(),
            eventInput: parsed.eventInput ?? '',
            photos: Array.isArray(parsed.photos) ? parsed.photos : [],
            personFolders: Array.isArray(parsed.personFolders) ? parsed.personFolders : [],
          }
        }
      } catch (err) {
        console.warn('_정리안.json 파싱 실패:', err)
      }
    }

    // 5) 「정리」 폴더 트리에서 사람 폴더 자동 추가 (메타 없을 때 fallback)
    if (!projectMeta || projectMeta.personFolders.length === 0) {
      const organizedDirPath = join(eumDirPath, '정리')
      if (await eum.fs.exists(organizedDirPath)) {
        const statusFolders = await eum.fs.listDir(organizedDirPath)
        if (statusFolders.ok) {
          const personNames = new Set<string>()
          for (const statusEntry of statusFolders.items.filter((s) => s.isDirectory)) {
            const personFoldersList = await eum.fs.listDir(statusEntry.path)
            if (personFoldersList.ok) {
              for (const p of personFoldersList.items.filter((p) => p.isDirectory)) {
                personNames.add(p.name)
              }
            }
          }
          if (personNames.size > 0) {
            const newFolders: PersonFolder[] = [...personNames].map((name) => ({
              id: `person-${crypto.randomUUID()}`,
              name,
              parentId: null,
              representativePhotoId: '',
              photoIds: [],
              candidatePhotoIds: [],
              candidateScores: {},
            }))
            setPersonFolders((current) => {
              const existingNames = new Set(current.map((f) => f.name))
              const toAdd = newFolders.filter((f) => !existingNames.has(f.name))
              return toAdd.length ? [...current, ...toAdd] : current
            })
          }
        }
      }
    }

    // 6) 메타가 있으면 폴더 + 사진 매핑 복원 (Web 흐름과 동일)
    if (projectMeta) {
      const meta = projectMeta
      window.setTimeout(() => {
        setPhotos((currentPhotos) => {
          const photoIdByKey = new Map(currentPhotos.map((p) => [getPhotoStorageKey(p), p.id]))
          const folderIdsByPhotoId = new Map<string, string[]>()
          const restoredFolders: PersonFolder[] = meta.personFolders.map((saved) => {
            const photoIds = saved.photoKeys
              .map((k) => photoIdByKey.get(k))
              .filter((id): id is string => Boolean(id))
            for (const photoId of photoIds) {
              const list = folderIdsByPhotoId.get(photoId) ?? []
              list.push(saved.id)
              folderIdsByPhotoId.set(photoId, list)
            }
            return {
              id: saved.id,
              name: saved.name,
              parentId: saved.parentId ?? null,
              representativePhotoId: photoIdByKey.get(saved.representativePhotoKey) ?? '',
              photoIds,
              candidatePhotoIds: saved.candidatePhotoKeys
                .map((k) => photoIdByKey.get(k))
                .filter((id): id is string => Boolean(id)),
              candidateScores: Object.fromEntries(
                Object.entries(saved.candidateScoresByKey ?? {})
                  .map(([k, score]) => {
                    const id = photoIdByKey.get(k)
                    return id ? ([id, score] as [string, number]) : null
                  })
                  .filter((entry): entry is [string, number] => entry !== null),
              ),
            }
          })
          queueMicrotask(() => setPersonFolders(restoredFolders))
          return currentPhotos.map((p) => {
            const ids = folderIdsByPhotoId.get(p.id) ?? []
            const metaPhoto = meta.photos.find((m) => m.key === getPhotoStorageKey(p))
            return {
              ...p,
              personFolderIds: ids,
              studentTags: metaPhoto?.studentTags ?? p.studentTags,
              status: metaPhoto?.status ?? p.status,
            }
          })
        })
      }, 100)
    }

    setProjectMessage(`✅ 「${displayFolderName(rootPath)}」에서 사진 ${collectedFiles.length}장 + 사람 폴더 import 완료`)
    return true
  }

  async function loadFromSavedFolder(handle?: WritableDirectoryHandle): Promise<boolean> {
    const root = handle ?? savedFolderHandle
    if (!root) return false
    setWorkFolderAccess('loading')
    setWorkFolderHint(`「${displayFolderName(root.name)}」 폴더를 불러오는 중입니다.`)

    // Electron 데스크탑 모드: native fs IPC로 직접 처리 (Web FS API 우회 — 권한 무효화 X)
    if (window.eum?.isElectron && savedFolderPath) {
      try {
        const ok = await loadFromSavedFolderElectron(savedFolderPath)
        setWorkFolderAccess('ready')
        return ok
      } catch (err) {
        const reason = err instanceof Error ? err.message : '알 수 없음'
        window.alert(`작업 폴더 불러오기 실패: ${reason}`)
        setWorkFolderAccess('error')
        return false
      }
    }

    try {
      const ok = await verifyDirectoryPermission(root)
      const importedFolderCount = ok ? await importPersonFoldersFromWorkFolder(root) : 0
      if (importedFolderCount > 0) {
        setWorkFolderHint(`「${ORGANIZED_DIR}/${INTERNAL_KEEP_DIR}」에서 사람 폴더 ${importedFolderCount}개를 확인했습니다.`)
      }
      if (!ok) {
        setWorkFolderAccess('needs-permission')
        setWorkFolderHint('브라우저 권한이 필요합니다. 버튼을 눌러 작업 폴더를 다시 연결해 주세요.')
        return false
      }

      // EUM-Photo 폴더 찾기 (없으면 root 자체로 가정)
      let eumDir: WritableDirectoryHandle = root
      try {
        eumDir = await root.getDirectoryHandle('EUM-Photo', { create: false })
      } catch {
        // root 자체가 EUM-Photo
      }

      // 원본 폴더 찾기
      let originalDir: WritableDirectoryHandle | null = null
      try {
        originalDir = await eumDir.getDirectoryHandle('원본', { create: false })
      } catch {
        originalDir = null
      }

      // _정리안.json 읽기 시도 — 형식 검증 후 정상화
      let projectMeta: ProjectSaveFile | null = null
      try {
        const jsonHandle = await eumDir.getFileHandle('_정리안.json')
        if (jsonHandle.getFile) {
          const file = await jsonHandle.getFile()
          const text = await file.text()
          const parsed = JSON.parse(text) as Partial<ProjectSaveFile>
          if (parsed && parsed.app === 'eum-photo') {
            projectMeta = {
              app: 'eum-photo',
              version: parsed.version ?? 1,
              savedAt: parsed.savedAt ?? new Date().toISOString(),
              eventInput: parsed.eventInput ?? '',
              photos: Array.isArray(parsed.photos) ? parsed.photos : [],
              personFolders: Array.isArray(parsed.personFolders) ? parsed.personFolders : [],
            }
          }
        }
      } catch {
        // 메타 없어도 사진만 로드 진행
      }

      if (!originalDir) {
        if (importedFolderCount > 0) {
          setWorkFolderAccess('ready')
          setProjectMessage(`「${ORGANIZED_DIR}/${INTERNAL_KEEP_DIR}」에서 사람 폴더 ${importedFolderCount}개를 불러왔어요.`)
          return true
        }
        window.alert('「EUM-Photo / 원본」 폴더를 찾을 수 없어요. 처음 「작업 저장」을 한 번 진행해 주세요.')
        return false
      }

      // 원본 폴더 안 모든 이미지 파일 수집
      const collectedFiles: File[] = []
      if (originalDir.entries) {
        for await (const [name, child] of originalDir.entries()) {
          if (child.kind === 'file' && (child as WritableFileHandle).getFile) {
            const f = await (child as WritableFileHandle).getFile!()
            if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(name)) {
              collectedFiles.push(f)
            }
          }
        }
      }

      if (!collectedFiles.length) {
        window.alert('「원본」 폴더에서 사진을 찾지 못했어요.')
        return false
      }

      const dt = new DataTransfer()
      collectedFiles.forEach((f) => dt.items.add(f))
      await handleFiles(dt.files)
      setWorkFolderAccess('ready')
      setWorkFolderHint(`「${displayFolderName(root.name)}」에서 사진 ${collectedFiles.length}장을 불러왔습니다.`)

      // 메타 복원 (폴더 트리·태그·분류) — 사진 import 후 storageKey로 매칭
      if (projectMeta) {
        const meta = projectMeta
        window.setTimeout(() => {
          setPhotos((currentPhotos) => {
            const photoIdByKey = new Map(currentPhotos.map((p) => [getPhotoStorageKey(p), p.id]))
            const folderIdsByPhotoId = new Map<string, string[]>()
            const restoredFolders: PersonFolder[] = meta.personFolders.map((saved) => {
              const photoIds = saved.photoKeys
                .map((k) => photoIdByKey.get(k))
                .filter((id): id is string => Boolean(id))
              for (const photoId of photoIds) {
                const list = folderIdsByPhotoId.get(photoId) ?? []
                list.push(saved.id)
                folderIdsByPhotoId.set(photoId, list)
              }
              return {
                id: saved.id,
                name: saved.name,
                parentId: saved.parentId ?? null,
                representativePhotoId: photoIdByKey.get(saved.representativePhotoKey) ?? '',
                photoIds,
                candidatePhotoIds: saved.candidatePhotoKeys
                  .map((k) => photoIdByKey.get(k))
                  .filter((id): id is string => Boolean(id)),
                candidateScores: Object.fromEntries(
                  Object.entries(saved.candidateScoresByKey ?? {})
                    .map(([k, score]) => {
                      const id = photoIdByKey.get(k)
                      return id ? ([id, score] as [string, number]) : null
                    })
                    .filter((entry): entry is [string, number] => entry !== null),
                ),
              }
            })
            // setPersonFolders는 별도 호출 — updater 순수성 유지
            queueMicrotask(() => {
              if (restoredFolders.length > 0) {
                setPersonFolders((current) => mergePersonFoldersByName(current, restoredFolders))
              }
            })
            return currentPhotos.map((p) => {
              const ids = folderIdsByPhotoId.get(p.id) ?? []
              const metaPhoto = meta.photos.find((m) => m.key === getPhotoStorageKey(p))
              return {
                ...p,
                personFolderIds: ids,
                studentTags: metaPhoto?.studentTags ?? p.studentTags,
                status: metaPhoto?.status ?? p.status,
              }
            })
          })
        }, 100)
      }

      setProjectMessage(`✅ 「${displayFolderName(root.name)}」에서 사진 ${collectedFiles.length}장을 불러왔어요.`)
      return true
    } catch (err) {
      console.warn('작업 폴더 자동 로드 실패:', err)
      setWorkFolderAccess('error')
      setWorkFolderHint('작업 폴더를 읽지 못했습니다. 폴더가 이동/삭제됐는지 확인해 주세요.')
      const reason = err instanceof Error ? err.message : '알 수 없음'
      window.alert(`작업 폴더 불러오기 실패: ${reason}`)
      return false
    }
  }

  async function importProject(files: FileList | null) {
    const file = files?.[0]
    if (!file) return

    try {
      const raw = JSON.parse(await file.text()) as Partial<ProjectSaveFile>
      if (raw.app !== 'eum-photo' || raw.version !== 1 || !Array.isArray(raw.photos)) {
        throw new Error('invalid project file')
      }

      const savedPhotos = new Map(raw.photos.map((photo) => [photo.key, photo]))
      const currentPhotoIdsByKey = new Map(photos.map((photo) => [getPhotoStorageKey(photo), photo.id]))
      const importedFolders: PersonFolder[] = Array.isArray(raw.personFolders)
        ? raw.personFolders
            .map((folder) => {
              const photoIds = folder.photoKeys
                .map((key) => currentPhotoIdsByKey.get(key))
                .filter((id): id is string => Boolean(id))
              const candidatePhotoIds = folder.candidatePhotoKeys
                .map((key) => currentPhotoIdsByKey.get(key))
                .filter((id): id is string => Boolean(id))
              const candidateScores = Object.fromEntries(
                folder.candidatePhotoKeys
                  .map((key) => {
                    const photoId = currentPhotoIdsByKey.get(key)
                    return photoId ? [photoId, folder.candidateScoresByKey?.[key] ?? 0] : null
                  })
                  .filter((item): item is [string, number] => Boolean(item)),
              )
              const representativePhotoId = currentPhotoIdsByKey.get(folder.representativePhotoKey) ?? photoIds[0]
              if (!representativePhotoId) return null

              return {
                id: folder.id,
                name: folder.name,
                parentId: folder.parentId ?? null,
                representativePhotoId,
                photoIds: [...new Set([representativePhotoId, ...photoIds])],
                candidatePhotoIds,
                candidateScores,
              }
            })
            .filter((folder): folder is PersonFolder => Boolean(folder))
        : []

      const importedFolderIdsByPhotoId = new Map<string, string[]>()
      importedFolders.forEach((folder) => {
        folder.photoIds.forEach((photoId) => {
          importedFolderIdsByPhotoId.set(photoId, [...(importedFolderIdsByPhotoId.get(photoId) ?? []), folder.id])
        })
      })

      const matchedPhotoKeys = new Set(
        photos.map(getPhotoStorageKey).filter((key) => savedPhotos.has(key)),
      )
      setPhotos((current) =>
        current.map((photo) => {
          const key = getPhotoStorageKey(photo)
          const saved = savedPhotos.get(key)
          if (!saved) return photo

          return {
            ...photo,
            dateKey: saved.dateKey,
            eventTag: saved.eventTag,
            studentTags: saved.studentTags,
            status: saved.status,
            faceCount: saved.faceCount,
            faceBoxes: saved.faceBoxes,
            faceScanStatus: saved.faceScanStatus,
            personFolderIds: importedFolderIdsByPhotoId.get(photo.id) ?? [],
          }
        }),
      )
      setPersonFolders(importedFolders)
      setEventInput(raw.eventInput ?? eventInput)
      setSelectedIds([])
      setProjectMessage(
        `${matchedPhotoKeys.size}장의 사진 작업 상태를 불러왔습니다. 원본 사진을 먼저 추가해야 더 많이 복원됩니다.`,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : '알 수 없음'
      setProjectMessage(
        `이음 포토 백업 파일을 읽지 못했습니다: ${reason}. 「중간 저장」으로 만든 .json 파일이 맞는지 확인해 주세요.`,
      )
    } finally {
      if (projectInputRef.current) projectInputRef.current.value = ''
    }
  }

  async function exportOrganizedZip() {
    if (!photos.length || isZipping) return

    setIsZipping(true)
    const folderCounts: Record<string, number> = {}
    let savedTotal = 0
    try {
      const zip = new JSZip()
      const usedPaths = new Map<string, number>()
      const eventSegment = safePathSegment(`${photos[0]?.dateKey ?? getDateKey(new Date())}_${eventInput}`)

      zip.file(
        '_정리안.csv',
        buildPlanRows()
          .map((row) => row.map(csvEscape).join(','))
          .join('\n'),
      )
      zip.file('_정리안.json', JSON.stringify(buildPlanExport(), null, 2))

      await Promise.all(
        photos.map(async (photo, index) => {
          const extension = getFileExtension(photo.name)
          const statusFolder = STATUS_FOLDER_LABELS[photo.status]
          const peopleNames = photo.personFolderIds
            .map((folderId) => personFolderById.get(folderId)?.name)
            .filter((name): name is string => Boolean(name))
          const targetNames = peopleNames.length ? peopleNames : photo.studentTags
          const fileBuffer = await readPhotoBuffer(photo)

          targetNames.forEach((targetName, targetIndex) => {
            const personSegment = safePathSegment(targetName)
            const baseName = safePathSegment(
              `${photo.dateKey}_${photo.eventTag}_${personSegment}_${STATUS_LABELS.get(photo.status) ?? photo.status}_${String(index + 1).padStart(3, '0')}`,
            )
            const duplicateSuffix = targetNames.length > 1 ? `_단체${targetIndex + 1}` : ''
            const folderPath = `${eventSegment}/${safePathSegment(statusFolder)}/${personSegment}`
            const rawPath = `${folderPath}/${baseName}${duplicateSuffix}.${extension}`
            const usedCount = usedPaths.get(rawPath) ?? 0
            usedPaths.set(rawPath, usedCount + 1)
            const finalPath = usedCount
              ? `${folderPath}/${baseName}${duplicateSuffix}_${usedCount + 1}.${extension}`
              : rawPath

            zip.file(finalPath, fileBuffer)
            const relativeFolder = `${safePathSegment(statusFolder)}/${personSegment}`
            folderCounts[relativeFolder] = (folderCounts[relativeFolder] ?? 0) + 1
            savedTotal += 1
          })
        }),
      )

      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(`eum-photo-${eventSegment}.zip`, blob)
      setProjectMessage(`ZIP 파일 ${photos.length}장을 받았습니다. 다운로드 폴더를 확인해 주세요.`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : '알 수 없음'
      setProjectMessage(`ZIP 만들기에 실패했어요: ${reason}. 사진 수가 너무 많거나 메모리가 부족할 수 있어요.`)
    } finally {
      setIsZipping(false)
    }
  }

  // Electron native fs로 「작업 저장」 — Web FS API 의존 X. 권한 무효화 X.
  async function exportToLocalFolderElectron(rootPath: string): Promise<void> {
    const eum = window.eum!
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const join = (...parts: string[]) => parts.filter(Boolean).join(sep).replace(/[\\/]+/g, sep)

    const eumRoot = join(rootPath, 'EUM-Photo')
    const originalDir = join(eumRoot, '원본')
    const organizedDir = join(eumRoot, '정리')

    setIsFolderSaving(true)
    const folderCounts: Record<string, number> = {}
    let savedOriginal = 0
    let savedOrganized = 0
    const isFirstSave = !(await eum.fs.exists(eumRoot))

    try {
      await eum.fs.ensureDir(eumRoot)
      await eum.fs.ensureDir(originalDir)
      await eum.fs.ensureDir(organizedDir)

      // 「정리」 폴더 stale 청소
      setProjectMessage('이전 「정리」 폴더 정리 중…')
      await eum.fs.emptyDir(organizedDir)

      // 작업 메타
      const csvData = buildPlanRows().map((row) => row.map(csvEscape).join(',')).join('\n')
      await eum.fs.writeFile(join(eumRoot, '_정리안.csv'), csvData)
      await eum.fs.writeFile(join(eumRoot, '_정리안.json'), JSON.stringify(buildPlanExport(), null, 2))

      // 사전 계획 (alias는 「원본」 제외, 정리만)
      const usedOriginalNames = new Map<string, number>()
      const usedOrganizedPaths = new Map<string, number>()
      type Plan = { photo: PhotoItem; originalFinal: string | null; organized: Array<{ statusSegment: string; personSegment: string; finalName: string; folderPath: string }> }
      const plans: Plan[] = photos.map((photo, index) => {
        const extension = getFileExtension(photo.name)
        let originalFinal: string | null = null
        if (!photo.isAlias) {
          const baseOriginal = safePathSegment(photo.name.replace(/\.[^/.]+$/, '')) || `사진_${String(index + 1).padStart(3, '0')}`
          const originalKey = `${baseOriginal}.${extension}`
          const usedOrig = usedOriginalNames.get(originalKey) ?? 0
          usedOriginalNames.set(originalKey, usedOrig + 1)
          originalFinal = usedOrig ? `${baseOriginal}_${usedOrig + 1}.${extension}` : originalKey
        }
        const statusFolder = STATUS_FOLDER_LABELS[photo.status]
        const statusSegment = safePathSegment(statusFolder)
        const peopleNames = photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter((name): name is string => Boolean(name))
        const targetNames = peopleNames.length ? peopleNames : photo.studentTags
        const organized = targetNames.map((targetName, targetIndex) => {
          const personSegment = safePathSegment(targetName)
          const baseName = safePathSegment(
            `${photo.dateKey}_${personSegment}_${STATUS_LABELS.get(photo.status) ?? photo.status}_${String(index + 1).padStart(3, '0')}`,
          )
          const duplicateSuffix = targetNames.length > 1 ? `_단체${targetIndex + 1}` : ''
          const folderPath = `정리/${statusSegment}/${personSegment}`
          const rawPath = `${folderPath}/${baseName}${duplicateSuffix}.${extension}`
          const usedCount = usedOrganizedPaths.get(rawPath) ?? 0
          usedOrganizedPaths.set(rawPath, usedCount + 1)
          const finalName = usedCount
            ? `${baseName}${duplicateSuffix}_${usedCount + 1}.${extension}`
            : `${baseName}${duplicateSuffix}.${extension}`
          return { statusSegment, personSegment, finalName, folderPath }
        })
        return { photo, originalFinal, organized }
      })

      // 디스크 쓰기 (6개씩 배치 병렬)
      const failedReads: string[] = []
      let completed = 0
      await runInBatches(plans, 6, async (plan) => {
        try {
          const buffer = await readPhotoBuffer(plan.photo)
          if (plan.originalFinal) {
            await eum.fs.writeFile(join(originalDir, plan.originalFinal), buffer)
            folderCounts['원본'] = (folderCounts['원본'] ?? 0) + 1
            savedOriginal += 1
          }
          for (const o of plan.organized) {
            const targetDir = join(organizedDir, o.statusSegment, o.personSegment)
            await eum.fs.ensureDir(targetDir)
            await eum.fs.writeFile(join(targetDir, o.finalName), buffer)
            folderCounts[o.folderPath] = (folderCounts[o.folderPath] ?? 0) + 1
            savedOrganized += 1
          }
        } catch (err) {
          failedReads.push(plan.photo.name)
          console.warn(`사진 저장 실패 「${plan.photo.name}」:`, err)
        } finally {
          completed += 1
          if (completed % 5 === 0 || completed === plans.length) {
            setProjectMessage(`저장 중… ${completed}/${plans.length}장`)
          }
        }
      })

      if (failedReads.length) {
        const sample = failedReads.slice(0, 3).join(', ')
        const more = failedReads.length > 3 ? ` 외 ${failedReads.length - 3}장` : ''
        window.alert(`사진 ${failedReads.length}장을 읽지 못해 저장에서 제외했어요: ${sample}${more}`)
      }

      void folderCounts
      if (isFirstSave) {
        window.alert(
          `🎉 첫 저장 완료!\n\n${rootPath}\\EUM-Photo 안에:\n  · 📂 원본 — ${savedOriginal}장\n  · 📂 정리 — ${savedOrganized}장`,
        )
      } else {
        window.alert(`✓ 저장 완료 — 원본 ${savedOriginal}장 · 정리 ${savedOrganized}장`)
      }
    } finally {
      setIsFolderSaving(false)
    }
  }

  async function exportToLocalFolder() {
    if (!photos.length || isFolderSaving) return

    // Electron 데스크탑 모드 — native fs로 본격 저장
    if (window.eum?.isElectron && savedFolderPath) {
      try {
        await exportToLocalFolderElectron(savedFolderPath)
      } catch (err) {
        const reason = err instanceof Error ? err.message : '알 수 없음'
        window.alert(`저장 실패: ${reason}`)
      }
      return
    }

    if (!window.showDirectoryPicker) {
      setProjectMessage('이 브라우저는 폴더 직접 저장을 지원하지 않습니다. Chrome / Edge를 사용해 주세요.')
      return
    }

    setIsFolderSaving(true)
    const folderCounts: Record<string, number> = {}
    let savedOriginal = 0
    let savedOrganized = 0
    const isFirstSave = !savedFolderHandle
    try {
      let root: WritableDirectoryHandle
      let usedSavedHandle = false
      if (savedFolderHandle) {
        const ok = await verifyDirectoryPermission(savedFolderHandle).catch(() => false)
        if (ok) {
          const proceed = window.confirm(
            `이전 저장 위치 「${savedFolderHandle.name}」 폴더에 저장할까요?\n\n다른 곳에 저장하려면 「취소」를 누르고 ⚙ 설정에서 폴더를 변경하세요.`,
          )
          if (!proceed) {
            setIsFolderSaving(false)
            return
          }
          root = savedFolderHandle
          usedSavedHandle = true
        } else {
          window.alert('이전 저장 폴더에 접근할 수 없어요.\n\n작업 폴더 변경은 ⚙ 설정에서만 가능합니다. 설정에서 저장 위치를 다시 선택해 주세요.')
          setIsSettingsOpen(true)
          return
        }
      } else {
        window.alert('아직 저장 위치가 정해지지 않았어요.\n\n⚙ 설정에서 저장 위치를 먼저 선택해 주세요.')
        setIsSettingsOpen(true)
        return
      }
      void usedSavedHandle
      // EUM-Photo 루트 폴더 자동 생성 (Windows에서 ':' 사용 불가하므로 EUM-Photo)
      const eumRoot = await getOrCreateDirectory(root, ['EUM-Photo'])
      const originalDir = await getOrCreateDirectory(eumRoot, ['원본'])
      const organizedDir = await getOrCreateDirectory(eumRoot, ['정리'])

      // 「정리」 폴더 stale 청소 — 이전에 이동·삭제된 사진이 디스크에 남는 문제 방지.
      // 「원본」 폴더는 누적 보존 (사진은 늘 원본을 유지).
      setProjectMessage('이전 「정리」 폴더 정리 중…')
      await emptyDirectory(organizedDir)

      // 작업 메타데이터 (자동 복원용)
      await writeFileToDirectory(eumRoot, '_정리안.csv',
        buildPlanRows().map((row) => row.map(csvEscape).join(',')).join('\n'),
      )
      await writeFileToDirectory(eumRoot, '_정리안.json', JSON.stringify(buildPlanExport(), null, 2))

      // ===== 1단계: 사전 계획 (충돌 회피 직렬 계산, 디스크 I/O 없음) =====
      // 「원본」 폴더에는 alias(복사된 사본)는 제외 — 알리아스는 정리 폴더에만 저장됨.
      type SavePlan = {
        photo: PhotoItem
        originalFinal: string | null  // null이면 「원본」 폴더 저장 X (alias)
        organized: Array<{ statusSegment: string; personSegment: string; finalName: string; folderPath: string }>
      }

      const usedOriginalNames = new Map<string, number>()
      const usedOrganizedPaths = new Map<string, number>()
      const plans: SavePlan[] = photos.map((photo, index) => {
        const extension = getFileExtension(photo.name)

        let originalFinal: string | null = null
        if (!photo.isAlias) {
          const baseOriginal = safePathSegment(photo.name.replace(/\.[^/.]+$/, '')) || `사진_${String(index + 1).padStart(3, '0')}`
          const originalKey = `${baseOriginal}.${extension}`
          const usedOrig = usedOriginalNames.get(originalKey) ?? 0
          usedOriginalNames.set(originalKey, usedOrig + 1)
          originalFinal = usedOrig ? `${baseOriginal}_${usedOrig + 1}.${extension}` : originalKey
        }

        const statusFolder = STATUS_FOLDER_LABELS[photo.status]
        const statusSegment = safePathSegment(statusFolder)
        const peopleNames = photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter((name): name is string => Boolean(name))
        const targetNames = peopleNames.length ? peopleNames : photo.studentTags

        const organized = targetNames.map((targetName, targetIndex) => {
          const personSegment = safePathSegment(targetName)
          const baseName = safePathSegment(
            `${photo.dateKey}_${personSegment}_${STATUS_LABELS.get(photo.status) ?? photo.status}_${String(index + 1).padStart(3, '0')}`,
          )
          const duplicateSuffix = targetNames.length > 1 ? `_단체${targetIndex + 1}` : ''
          const folderPath = `정리/${statusSegment}/${personSegment}`
          const rawPath = `${folderPath}/${baseName}${duplicateSuffix}.${extension}`
          const usedCount = usedOrganizedPaths.get(rawPath) ?? 0
          usedOrganizedPaths.set(rawPath, usedCount + 1)
          const finalName = usedCount
            ? `${baseName}${duplicateSuffix}_${usedCount + 1}.${extension}`
            : `${baseName}${duplicateSuffix}.${extension}`
          return { statusSegment, personSegment, finalName, folderPath }
        })

        return { photo, originalFinal, organized }
      })

      // ===== 2단계: 「정리」 디렉토리 핸들 캐시 (race-safe Promise 캐시) =====
      const organizedDirCache = new Map<string, Promise<WritableDirectoryHandle>>()
      const getOrganizedDir = (statusSegment: string, personSegment: string) => {
        const key = `${statusSegment}/${personSegment}`
        let p = organizedDirCache.get(key)
        if (!p) {
          p = getOrCreateDirectory(organizedDir, [statusSegment, personSegment])
          organizedDirCache.set(key, p)
        }
        return p
      }

      // ===== 3단계: 6개씩 batch 병렬 디스크 쓰기 =====
      const failedReads: string[] = []
      let completedCount = 0
      const totalPlans = plans.length
      await runInBatches(plans, 6, async (plan) => {
        try {
          const fileBuffer = await readPhotoBuffer(plan.photo)
          // 「원본」 폴더 저장은 alias 아닌 사진만 (alias는 plan.originalFinal === null)
          if (plan.originalFinal) {
            await writeFileToDirectory(originalDir, plan.originalFinal, fileBuffer)
            folderCounts['원본'] = (folderCounts['원본'] ?? 0) + 1
            savedOriginal += 1
          }
          for (const o of plan.organized) {
            const targetDirectory = await getOrganizedDir(o.statusSegment, o.personSegment)
            await writeFileToDirectory(targetDirectory, o.finalName, fileBuffer)
            folderCounts[o.folderPath] = (folderCounts[o.folderPath] ?? 0) + 1
            savedOrganized += 1
          }
        } catch (err) {
          failedReads.push(plan.photo.name)
          console.warn(`사진 저장 실패 「${plan.photo.name}」:`, err)
        } finally {
          completedCount += 1
          if (completedCount % 5 === 0 || completedCount === totalPlans) {
            setProjectMessage(`저장 중… ${completedCount}/${totalPlans}장`)
          }
        }
      })

      if (failedReads.length) {
        const sample = failedReads.slice(0, 3).join(', ')
        const more = failedReads.length > 3 ? ` 외 ${failedReads.length - 3}장` : ''
        window.alert(
          `사진 ${failedReads.length}장을 읽지 못해 저장에서 제외했어요: ${sample}${more}\n\n「📂 작업 폴더 열기」로 사진을 다시 불러온 뒤 저장하면 됩니다.`,
        )
      }

      if (isFirstSave) {
        window.alert(
          `🎉 첫 저장 완료!\n\n선택하신 폴더 안에 「EUM-Photo」 폴더가 만들어졌어요.\n  · 📂 원본 — ${savedOriginal}장\n  · 📂 정리 — ${savedOrganized}장\n\n앞으로는 「💾 작업 저장」 한 번 누르고 「확인」만 하면 같은 폴더에 다시 저장됩니다.\n폴더를 옮기거나 삭제했다면 ⚙ 설정에서 「저장 위치 변경」하세요.`,
        )
      } else {
        window.alert(`✓ 저장 완료 — 원본 ${savedOriginal}장 · 정리 ${savedOrganized}장`)
      }
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      const reason = error instanceof Error ? error.message : '알 수 없음'
      if (name === 'AbortError') {
        // 사용자가 폴더 선택 취소 — 조용히 무시
      } else if (name === 'NotAllowedError') {
        window.alert('선택한 위치에 폴더를 만들 권한이 없어요.\n\n「내 문서」, 「바탕화면」, 「C:\\Users\\내이름」 안의 폴더처럼 사용자가 쓸 수 있는 곳을 선택해 주세요.\n(C 드라이브 루트는 관리자 권한이 필요할 수 있어요.)')
      } else if (name === 'NoModificationAllowedError') {
        window.alert('이 폴더는 잠겨 있어 저장할 수 없어요. 다른 폴더를 선택해 주세요.')
      } else {
        window.alert(`로컬 폴더 저장 중 문제가 발생했어요:\n${reason}\n\n파일이 보이지 않거나 읽기 권한이 끊긴 경우, 작업 폴더를 다시 불러온 뒤 저장해 주세요. 저장 위치 변경은 ⚙ 설정에서만 가능합니다.`)
      }
    } finally {
      setIsFolderSaving(false)
    }
  }

  async function exportToGoogleDrive() {
    if (!photos.length || isDriveSaving) return
    if (!GOOGLE_CLIENT_ID) {
      setProjectMessage('Google Drive를 사용하려면 VITE_GOOGLE_CLIENT_ID 환경변수가 필요합니다. README를 참고하세요.')
      return
    }

    setIsDriveSaving(true)
    const folderCounts: Record<string, number> = {}
    let savedOriginal = 0
    let savedOrganized = 0
    try {
      const token = await requestGoogleAccessToken(GOOGLE_CLIENT_ID)
      const rootFolderId = await driveCreateFolder(token, 'EUM-Photo')
      const originalFolderId = await driveCreateFolder(token, '원본', rootFolderId)
      const organizedFolderId = await driveCreateFolder(token, '정리', rootFolderId)

      await driveUploadFile(
        token,
        rootFolderId,
        '_정리안.csv',
        'text/csv;charset=utf-8',
        buildPlanRows()
          .map((row) => row.map(csvEscape).join(','))
          .join('\n'),
      )
      await driveUploadFile(
        token,
        rootFolderId,
        '_정리안.json',
        'application/json;charset=utf-8',
        JSON.stringify(buildPlanExport(), null, 2),
      )

      const statusFolderIds = new Map<string, string>()
      const personFolderIds = new Map<string, string>()
      const usedOriginalNames = new Map<string, number>()
      const usedOrganizedNames = new Map<string, number>()

      for (const [index, photo] of photos.entries()) {
        const extension = getFileExtension(photo.name)

        // 1. 원본 폴더 업로드
        const baseOriginal = safePathSegment(photo.name.replace(/\.[^/.]+$/, '')) || `사진_${String(index + 1).padStart(3, '0')}`
        const originalKey = `${baseOriginal}.${extension}`
        const usedOrig = usedOriginalNames.get(originalKey) ?? 0
        usedOriginalNames.set(originalKey, usedOrig + 1)
        const originalFinal = usedOrig ? `${baseOriginal}_${usedOrig + 1}.${extension}` : originalKey
        await driveUploadFile(token, originalFolderId, originalFinal, photo.file.type || 'image/jpeg', photo.file)
        folderCounts['원본'] = (folderCounts['원본'] ?? 0) + 1
        savedOriginal += 1

        // 2. 정리 폴더 — 분류/사람별
        const statusFolderName = STATUS_FOLDER_LABELS[photo.status]
        const statusKey = safePathSegment(statusFolderName)
        let statusFolderId = statusFolderIds.get(statusKey)
        if (!statusFolderId) {
          statusFolderId = await driveCreateFolder(token, statusKey, organizedFolderId)
          statusFolderIds.set(statusKey, statusFolderId)
        }

        const peopleNames = photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter((name): name is string => Boolean(name))
        const targetNames = peopleNames.length ? peopleNames : photo.studentTags

        for (const [targetIndex, targetName] of targetNames.entries()) {
          const personSegment = safePathSegment(targetName)
          const personKey = `${statusKey}/${personSegment}`
          let personParentId = personFolderIds.get(personKey)
          if (!personParentId) {
            personParentId = await driveCreateFolder(token, personSegment, statusFolderId)
            personFolderIds.set(personKey, personParentId)
          }

          const baseName = safePathSegment(
            `${photo.dateKey}_${personSegment}_${STATUS_LABELS.get(photo.status) ?? photo.status}_${String(index + 1).padStart(3, '0')}`,
          )
          const duplicateSuffix = targetNames.length > 1 ? `_단체${targetIndex + 1}` : ''
          const rawName = `${baseName}${duplicateSuffix}.${extension}`
          const usedCount = usedOrganizedNames.get(`${personKey}/${rawName}`) ?? 0
          usedOrganizedNames.set(`${personKey}/${rawName}`, usedCount + 1)
          const finalName = usedCount
            ? `${baseName}${duplicateSuffix}_${usedCount + 1}.${extension}`
            : rawName

          await driveUploadFile(token, personParentId, finalName, photo.file.type || 'image/jpeg', photo.file)
          folderCounts[`정리/${personKey}`] = (folderCounts[`정리/${personKey}`] ?? 0) + 1
          savedOrganized += 1
        }
      }

      window.alert(`✓ Google Drive 업로드 완료\n\n「EUM-Photo」 폴더에 올렸어요.\n· 원본: ${savedOriginal}장\n· 정리: ${savedOrganized}장\n\ndrive.google.com 에서 확인하세요.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 오류'
      const tip = /access_denied|popup_closed|popup_failed/i.test(message)
        ? ' 로그인 창을 닫거나 권한을 거부하셨어요. 「결과 받기」를 다시 누른 뒤 「Google Drive에 올리기」를 시도해 주세요.'
        : /401|invalid_token|unauthorized/i.test(message)
        ? ' 로그인 세션이 만료됐어요. 다시 시도하면 새 로그인 창이 열립니다.'
        : /403|quota|rate/i.test(message)
        ? ' Drive 용량이 부족하거나 일일 업로드 한도에 가까워요. 잠시 후 다시 시도해 주세요.'
        : /Failed to fetch|NetworkError/i.test(message)
        ? ' 인터넷 연결을 확인해 주세요.'
        : ''
      setProjectMessage(`Google Drive에 올리지 못했어요: ${message}.${tip}`)
    } finally {
      setIsDriveSaving(false)
    }
  }

  const visibleSelectedCount = visiblePhotos.filter((photo) => selectedIds.includes(photo.id)).length

  function selectVisiblePhotos() {
    setSelectedIds(visiblePhotos.map((photo) => photo.id))
    setActivePhotoId(visiblePhotos[0]?.id ?? null)
  }

  function clearFilters() {
    setSearchText('')
    setStatusFilter('all')
    setFaceFilter('all')
  }

  async function rememberWorkFolder(handle: WritableDirectoryHandle, electronPath?: string) {
    setSavedFolderHandle(handle)
    setSavedFolderName(handle.name)
    setWorkFolderAccess('ready')
    setWorkFolderHint('이 폴더가 다음 실행 때도 메인 화면에 표시됩니다.')
    const tasks: Promise<unknown>[] = [
      putMeta(SAVED_FOLDER_HANDLE_KEY, handle),
      putMeta(SAVED_FOLDER_NAME_KEY, handle.name),
    ]
    if (electronPath) {
      setSavedFolderPath(electronPath)
      tasks.push(putMeta(SAVED_FOLDER_PATH_KEY, electronPath))
    }
    await Promise.allSettled(tasks)
    // Electron mode에서는 Web FS API 기반의 importPersonFoldersFromWorkFolder를 호출하지 않음
    // (가짜 handle이 throw). 폴더 트리는 loadFromSavedFolder에서 native fs로 자동 구성.
    if (!electronPath) {
      const folderCount = await importPersonFoldersFromWorkFolder(handle)
      if (folderCount > 0) {
        setWorkFolderHint(`「${ORGANIZED_DIR}/${INTERNAL_KEEP_DIR}」에서 사람 폴더 ${folderCount}개를 불러왔습니다.`)
      }
    }
  }

  async function forgetWorkFolder() {
    setSavedFolderHandle(null)
    setSavedFolderName('')
    setSavedFolderPath('')
    setWorkFolderAccess(window.showDirectoryPicker ? 'none' : 'unsupported')
    setWorkFolderHint(window.showDirectoryPicker ? '작업 폴더를 아직 선택하지 않았습니다.' : '이 브라우저는 작업 폴더 기억을 지원하지 않습니다.')
    await Promise.allSettled([
      deleteMeta(SAVED_FOLDER_HANDLE_KEY),
      deleteMeta(SAVED_FOLDER_NAME_KEY),
      deleteMeta(SAVED_FOLDER_PATH_KEY),
    ])
  }

  async function chooseWorkFolder(loadAfterPick = false) {
    if (!window.showDirectoryPicker) {
      setWorkFolderAccess('unsupported')
      setWorkFolderHint('Chrome 또는 Edge에서 작업 폴더를 기억할 수 있습니다.')
      window.alert('이 브라우저는 폴더 선택을 지원하지 않습니다. Chrome / Edge를 사용해 주세요.')
      return false
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      await rememberWorkFolder(handle)
      if (loadAfterPick) {
        return await loadFromSavedFolder(handle)
      }
      return true
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name !== 'AbortError') {
        setWorkFolderAccess('error')
        setWorkFolderHint('폴더 선택에 실패했습니다. 다시 시도해 주세요.')
        window.alert('폴더 선택에 실패했어요. 다시 시도해 주세요.')
      }
      return false
    }
  }

  async function importPersonFoldersFromWorkFolder(handle?: WritableDirectoryHandle) {
    const root = handle ?? savedFolderHandle
    if (!root) return 0
    const internalDir = await resolveInternalKeepDirectory(root)
    if (!internalDir) return 0

    const summaries = await listChildDirectorySummaries(internalDir)
    if (!summaries.length) return 0
    const existingPhotoIdByKey = new Map(photos.map((photo) => [getPhotoStorageKey(photo), photo.id]))

    setAnalysisProgress({ done: 0, total: summaries.reduce((sum, item) => sum + item.files.length, 0) })
    setIsAnalyzing(true)

    const folderPhotoIdsByName = new Map<string, string[]>()
    const folderIdByName = new Map<string, string>()
    const newPhotoItems: PhotoItem[] = []
    try {
      for (const summary of summaries) {
        const existingFolderPhotoIds: string[] = []
        const files = summary.files.filter((file) => {
          const key = `${file.name}|${file.size}|${file.lastModified}`
          const existingPhotoId = existingPhotoIdByKey.get(key)
          if (existingPhotoId) {
            existingFolderPhotoIds.push(existingPhotoId)
            return false
          }
          if (importedWorkPhotoKeysRef.current.has(key)) return false
          importedWorkPhotoKeysRef.current.add(key)
          return true
        })
        const folderId = personFolders.find((folder) => folder.name === summary.name)?.id ?? `person-${crypto.randomUUID()}`
        folderIdByName.set(summary.name, folderId)
        const items = await buildPhotoItemsFromFiles(files, { personFolderId: folderId })
        folderPhotoIdsByName.set(summary.name, [...existingFolderPhotoIds, ...items.map((item) => item.id)])
        newPhotoItems.push(...items)
      }
    } finally {
      setIsAnalyzing(false)
      setAnalysisProgress({ done: 0, total: 0 })
    }

    if (newPhotoItems.length) {
      setPhotos((current) => [...newPhotoItems, ...current])
      setActivePhotoId((current) => current ?? newPhotoItems[0]?.id ?? null)
      Promise.all(newPhotoItems.map((item) => putPhotoBlob(getPhotoStorageKey(item), item.file))).catch((err) => {
        console.warn('사진 Blob 자동 저장 실패:', err)
      })
    }

    setPersonFolders((current) => {
      const cleanCurrent = current.filter((folder) => !isUnassignedFolderName(folder.name))
      const byName = new Map(cleanCurrent.map((folder) => [folder.name, folder]))
      const incoming = summaries.map(({ name, files }) => {
        const existing = byName.get(name)
        const diskPhotoIds = folderPhotoIdsByName.get(name) ?? []
        const folderId = existing?.id ?? folderIdByName.get(name) ?? `person-${crypto.randomUUID()}`
        const diskPhotoCount = files.length
        return existing
          ? { ...existing, diskPhotoCount, photoIds: [...new Set([...existing.photoIds, ...diskPhotoIds])] }
          : {
              id: folderId,
              name,
              parentId: null,
              diskPhotoCount,
              representativePhotoId: '',
              photoIds: diskPhotoIds,
              candidatePhotoIds: [],
              candidateScores: {},
            }
      })
      return mergePersonFoldersByName(cleanCurrent, incoming)
    })

    return summaries.length
  }

  useEffect(() => {
    if (!projectMessage) return
    const timer = window.setTimeout(() => setProjectMessage(''), 4000)
    return () => window.clearTimeout(timer)
  }, [projectMessage])

  // 설정·저장 핸들 복원 (마운트 시) — 권한 이미 있으면 자동으로 폴더에서 사진 로드
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const handle = await getMeta<WritableDirectoryHandle>(SAVED_FOLDER_HANDLE_KEY)
        const storedFolderName = await getMeta<string>(SAVED_FOLDER_NAME_KEY)
        const storedFolderPath = await getMeta<string>(SAVED_FOLDER_PATH_KEY)
        const method = await getMeta<'local' | 'drive'>('saveMethod')
        const autoOn = await getMeta<boolean>('autoSaveEnabled')
        if (cancelled) return
        if (storedFolderPath) setSavedFolderPath(storedFolderPath)
        if (handle) {
          setSavedFolderHandle(handle)
          setSavedFolderName(handle.name)
          setWorkFolderAccess(storedFolderPath ? 'ready' : 'needs-permission')
          setWorkFolderHint(storedFolderPath ? '데스크탑 모드 — 권한 무관, 즉시 사용 가능' : '최근 작업 폴더를 찾았습니다. 권한이 필요하면 버튼을 눌러 다시 연결하세요.')
        } else if (storedFolderName) {
          setSavedFolderName(storedFolderName)
          setWorkFolderAccess(window.showDirectoryPicker ? 'needs-permission' : 'unsupported')
          setWorkFolderHint('최근 작업 폴더 이름은 기억하지만 브라우저 권한을 다시 받아야 합니다.')
        } else {
          setWorkFolderAccess(window.showDirectoryPicker ? 'none' : 'unsupported')
          setWorkFolderHint(window.showDirectoryPicker ? '작업 폴더를 아직 선택하지 않았습니다.' : 'Chrome 또는 Edge에서 작업 폴더를 기억할 수 있습니다.')
        }
        if (method) setSaveMethod(method)
        if (autoOn !== null) setAutoSaveEnabled(autoOn)

        // 마운트 자동 폴더 로드는 끔: 디스크에서 막 읽은 File 객체도 시간 지나면
        // ERR_UPLOAD_FILE_CHANGED로 무효화됨. 사진 자동 복원은 IDB blob 기반의
        // AUTO_RESTORE_PHOTOS 흐름이 담당. 사용자가 「📂 다시 불러오기」를 누르면
        // 그때 폴더에서 신선한 File로 다시 import.
      } catch (err) {
        console.warn('설정 복원 실패:', err)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 폴더 트리만 별도 즉시 저장 — IDB 자동 복원 실패해도 폴더 구조는 항상 살아있음
  useEffect(() => {
    try {
      const foldersToSave = personFolders.filter((folder) => !isUnassignedFolderName(folder.name))
      if (foldersToSave.length !== personFolders.length) {
        setPersonFolders(foldersToSave)
        return
      }
      if (foldersToSave.length === 0) {
        localStorage.removeItem(FOLDERS_TREE_KEY)
        return
      }
      const compact: SavedFolderTreeEntry[] = foldersToSave.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId ?? null,
        diskPhotoCount: f.diskPhotoCount ?? 0,
      }))
      localStorage.setItem(FOLDERS_TREE_KEY, JSON.stringify(compact))
    } catch {
      // 무시 — quota 등
    }
  }, [personFolders])

  // 자동 복원 (마운트 시 한 번) — 사진은 사용자가 「작업 폴더 열기」로 명시 import만 (안정성 우선)
  const autoRestoredRef = useRef(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const restoreCancelledRef = useRef(false)
  const AUTO_RESTORE_PHOTOS = false
  useEffect(() => {
    if (!AUTO_RESTORE_PHOTOS) {
      autoRestoredRef.current = true
      return
    }
    if (autoRestoredRef.current) return
    autoRestoredRef.current = true
    let cancelled = false
    // 15초 안전망 — 어떤 이유로든 멈추면 복원 스킵
    const safetyTimer = window.setTimeout(() => {
      if (!cancelled) {
        cancelled = true
        restoreCancelledRef.current = true
        setIsRestoring(false)
        console.warn('자동 복원 15초 timeout — 복원 건너뜀')
      }
    }, 15000)
    ;(async () => {
      try {
        const raw = localStorage.getItem(PROJECT_AUTOSAVE_KEY)
        if (!raw) {
          if (!cancelled) setIsRestoring(false)
          return
        }
        const project = JSON.parse(raw) as ProjectSaveFile
        if (project.app !== 'eum-photo') return
        const blobMap = await getAllPhotoBlobs()
        if (cancelled) return
        if (!project.photos.length && !project.personFolders.length) return

        const restoredPhotos: PhotoItem[] = []
        for (const meta of project.photos) {
          const blobInfo = blobMap.get(meta.key)
          if (!blobInfo) continue
          const file = new File([blobInfo.blob], blobInfo.name, {
            type: blobInfo.type,
            lastModified: blobInfo.modifiedAt,
          })
          const url = URL.createObjectURL(file)
          const photoItem: PhotoItem = {
            id: `photo-${crypto.randomUUID()}`,
            file,
            url,
            name: meta.name,
            size: meta.size,
            modifiedAt: new Date(meta.modifiedAt),
            dateKey: meta.dateKey,
            // 캐시된 분석 결과 우선 사용. 없으면 0으로 시작 + 백그라운드 재분석 큐
            hash: meta.hash ?? '',
            blurScore: meta.blurScore ?? 0,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            studentTags: meta.studentTags,
            personFolderIds: [],
            eventTag: meta.eventTag,
            status: meta.status,
            faceCount: meta.faceCount,
            faceBoxes: meta.faceBoxes,
            faceScanStatus: meta.faceScanStatus,
          }
          restoredPhotos.push(photoItem)
        }
        if (cancelled) return

        const photoIdByKey = new Map(restoredPhotos.map((p) => [getPhotoStorageKey(p), p.id]))
        const restoredFolders: PersonFolder[] = project.personFolders.map((saved) => ({
          id: saved.id,
          name: saved.name,
          parentId: saved.parentId ?? null,
          representativePhotoId: photoIdByKey.get(saved.representativePhotoKey) ?? '',
          photoIds: saved.photoKeys
            .map((k) => photoIdByKey.get(k))
            .filter((id): id is string => Boolean(id)),
          candidatePhotoIds: saved.candidatePhotoKeys
            .map((k) => photoIdByKey.get(k))
            .filter((id): id is string => Boolean(id)),
          candidateScores: Object.fromEntries(
            Object.entries(saved.candidateScoresByKey ?? {})
              .map(([k, score]) => {
                const id = photoIdByKey.get(k)
                return id ? ([id, score] as [string, number]) : null
              })
              .filter((entry): entry is [string, number] => entry !== null),
          ),
        }))

        const folderIdsByPhotoId = new Map<string, string[]>()
        for (const folder of restoredFolders) {
          for (const photoId of folder.photoIds) {
            const list = folderIdsByPhotoId.get(photoId) ?? []
            list.push(folder.id)
            folderIdsByPhotoId.set(photoId, list)
          }
        }
        const finalPhotos = restoredPhotos.map((p) => ({
          ...p,
          personFolderIds: folderIdsByPhotoId.get(p.id) ?? [],
        }))

        if (cancelled) return
        setPhotos(finalPhotos)
        // 폴더 트리는 localStorage 즉시 복원 우선 — 자동 복원 메타에 폴더가 있을 때만 적용
        if (restoredFolders.length > 0) {
          setPersonFolders(restoredFolders)
        }
        setEventInput(project.eventInput || '')
        setProjectMessage(
          `이전 작업을 복원했어요. 사진 ${finalPhotos.length}장 · 폴더 ${restoredFolders.length}개.`,
        )
      } catch (err) {
        console.warn('자동 복원 실패:', err)
      } finally {
        window.clearTimeout(safetyTimer)
        if (!cancelled) setIsRestoring(false)
      }
    })()
    return () => {
      cancelled = true
      window.clearTimeout(safetyTimer)
    }
  }, [])

  // 자동 저장 (디바운스 1500ms)
  useEffect(() => {
    if (!autoRestoredRef.current) return
    if (!autoSaveEnabled) return
    const timer = window.setTimeout(() => {
      try {
        if (!photos.length && !personFolders.length) {
          localStorage.removeItem(PROJECT_AUTOSAVE_KEY)
          return
        }
        const photoById = new Map(photos.map((p) => [p.id, p]))
        const project: ProjectSaveFile = {
          app: 'eum-photo',
          version: 1,
          savedAt: new Date().toISOString(),
          eventInput,
          photos: photos.map((photo) => ({
            key: getPhotoStorageKey(photo),
            name: photo.name,
            size: photo.size,
            modifiedAt: photo.modifiedAt.getTime(),
            dateKey: photo.dateKey,
            eventTag: photo.eventTag,
            studentTags: photo.studentTags,
            status: photo.status,
            faceCount: photo.faceCount,
            faceBoxes: photo.faceBoxes,
            faceScanStatus: photo.faceScanStatus,
            hash: photo.hash,
            blurScore: photo.blurScore,
            width: photo.width,
            height: photo.height,
          })),
          personFolders: personFolders.map((folder) => {
            const repPhoto = photoById.get(folder.representativePhotoId)
            return {
              id: folder.id,
              name: folder.name,
              parentId: folder.parentId ?? null,
              representativePhotoKey: repPhoto ? getPhotoStorageKey(repPhoto) : '',
              photoKeys: folder.photoIds
                .map((id) => photoById.get(id))
                .filter((p): p is PhotoItem => Boolean(p))
                .map(getPhotoStorageKey),
              candidatePhotoKeys: folder.candidatePhotoIds
                .map((id) => photoById.get(id))
                .filter((p): p is PhotoItem => Boolean(p))
                .map(getPhotoStorageKey),
              candidateScoresByKey: Object.fromEntries(
                Object.entries(folder.candidateScores)
                  .map(([id, score]) => {
                    const p = photoById.get(id)
                    return p ? ([getPhotoStorageKey(p), score] as [string, number]) : null
                  })
                  .filter((entry): entry is [string, number] => entry !== null),
              ),
            }
          }),
        }
        localStorage.setItem(PROJECT_AUTOSAVE_KEY, JSON.stringify(project))
      } catch (err) {
        console.warn('자동 저장 실패:', err)
      }
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [photos, personFolders, eventInput, autoSaveEnabled])

  useEffect(() => {
    if (!isResultModalOpen) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const modal = document.querySelector<HTMLElement>('.result-modal')
    if (!modal) return

    const focusables = modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusables[0]?.focus()

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsResultModalOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const list = modal!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      previouslyFocused?.focus()
    }
  }, [isResultModalOpen])

  useEffect(() => {
    if (!isPlanMenuOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (planMenuRef.current && !planMenuRef.current.contains(event.target as Node)) {
        setIsPlanMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isPlanMenuOpen])

  useEffect(() => {
    if (!folderContextMenu) return
    function close() {
      setFolderContextMenu(null)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [folderContextMenu])

  useEffect(() => {
    if (!photoContextMenu) return
    function close() {
      setPhotoContextMenu(null)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [photoContextMenu])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isTyping =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

      if (isTyping || !photos.length) return

      if (event.key === 'Escape' && viewerPhotoId) {
        event.preventDefault()
        closeViewer()
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (viewerPhotoId) moveViewerPhoto(-1)
        else moveActivePhoto(-1)
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (viewerPhotoId) moveViewerPhoto(1)
        else moveActivePhoto(1)
      }

      if (event.key === ' ' && activeFolderId && selectedIds.length > 0 && !viewerPhotoId) {
        event.preventDefault()
        movePhotosToFolder(selectedIds, activeFolderId, 'copy')
        setSelectedIds([])
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolderId, moveActivePhoto, moveViewerPhoto, photos, selectedIds, viewerPhotoId])

  return (
    <main className="app-shell">
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <input
        ref={rosterInputRef}
        className="hidden-input"
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => void importRoster(event.target.files)}
      />

      <section
        className="workspace"
        onDragOver={(event) => {
          if (!photos.length) return
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(event) => {
          if (!photos.length) return
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          void handleFiles(event.dataTransfer.files)
        }}
      >
        <header className="topbar">
          <div className="brand-inline">
            <img src="/eum-logo.png" alt="" />
            <div>
              <p className="eyebrow">E:UM Photo MVP</p>
              <h1>교회학교 사진 정리 작업대</h1>
            </div>
          </div>
          <div className="top-actions">
            <input
              ref={projectInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => void importProject(event.target.files)}
            />
            <button
              type="button"
              className="primary-action"
              onClick={() => fileInputRef.current?.click()}
              title="사진 추가 (드래그앤드롭도 가능)"
            >
              <ImagePlus size={18} />
              사진 추가
            </button>
            <button
              type="button"
              onClick={selectVisiblePhotos}
              disabled={!visiblePhotos.length}
              title="현재 화면에 보이는 사진 모두 선택"
            >
              전체 선택
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              disabled={!selectedIds.length}
              title="선택된 사진 모두 해제"
            >
              선택 취소{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
            </button>
            <button
              type="button"
              className="plan-back-action"
              onClick={async () => {
                // 이미 작업 폴더가 지정돼 있으면 picker 없이 바로 다시 불러오기
                if (savedFolderHandle) {
                  await loadFromSavedFolder()
                  return
                }
                setIsSettingsOpen(true)
              }}
              title={
                savedFolderHandle
                  ? `「${displayFolderName(savedFolderName)}」에서 사진을 다시 불러옵니다. 다른 폴더를 쓰려면 ⚙ 설정에서 변경하세요.`
                  : '작업 폴더 선택은 ⚙ 설정에서 가능합니다.'
              }
            >
              {savedFolderHandle
                ? `📂 「${displayFolderName(savedFolderName)}」 다시 불러오기`
                : '⚙ 작업 폴더 설정'}
            </button>
            <button
              type="button"
              className="plan-back-action"
              onClick={() => setIsSettingsOpen(true)}
              title="저장 위치, 저장 방법, 자동 저장 등 환경 설정"
            >
              ⚙ 설정
            </button>
            {window.eum?.isElectron && (
              <button
                type="button"
                className="plan-back-action"
                onClick={async () => {
                  const eum = window.eum!
                  const p = await eum.pickDirectory({ title: 'OS 파일 탐색기에서 열 폴더 선택 (보통 EUM-Photo 위치)' })
                  if (p) {
                    const r = await eum.openInExplorer(p)
                    if (!r.ok) setProjectMessage(`탐색기 열기 실패: ${r.reason ?? '알 수 없음'}`)
                  }
                }}
                title="OS 파일 탐색기에서 EUM-Photo 폴더 열기 (데스크탑 버전 전용)"
              >
                📂 탐색기 열기
              </button>
            )}
            {photos.length > 0 && (
              <>
                <div className="grid-zoom" role="group" aria-label="사진 카드 크기">
                  <button
                    type="button"
                    onClick={() => setGridZoom((v) => Math.max(0, v - 1))}
                    disabled={gridZoom === 0}
                    title="작게 보기 (한 줄에 더 많이)"
                    aria-label="축소"
                  >
                    −
                  </button>
                  <span className="grid-zoom-level">{gridZoom + 1}/{GRID_ZOOM_SIZES.length}</span>
                  <button
                    type="button"
                    onClick={() => setGridZoom((v) => Math.min(GRID_ZOOM_SIZES.length - 1, v + 1))}
                    disabled={gridZoom === GRID_ZOOM_SIZES.length - 1}
                    title="크게 보기"
                    aria-label="확대"
                  >
                    ＋
                  </button>
                </div>
                <button
                  type="button"
                  className="plan-back-action"
                  onClick={() => {
                    setSearchText('')
                    setStatusFilter('all')
                    setFaceFilter('all')
                    setIsSingleMode(false)
                    setSelectedIds([])
                    setFolderDrillIn(null)
                  }}
                  disabled={
                    !searchText &&
                    statusFilter === 'all' &&
                    faceFilter === 'all' &&
                    !isSingleMode &&
                    selectedIds.length === 0 &&
                    !folderDrillIn
                  }
                  title="모든 필터·선택·폴더 보기를 해제하고 전체 사진 화면으로 돌아갑니다."
                >
                  ← 작업 화면
                </button>
                <button
                  type="button"
                  className="result-action"
                  onClick={() => {
                    if (saveMethod === 'drive' && GOOGLE_CLIENT_ID) {
                      void exportToGoogleDrive()
                      return
                    }
                    if (savedFolderHandle) {
                      void exportToLocalFolder()
                      return
                    }
                    setIsResultModalOpen(true)
                  }}
                  disabled={!photos.length}
                  title={
                    savedFolderHandle
                      ? `「${savedFolderName}」 안의 EUM-Photo 폴더에 저장합니다. 위치 변경은 ⚙ 설정에서 가능.`
                      : '저장 위치를 골라 사진과 작업 상태를 보관합니다.'
                  }
                >
                  💾 작업 저장
                </button>
              </>
            )}
            {undoSnapshot && (
              <button
                type="button"
                className="undo-action-floating"
                onClick={performUndo}
                title={`되돌리기: ${undoSnapshot.label}`}
              >
                ↶ 방금 동작 취소
              </button>
            )}
          </div>
        </header>

        {projectMessage && (
          <div className="project-message" role="status">
            <span>{projectMessage}</span>
            <button
              type="button"
              onClick={() => setProjectMessage('')}
              aria-label="메시지 닫기"
              className="project-message-close"
            >
              ✕
            </button>
          </div>
        )}

        {photos.length > 0 && (
          <div
            className="metrics-thin-bar"
            aria-label={`${sortedCount}/${photos.length}장 분류됨`}
            title={`전체 ${photos.length}장 · 분류 ${sortedCount}장`}
          >
            <div
              className="metrics-thin-bar-fill"
              style={{ width: `${Math.round((sortedCount / photos.length) * 100)}%` }}
            />
          </div>
        )}

        {!photos.length ? (
          <section
            className="dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              void handleFiles(event.dataTransfer.files)
            }}
          >
            <ShieldCheck size={40} />
            <h2>사진을 이곳에 끌어오거나 선택하세요</h2>
            <p>JPG, PNG, WebP 사진을 사용자 컴퓨터 안에서만 분석합니다. 서버 업로드는 없습니다.</p>
            <div className={`recent-work-folder recent-work-folder-${workFolderAccess}`} role="status">
              <div>
                <strong>최근 작업 폴더</strong>
                <p>
                  {savedFolderName
                    ? `「${displayFolderName(savedFolderName)}」 / EUM-Photo`
                    : '아직 연결된 작업 폴더가 없습니다.'}
                </p>
                <span>{workFolderHint}</span>
              </div>
              <div className="recent-work-folder-actions">
                {savedFolderHandle ? (
                  <button type="button" onClick={() => void loadFromSavedFolder()} disabled={workFolderAccess === 'loading'}>
                    {workFolderAccess === 'loading' ? '불러오는 중' : '이 폴더 열기'}
                  </button>
                ) : (
                  <button type="button" onClick={() => setIsSettingsOpen(true)} disabled={workFolderAccess === 'unsupported'}>
                    설정에서 선택
                  </button>
                )}
                {savedFolderName && (
                  <button type="button" className="recent-work-folder-muted" onClick={() => void forgetWorkFolder()}>
                    기억 지우기
                  </button>
                )}
              </div>
            </div>

            {savedFolderHandle ? (
              <button
                type="button"
                className="primary-action"
                style={{ width: 'auto', marginBottom: 8 }}
                onClick={() => void loadFromSavedFolder()}
              >
                📂 「{displayFolderName(savedFolderName)}」 작업 폴더에서 사진 불러오기
              </button>
            ) : (
              <button
                type="button"
                className="primary-action"
                style={{ width: 'auto', marginBottom: 8 }}
                onClick={() => setIsSettingsOpen(true)}
              >
                ⚙ 설정에서 작업 폴더 선택하기
              </button>
            )}
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              <ImagePlus size={18} />
              사진 선택
            </button>
            <ol className="dropzone-steps" aria-label="작업 순서">
              <li>
                <strong>1</strong>
                <span>「사진 선택」을 누르거나 사진을 이 영역에 끌어와 추가합니다.</span>
              </li>
              <li>
                <strong>2</strong>
                <span>오른쪽 「📂 폴더 트리」에서 사람별 폴더를 만들고, 사진을 끌어다 분류합니다.</span>
              </li>
              <li>
                <strong>3</strong>
                <span>한 장씩 크게 보며 분류하려면 상단의 「확대」 버튼을 누르세요.</span>
              </li>
              <li>
                <strong>4</strong>
                <span>정리 중간이나 마지막에 상단의 「💾 작업 저장」으로 진행 상황을 JSON 파일로 보관합니다. 다음에 「📂 작업 불러오기」로 이어서 작업할 수 있어요.</span>
              </li>
            </ol>
            <p className="dropzone-warning">
              사진은 이 컴퓨터 안에서만 처리됩니다. 작업 내용(사진·폴더·태그·분류)은 자동으로 저장돼서, 다음에 다시 열어도 그대로 이어집니다.
            </p>
            {savedFolderName ? (
              <p className="dropzone-info">
                저장 위치: 「{savedFolderName}」 안의 EUM-Photo 폴더 ·{' '}
                <button type="button" className="dropzone-info-link" onClick={() => setIsSettingsOpen(true)}>
                  ⚙ 설정에서 변경
                </button>
              </p>
            ) : (
              <p className="dropzone-info">
                아직 저장 위치를 정하지 않았어요. 첫 「💾 작업 저장」 때 폴더를 선택하면 다음부터 자동으로 같은 곳에 저장됩니다.
              </p>
            )}
            {isAnalyzing && analysisProgress.total > 0 && (
              <p className="dropzone-progress" role="status">
                사진 분석 중 {analysisProgress.done}/{analysisProgress.total}
              </p>
            )}
          </section>
        ) : (
          <div className="content-grid">
            <section className="photo-board">
              {folderDrillIn && (() => {
                const target = personFolders.find((f) => f.id === folderDrillIn.folderId)
                if (!target) return null
                if (folderDrillIn.mode === 'candidates') {
                  return (
                    <div className="board-drill-header candidates">
                      <strong>✨ 「{target.name}」 비슷한 얼굴 후보 {target.candidatePhotoIds.length}장</strong>
                      <span>마음에 드는 사진을 클릭으로 선택 → 스페이스로 이 폴더에 추가 (제외할 건 그냥 두면 됨)</span>
                    </div>
                  )
                }
                return (
                  <div className="board-drill-header">
                    <strong>📂 「{target.name}」 폴더 안 — {target.photoIds.length}장</strong>
                    <span>「← 작업 화면」을 누르면 전체 사진으로 돌아갑니다</span>
                  </div>
                )
              })()}
              {isSingleMode && activePhoto && (
                <SingleModeStage
                  photo={activePhoto}
                  index={activeIndex}
                  total={photos.length}
                  onPrev={() => moveActivePhoto(-1)}
                  onNext={() => moveActivePhoto(1)}
                  onClassify={classifyAndAdvance}
                  rosterNames={rosterNames}
                  rosterConsent={rosterConsent}
                  onQuickTag={quickTagActive}
                  consent={photoConsentByPhotoId.get(activePhoto.id)}
                />
              )}
              {isSingleMode && !activePhoto && (
                <div className="single-mode-empty">
                  <p>분류할 사진이 없습니다. 「목록으로 돌아가기」를 누르세요.</p>
                </div>
              )}
              {!isSingleMode && (
              <div
                className="photo-grid"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${GRID_ZOOM_SIZES[gridZoom]}px, 1fr))` }}
              >
                {(() => {
                  const candidateFolder =
                    folderDrillIn?.mode === 'candidates'
                      ? personFolders.find((f) => f.id === folderDrillIn.folderId)
                      : null
                  return visiblePhotos.map((photo) => {
                    const selected = selectedIds.includes(photo.id)
                    const candidateScore = candidateFolder?.candidateScores[photo.id]
                    return (
                      <article
                        className={`photo-card ${selected ? 'selected' : ''} ${
                          activePhotoId === photo.id ? 'active' : ''
                        }`}
                        key={photo.id}
                        draggable
                        onDragStart={(event) => {
                          const ids = selectedIds.includes(photo.id) && selectedIds.length > 0 ? selectedIds : [photo.id]
                          event.dataTransfer.setData('application/x-eum-photo-ids', JSON.stringify(ids))
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onClick={() => {
                          setActivePhotoId(photo.id)
                          toggleSelected(photo.id)
                        }}
                        onDoubleClick={() => openViewer(photo.id)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setActivePhotoId(photo.id)
                          if (!selectedIds.includes(photo.id)) {
                            setSelectedIds((current) => [...current, photo.id])
                          }
                          setPhotoContextMenu({ photoId: photo.id, x: event.clientX, y: event.clientY })
                        }}
                        title="클릭 = 선택 / 더블클릭 = 확대 / 우클릭 = 메뉴 / 드래그 = 폴더로 복사"
                      >
                        <img
                          src={photo.url}
                          alt={photo.name}
                          draggable={false}
                          onError={(event) => {
                            // blob URL stale — 시각적으로만 흐리게 (setState로 인한 무한 루프 방지)
                            const img = event.currentTarget
                            img.style.opacity = '0.2'
                            img.style.filter = 'grayscale(1)'
                          }}
                        />
                        {selected && <span className="photo-check-mark" aria-label="선택됨">✓</span>}
                        {candidateScore !== undefined && (
                          <span className="photo-candidate-badge" title={`유사도 ${candidateScore}%`}>
                            ✨ {candidateScore}%
                          </span>
                        )}
                      </article>
                    )
                  })
                })()}
              </div>
              )}
            </section>

            <section className="plan-panel">
              <div
                className="plan-work-folder"
                title="작업 폴더 변경은 헤더의 ⚙ 설정에서 가능합니다."
              >
                <span className="plan-work-folder-label">
                  📍 작업 폴더 · 사람 폴더 {personFolders.length}개
                </span>
                <span className="plan-work-folder-name">
                  {savedFolderName ? `「${displayFolderName(savedFolderName)}」 / EUM-Photo` : '아직 지정 안 됨 — ⚙ 설정에서 폴더 선택'}
                </span>
              </div>
              <div className="plan-folder-create">
                <input
                  value={personNameInput}
                  onChange={(event) => setPersonNameInput(event.target.value)}
                  placeholder="새 사람 폴더 이름 (예: 김하은)"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      createPersonFolderFromActive()
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={createPersonFolderFromActive}
                  disabled={!normalizeTag(personNameInput)}
                  title="현재 활성 사진을 대표로 새 폴더 만들기"
                >
                  + 만들기
                </button>
              </div>
              {(personFolders.length > 0 || photos.length > 0) && (
                <div className="folder-tree">
                  {personFolders.length > 0 && (
                    <div className="folder-tree-section">
                      {(() => {
                        const childrenMap = new Map<string | null, PersonFolder[]>()
                        for (const f of personFolders) {
                          const key = f.parentId ?? null
                          const list = childrenMap.get(key) ?? []
                          list.push(f)
                          childrenMap.set(key, list)
                        }
                        const flat: Array<{ folder: PersonFolder; depth: number; hasChildren: boolean }> = []
                        const walk = (parentId: string | null, depth: number) => {
                          const children = childrenMap.get(parentId) ?? []
                          for (const child of children) {
                            const hasChildren = (childrenMap.get(child.id) ?? []).length > 0
                            flat.push({ folder: child, depth, hasChildren })
                            if (hasChildren && !collapsedFolderIds.has(child.id)) {
                              walk(child.id, depth + 1)
                            }
                          }
                        }
                        walk(null, 0)
                        return flat.map(({ folder, depth, hasChildren }) => {
                          const collapsed = collapsedFolderIds.has(folder.id)
                          const active = activeFolderId === folder.id
                          return (
                            <div key={folder.id} className="folder-tree-person" style={{ paddingLeft: depth * 14 }}>
                              <div
                                className={`folder-tree-row droppable${active ? ' active' : ''}`}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                  setActiveFolderId(folder.id)
                                  setProjectMessage(`「${folder.name}」 폴더를 선택했습니다. 사진을 우클릭해서 이동/복사할 수 있어요.`)
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault()
                                  setFolderContextMenu({ folderId: folder.id, x: event.clientX, y: event.clientY })
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    setActiveFolderId(folder.id)
                                    setProjectMessage(`「${folder.name}」 폴더를 선택했습니다. 사진을 우클릭해서 이동/복사할 수 있어요.`)
                                  }
                                }}
                                onDragOver={(event) => {
                                  if (event.dataTransfer.types.includes('application/x-eum-photo-ids')) {
                                    event.preventDefault()
                                    event.dataTransfer.dropEffect = 'copy'
                                    event.currentTarget.classList.add('drop-active')
                                  }
                                }}
                                onDragLeave={(event) => {
                                  event.currentTarget.classList.remove('drop-active')
                                }}
                                onDrop={(event) => {
                                  event.currentTarget.classList.remove('drop-active')
                                  const data = event.dataTransfer.getData('application/x-eum-photo-ids')
                                  if (!data) return
                                  event.preventDefault()
                                  const ids = JSON.parse(data) as string[]
                                  movePhotosToFolder(ids, folder.id, 'copy')
                                }}
                                title={`클릭 = 폴더 선택 · 우클릭 = 메뉴 · 드래그앤드롭 = 사진 복사`}
                              >
                                {hasChildren ? (
                                  <button
                                    type="button"
                                    className="folder-tree-toggle"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setCollapsedFolderIds((current) => {
                                        const next = new Set(current)
                                        if (next.has(folder.id)) next.delete(folder.id)
                                        else next.add(folder.id)
                                        return next
                                      })
                                    }}
                                    aria-label={collapsed ? '하위 폴더 펼치기' : '하위 폴더 접기'}
                                    title={collapsed ? '펼치기' : '접기'}
                                  >
                                    {collapsed ? '▶' : '▼'}
                                  </button>
                                ) : (
                                  <span className="folder-tree-toggle-spacer" aria-hidden="true" />
                                )}
                                <span className="folder-tree-icon">📁</span>
                                <span className="folder-tree-name">{folder.name}</span>
                                <span className="folder-tree-count">
                                  {Math.max(folder.photoIds.length, folder.diskPhotoCount ?? 0)}
                                </span>
                              </div>
                            </div>
                          )
                        })
                      })()}
                    </div>
                  )}
                  <div className="folder-tree-section">
                    {STATUS_OPTIONS.filter((option) => option.value !== 'keep').map((option) => {
                      const count = photos.filter((photo) => photo.status === option.value).length
                      if (!count) return null
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className="folder-tree-row droppable"
                          onClick={() => {
                            setStatusFilter(option.value)
                            setProjectMessage(`「${option.label}」 사진만 보기`)
                          }}
                          onDragOver={(event) => {
                            if (event.dataTransfer.types.includes('application/x-eum-photo-ids')) {
                              event.preventDefault()
                              event.dataTransfer.dropEffect = 'move'
                              event.currentTarget.classList.add('drop-active')
                            }
                          }}
                          onDragLeave={(event) => {
                            event.currentTarget.classList.remove('drop-active')
                          }}
                          onDrop={(event) => {
                            event.currentTarget.classList.remove('drop-active')
                            const data = event.dataTransfer.getData('application/x-eum-photo-ids')
                            if (!data) return
                            event.preventDefault()
                            const ids = JSON.parse(data) as string[]
                            captureSnapshot(`${ids.length}장을 「${option.label}」로 분류`)
                            setStatusForPhotos(ids, option.value)
                            setProjectMessage(`${ids.length}장을 「${option.label}」로 분류했어요.`)
                          }}
                          title={`${option.label} 사진만 보기 · 드래그로 분류`}
                        >
                          <span className="folder-tree-icon">
                            {option.value === 'featured' ? '⭐' : option.value === 'public_candidate' ? '👁' : option.value === 'exclude' ? '🗑' : '📂'}
                          </span>
                          <span className="folder-tree-name">{option.label}</span>
                          <span className="folder-tree-count">{count}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {rosterNames.length > 0 && (
                <div className="plan-roster">
                  <strong>📋 학생 명단 ({rosterMatch.entries.length}명)</strong>
                  {rosterMessage && <p className="plan-roster-msg">{rosterMessage}</p>}
                  <div className="roster-chip-list">
                    {rosterNames.map((name) => {
                      const count = rosterMatch.entries.find((entry) => entry.name === name)?.count ?? 0
                      const consent = rosterConsent[name]
                      const consentClass =
                        consent === 'yes'
                          ? 'consent-yes'
                          : consent === 'no'
                          ? 'consent-no'
                          : consent === 'unknown'
                          ? 'consent-unknown'
                          : ''
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => applyRosterName(name)}
                          className={`${count > 0 ? 'roster-chip-covered' : 'roster-chip-uncovered'} ${consentClass}`.trim()}
                          title={count > 0 ? `${count}장 매칭 · 클릭하면 사진만 보기` : '아직 매칭 없음'}
                        >
                          {consent === 'yes' && <span className="consent-mark">✓</span>}
                          {consent === 'no' && <span className="consent-mark">✗</span>}
                          {consent === 'unknown' && <span className="consent-mark">?</span>}
                          {name}
                          {count > 0 && <span className="roster-chip-count">{count}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </section>
      {isResultModalOpen && (
        <div
          className="result-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="작업 저장"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsResultModalOpen(false)
          }}
        >
          <section className="result-modal">
            <header>
              <h2>작업을 어디에 저장할까요?</h2>
              <p>「EUM-Photo」 폴더 안에 「원본」 / 「정리」 두 폴더로 나눠 저장됩니다. 원하는 위치를 자유롭게 선택하세요.</p>
              <button type="button" className="result-modal-close" onClick={() => setIsResultModalOpen(false)} aria-label="닫기">
                ✕
              </button>
            </header>
            <div className="result-cards">
              {typeof window !== 'undefined' && window.showDirectoryPicker && (
                <button
                  type="button"
                  className="result-card primary"
                  disabled={isFolderSaving}
                  onClick={() => {
                    setIsResultModalOpen(false)
                    void exportToLocalFolder()
                  }}
                >
                  <FolderInput size={32} />
                  <div className="result-card-text">
                    <strong>내 컴퓨터 (로컬)</strong>
                    <p>창이 뜨면 원하는 폴더를 선택하세요 (C 드라이브, D 드라이브, 바탕화면, 내 문서 등 어디든 가능). 그 안에 「EUM-Photo」 폴더를 자동으로 만들고 「원본」/「정리」로 나눠 저장합니다. (Chrome / Edge 권장)</p>
                  </div>
                </button>
              )}
              {GOOGLE_CLIENT_ID && (
                <button
                  type="button"
                  className="result-card"
                  disabled={isDriveSaving}
                  onClick={() => {
                    setIsResultModalOpen(false)
                    void exportToGoogleDrive()
                  }}
                >
                  <Upload size={32} />
                  <div className="result-card-text">
                    <strong>Google Drive (웹하드)</strong>
                    <p>드라이브에 「EUM-Photo」 폴더를 만들고 「원본」/「정리」로 나눠 올립니다. 다른 기기에서도 접근 가능합니다.</p>
                  </div>
                </button>
              )}
            </div>
          </section>
        </div>
      )}
      {isSettingsOpen && (
        <div
          className="result-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="설정"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsSettingsOpen(false)
          }}
        >
          <section className="result-modal settings-modal">
            <header>
              <h2>⚙ 설정</h2>
              <p>저장 위치, 저장 방법, 자동 저장 등을 변경할 수 있어요.</p>
              <button
                type="button"
                className="result-modal-close"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="닫기"
              >
                ✕
              </button>
            </header>
            <div className="settings-list">
              <section className="settings-row">
                <div>
                  <strong>저장 위치 (로컬)</strong>
                  <p>
                    {savedFolderName
                      ? `현재: 「${displayFolderName(savedFolderName)}」 안의 EUM-Photo 폴더 — 한 번 정하면 잠깁니다. 변경하려면 아래 「모든 데이터 초기화」를 사용하세요.`
                      : '아직 위치를 정하지 않았어요. 「선택」 버튼으로 정하면 그 위치로 잠깁니다.'}
                  </p>
                </div>
                <div className="settings-row-actions">
                  {!savedFolderName && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          // Electron 환경이면 OS native dialog 사용 (Web showDirectoryPicker 우회)
                          if (window.eum?.isElectron) {
                            const p = await window.eum.pickDirectory({ title: '작업 폴더 선택' })
                            if (!p) return
                            const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
                            const fakeHandle = {
                              name: base,
                              kind: 'directory' as const,
                              queryPermission: async () => 'granted' as const,
                              requestPermission: async () => 'granted' as const,
                              getDirectoryHandle: async () => { throw new Error('Electron 모드에서는 디스크 IO가 라운드 3에서 native fs로 전환됩니다.') },
                              getFileHandle: async () => { throw new Error('Electron 모드에서는 디스크 IO가 라운드 3에서 native fs로 전환됩니다.') },
                            } as unknown as WritableDirectoryHandle
                            await rememberWorkFolder(fakeHandle, p)
                            window.alert(`✓ 저장 위치를 「${base}」(으)로 정했어요.\n(전체 경로: ${p})`)
                            return
                          }
                          if (!window.showDirectoryPicker) {
                            window.alert('이 환경은 폴더 선택을 지원하지 않습니다.')
                            return
                          }
                          const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
                          await rememberWorkFolder(handle)
                          window.alert(`✓ 저장 위치를 「${handle.name}」(으)로 정했어요.`)
                        } catch (err) {
                          const name = err instanceof DOMException ? err.name : ''
                          if (name !== 'AbortError') {
                            const reason = err instanceof Error ? err.message : '알 수 없음'
                            window.alert(`폴더 선택에 실패했어요: ${reason}`)
                          }
                        }
                      }}
                    >
                      선택
                    </button>
                  )}
                  {savedFolderName && (
                    <span style={{ fontSize: 12, color: '#475569' }}>🔒 잠김</span>
                  )}
                </div>
              </section>
              <section className="settings-row">
                <div>
                  <strong>저장 방법</strong>
                  <p>「💾 작업 저장」 클릭 시 어디에 저장할지 기본값을 정합니다.</p>
                </div>
                <div className="settings-row-actions">
                  <label>
                    <input
                      type="radio"
                      name="save-method"
                      checked={saveMethod === 'local'}
                      onChange={() => {
                        setSaveMethod('local')
                        void putMeta('saveMethod', 'local')
                      }}
                    />
                    내 컴퓨터
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="save-method"
                      checked={saveMethod === 'drive'}
                      onChange={() => {
                        setSaveMethod('drive')
                        void putMeta('saveMethod', 'drive')
                      }}
                      disabled={!GOOGLE_CLIENT_ID}
                    />
                    Google Drive {!GOOGLE_CLIENT_ID && '(미설정)'}
                  </label>
                </div>
              </section>
              <section className="settings-row">
                <div>
                  <strong>자동 저장</strong>
                  <p>변경할 때마다 브라우저 안에 자동 저장합니다. 다음 접속 시 자동 복원돼요.</p>
                </div>
                <div className="settings-row-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={autoSaveEnabled}
                      onChange={(event) => {
                        setAutoSaveEnabled(event.target.checked)
                        void putMeta('autoSaveEnabled', event.target.checked)
                      }}
                    />
                    켜기
                  </label>
                </div>
              </section>
              <section className="settings-row">
                <div>
                  <strong>모든 데이터 초기화</strong>
                  <p>사진·폴더·자동 저장 데이터·저장 위치 기억까지 모두 지워요. 되돌릴 수 없어요.</p>
                </div>
                <div className="settings-row-actions">
                  <button
                    type="button"
                    className="folder-context-danger"
                    onClick={async () => {
                      if (!window.confirm('정말 모든 데이터를 지울까요?\n사진·폴더·태그·분류·저장 위치 기억까지 모두 사라집니다.')) return
                      photos.forEach((photo) => URL.revokeObjectURL(photo.url))
                      try { await clearAllPhotoBlobs() } catch {}
                      await forgetWorkFolder()
                      try { localStorage.removeItem(PROJECT_AUTOSAVE_KEY) } catch {}
                      try { localStorage.removeItem(FOLDERS_TREE_KEY) } catch {}
                      setPhotos([])
                      setPersonFolders([])
                      setSelectedIds([])
                      setActivePhotoId(null)
                      setIsSettingsOpen(false)
                      window.alert('모든 데이터를 지웠습니다.')
                    }}
                  >
                    초기화
                  </button>
                </div>
              </section>
            </div>
          </section>
        </div>
      )}
      {viewerPhoto && (
        <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={`${viewerPhoto.name} 확대 보기`} onClick={(event) => { if (event.target === event.currentTarget) closeViewer() }}>
          <section className="viewer">
            <header className="viewer-header">
              <div>
                <strong>{viewerPhoto.name}</strong>
                <span>
                  {viewerIndex + 1}/{photos.length} · {viewerPhoto.width}×{viewerPhoto.height} ·{' '}
                  {STATUS_LABELS.get(viewerPhoto.status)}
                </span>
              </div>
              <div className="viewer-actions">
                <button
                  type="button"
                  onClick={() => moveViewerPhoto(-1)}
                  disabled={viewerIndex <= 0}
                  title="이전 사진"
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => moveViewerPhoto(1)}
                  disabled={viewerIndex < 0 || viewerIndex >= photos.length - 1}
                  title="다음 사진"
                >
                  <ArrowRight size={16} />
                </button>
                <button type="button" className="viewer-close" onClick={closeViewer} title="닫기">
                  닫기
                </button>
              </div>
            </header>
            <div className="viewer-body">
              <div className="viewer-image-frame">
                <img src={viewerPhoto.url} alt={viewerPhoto.name} />
                {viewerPhoto.faceBoxes.map((box, index) => (
                  <button
                    key={`${viewerPhoto.id}-face-${index}`}
                    type="button"
                    className={`face-box ${selectedFaceIndex === index ? 'selected' : ''}`}
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                    onClick={() => setSelectedFaceIndex(index)}
                    title={`얼굴 ${index + 1}`}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            </div>
            <footer className="viewer-footer">
              {viewerPhoto.faceBoxes.length > 0 && (
                <div className="viewer-face-tools">
                  <span>
                    {selectedFaceIndex === null
                      ? '얼굴 박스를 선택하세요'
                      : `얼굴 ${selectedFaceIndex + 1} 선택됨`}
                  </span>
                  <input
                    value={personNameInput}
                    onChange={(event) => setPersonNameInput(event.target.value)}
                    placeholder="이름 입력"
                  />
                  <button
                    type="button"
                    onClick={createPersonFolderFromSelectedFace}
                    disabled={selectedFaceIndex === null || !normalizeTag(personNameInput)}
                  >
                    <UserRoundPlus size={15} />
                    인물 등록
                  </button>
                </div>
              )}
              {STATUS_OPTIONS.map((option) => {
                const Icon = option.icon

                return (
                  <button
                    key={option.value}
                    type="button"
                    className={viewerPhoto.status === option.value ? 'active' : ''}
                    onClick={() => setStatusForPhotos([viewerPhoto.id], option.value)}
                  >
                    <Icon size={15} />
                    {option.label}
                  </button>
                )
              })}
            </footer>
          </section>
        </div>
      )}
      {photoContextMenu && (() => {
        const target = photos.find((p) => p.id === photoContextMenu.photoId)
        if (!target) return null
        const targetIds = selectedIds.includes(target.id) && selectedIds.length > 0 ? selectedIds : [target.id]
        const activeFolder = activeFolderId ? personFolders.find((f) => f.id === activeFolderId) : null
        const groupSize = targetIds.length
        const targets = targetIds
          .map((id) => photos.find((p) => p.id === id))
          .filter((p): p is PhotoItem => Boolean(p))
        const hasMultiPerson = targets.some((p) => (p.faceCount ?? 0) >= 2)
        const insideActiveFolder =
          folderDrillIn?.mode === 'photos' &&
          activeFolder !== null &&
          activeFolder !== undefined &&
          folderDrillIn.folderId === activeFolder.id
        return (
          <div
            className="folder-context-menu"
            style={{ top: photoContextMenu.y, left: photoContextMenu.x }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {groupSize === 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPhotoContextMenu(null)
                  openViewer(target.id)
                }}
              >
                🔍 확대 보기
              </button>
            )}
            {insideActiveFolder ? (
              <button
                type="button"
                role="menuitem"
                title={`이 사진을 「${activeFolder!.name}」 폴더에서 빼기 (메인 원본은 유지)`}
                onClick={() => {
                  setPhotoContextMenu(null)
                  removePhotosFromFolder(targetIds, activeFolder!.id)
                }}
              >
                📂 폴더에서 빼기{groupSize > 1 ? ` · ${groupSize}장` : ''}
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled={!activeFolder}
                title={activeFolder ? `「${activeFolder.name}」 폴더로 복사 (메인에 원본은 그대로)` : '먼저 오른쪽 사람 폴더를 선택하세요'}
                onClick={() => {
                  setPhotoContextMenu(null)
                  if (activeFolder) movePhotosToFolder(targetIds, activeFolder.id, 'copy')
                }}
              >
                ⎘ 복사{activeFolder ? ` → 「${activeFolder.name}」` : ''}{groupSize > 1 ? ` (${groupSize}장)` : ''}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="folder-context-danger"
              onClick={() => {
                setPhotoContextMenu(null)
                deletePhotos(targetIds)
              }}
            >
              🗑 삭제{groupSize > 1 ? ` (${groupSize}장)` : ''}
            </button>
          </div>
        )
      })()}
      {folderContextMenu && (() => {
        const target = personFolders.find((f) => f.id === folderContextMenu.folderId)
        if (!target) return null
        const hasPhotos = target.photoIds.length > 0
        const isActive = activeFolderId === target.id
        return (
          <div
            className="folder-context-menu"
            style={{ top: folderContextMenu.y, left: folderContextMenu.x }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFolderContextMenu(null)
                setActiveFolderId(target.id)
                setProjectMessage(`「${target.name}」 폴더를 선택했습니다. 사진을 우클릭해서 이동/복사할 수 있어요.`)
              }}
            >
              {isActive ? '✓ 폴더 선택됨' : '✓ 폴더 선택'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFolderContextMenu(null)
                addSubFolder(target.id)
              }}
            >
              + 하위 폴더 만들기
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!hasPhotos}
              title={hasPhotos ? '대표 사진과 비슷한 얼굴 자동 추천' : '폴더에 사진을 먼저 넣어주세요'}
              onClick={() => {
                setFolderContextMenu(null)
                findSimilarCandidates(target.id)
                setFolderDrillIn({ folderId: target.id, mode: 'candidates' })
                setSearchText('')
                setStatusFilter('all')
                setFaceFilter('all')
                setSelectedIds([])
              }}
            >
              ✨ 비슷한 얼굴 찾기
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFolderContextMenu(null)
                renamePersonFolder(target.id)
              }}
            >
              이름 변경
            </button>
            <button
              type="button"
              role="menuitem"
              className="folder-context-danger"
              onClick={() => {
                setFolderContextMenu(null)
                deletePersonFolder(target.id)
              }}
            >
              삭제
            </button>
          </div>
        )
      })()}

      <footer
        style={{
          textAlign: 'center',
          margin: '24px auto 32px',
          fontSize: 12,
          opacity: 0.6,
        }}
      >
        오류 신고 · 문의 :{' '}
        <a
          href="mailto:lgh544092@gmail.com?subject=%5B%EC%9D%B4%EC%9D%8C%20%ED%8F%AC%ED%86%A0%5D%20%EB%AC%B8%EC%9D%98%C2%B7%EC%98%A4%EB%A5%98%20%EC%A0%9C%EB%B3%B4"
          style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 4 }}
        >
          lgh544092@gmail.com
        </a>
      </footer>
    </main>
  )
}

export default App
