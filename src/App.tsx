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
  Tags,
  Trash2,
  Upload,
  UserRoundPlus,
  Users,
  WandSparkles,
  XCircle,
} from 'lucide-react'
import './App.css'

type PhotoStatus = 'keep' | 'featured' | 'public_candidate' | 'exclude'
type StatusFilter = PhotoStatus | 'all'
type FaceFilter = 'all' | 'has_face' | 'no_face' | 'not_scanned'

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
}

type PersonFolder = {
  id: string
  name: string
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
}

type SavedPersonFolder = {
  id: string
  name: string
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
  createWritable: () => Promise<WritableFileStreamHandle>
}

type WritableDirectoryHandle = {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<WritableDirectoryHandle>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandle>
}

type GoogleTokenResponse = { access_token: string; expires_in: number; error?: string }
type GoogleTokenClient = {
  callback: (response: GoogleTokenResponse) => void
  requestAccessToken: (overrideOptions?: { prompt?: string }) => void
}

declare global {
  interface Window {
    FaceDetector?: FaceDetectorConstructor
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<WritableDirectoryHandle>
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
const STATUS_KEYS: Record<PhotoStatus, string> = {
  keep: '1',
  featured: '2',
  public_candidate: '3',
  exclude: '4',
}
const STATUS_SHORTCUTS: Record<string, PhotoStatus> = {
  '1': 'keep',
  '2': 'featured',
  '3': 'public_candidate',
  '4': 'exclude',
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
            왼쪽 사이드바 「학생 명단 CSV」에서 명단을 불러오면 여기서 한 번에 태그할 수 있어요.
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
  const [studentInput, setStudentInput] = useState('')
  const [personNameInput, setPersonNameInput] = useState('')
  const [personFolders, setPersonFolders] = useState<PersonFolder[]>([])
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
  const [viewerZoom, setViewerZoom] = useState(1)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState({ done: 0, total: 0 })
  const [isZipping, setIsZipping] = useState(false)
  const [isFolderSaving, setIsFolderSaving] = useState(false)
  const [isDriveSaving, setIsDriveSaving] = useState(false)
  const [isPlanMenuOpen, setIsPlanMenuOpen] = useState(false)
  const planMenuRef = useRef<HTMLDivElement | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isResultModalOpen, setIsResultModalOpen] = useState(false)
  const [isSingleMode, setIsSingleMode] = useState(false)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [lastSaveResult, setLastSaveResult] = useState<SaveResult | null>(null)
  const [undoSnapshot, setUndoSnapshot] = useState<{
    photos: PhotoItem[]
    personFolders: PersonFolder[]
    label: string
  } | null>(null)
  const [isFaceScanning, setIsFaceScanning] = useState(false)
  const [faceScanMessage, setFaceScanMessage] = useState('')
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

  const cumulativeStats = useMemo(() => {
    const peopleCounts = new Map<string, number>()
    const eventEntries = archivedPlans.map((plan) => {
      Object.entries(plan.peopleCounts).forEach(([name, count]) => {
        peopleCounts.set(name, (peopleCounts.get(name) ?? 0) + count)
      })
      return plan
    })
    const totalPhotos = archivedPlans.reduce((sum, plan) => sum + plan.photoCount, 0)
    const ranking = [...peopleCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)

    return { eventEntries, totalPhotos, ranking, eventCount: archivedPlans.length }
  }, [archivedPlans])

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

    return photos.filter((photo) => {
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
  }, [faceFilter, personFolderById, photos, searchText, statusFilter])

  const groups = useMemo(() => {
    const grouped = new Map<string, PhotoItem[]>()
    visiblePhotos.forEach((photo) => {
      const label = `${photo.dateKey}/${photo.eventTag || '미분류'}`
      grouped.set(label, [...(grouped.get(label) ?? []), photo])
    })
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visiblePhotos])

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

  function applyTagsToSelected() {
    const tags = studentInput
      .split(',')
      .map(normalizeTag)
      .filter(Boolean)
    const eventTag = normalizeTag(eventInput)

    if (!selectedIds.length || (!tags.length && !eventTag)) return

    captureSnapshot(`${selectedIds.length}장에 학생 이름 태그`)
    setPhotos((current) =>
      current.map((photo) => {
        if (!selectedIds.includes(photo.id)) return photo

        return {
          ...photo,
          eventTag: eventTag || photo.eventTag,
          studentTags: [...new Set([...photo.studentTags, ...tags])],
        }
      }),
    )
  }

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
    const representativePhotoId = viewerPhotoId ?? activePhotoId ?? photos[0]?.id
    if (!name || !representativePhotoId) return

    captureSnapshot(`「${name}」 사람별 모음 만들기`)
    const folderId = `person-${crypto.randomUUID()}`
    setPersonFolders((current) => [
      ...current,
      {
        id: folderId,
        name,
        representativePhotoId,
        photoIds: [representativePhotoId],
        candidatePhotoIds: [],
        candidateScores: {},
      },
    ])
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === representativePhotoId
          ? { ...photo, personFolderIds: [...new Set([...photo.personFolderIds, folderId])] }
          : photo,
      ),
    )
    setPersonNameInput('')
  }

  function assignSelectedToPerson(folderId: string) {
    if (!selectedIds.length) return
    const folderName = personFolderById.get(folderId)?.name ?? '사람별 모음'
    captureSnapshot(`${selectedIds.length}장을 「${folderName}」에 배정`)
    setPersonFolders((current) =>
      current.map((folder) =>
        folder.id === folderId
          ? { ...folder, photoIds: [...new Set([...folder.photoIds, ...selectedIds])] }
          : folder,
      ),
    )
    setPhotos((current) =>
      current.map((photo) =>
        selectedIds.includes(photo.id)
          ? { ...photo, personFolderIds: [...new Set([...photo.personFolderIds, folderId])] }
          : photo,
      ),
    )
  }

  function findSimilarCandidates(folderId: string) {
    const folder = personFolderById.get(folderId)
    const representative = photos.find((photo) => photo.id === folder?.representativePhotoId)
    if (!folder || !representative) return

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

  function approveCandidate(folderId: string, photoId: string) {
    captureSnapshot('후보 승인')
    setPersonFolders((current) =>
      current.map((folder) =>
        folder.id === folderId
          ? {
              ...folder,
              photoIds: [...new Set([...folder.photoIds, photoId])],
              candidatePhotoIds: folder.candidatePhotoIds.filter((candidateId) => candidateId !== photoId),
              candidateScores: Object.fromEntries(
                Object.entries(folder.candidateScores).filter(([candidateId]) => candidateId !== photoId),
              ),
            }
          : folder,
      ),
    )
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === photoId
          ? { ...photo, personFolderIds: [...new Set([...photo.personFolderIds, folderId])] }
          : photo,
      ),
    )
  }

  function rejectCandidate(folderId: string, photoId: string) {
    captureSnapshot('후보 제외')
    setPersonFolders((current) =>
      current.map((folder) =>
        folder.id === folderId
          ? {
              ...folder,
              candidatePhotoIds: folder.candidatePhotoIds.filter((candidateId) => candidateId !== photoId),
              candidateScores: Object.fromEntries(
                Object.entries(folder.candidateScores).filter(([candidateId]) => candidateId !== photoId),
              ),
            }
          : folder,
      ),
    )
  }

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

  const setActivePhotoStatus = useCallback((status: PhotoStatus) => {
    const targetId = activePhotoId ?? photos[0]?.id
    if (!targetId) return
    const label = STATUS_LABELS.get(status) ?? status
    captureSnapshot(`「${label}」로 분류`)
    setStatusForPhotos([targetId], status)
    const targetIndex = photos.findIndex((photo) => photo.id === targetId)
    if (targetIndex >= 0 && targetIndex < photos.length - 1) {
      setActivePhotoId(photos[targetIndex + 1].id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhotoId, photos, setStatusForPhotos])

  const moveViewerPhoto = useCallback((direction: -1 | 1) => {
    if (!photos.length) return
    const currentIndex = viewerIndex >= 0 ? viewerIndex : activeIndex >= 0 ? activeIndex : 0
    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), photos.length - 1)
    setViewerPhotoId(photos[nextIndex].id)
    setActivePhotoId(photos[nextIndex].id)
    setSelectedFaceIndex(null)
    setViewerZoom(1)
  }, [activeIndex, photos, viewerIndex])

  function openViewer(photoId: string) {
    setViewerPhotoId(photoId)
    setActivePhotoId(photoId)
    setSelectedFaceIndex(null)
    setViewerZoom(1)
  }

  function closeViewer() {
    setViewerPhotoId(null)
    setSelectedFaceIndex(null)
    setViewerZoom(1)
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
    if (!window.confirm(`인물 폴더 「${folder.name}」을 지웁니다. 사진 자체는 남고 폴더 배정만 풀립니다.`)) return
    setPersonFolders((current) => current.filter((entry) => entry.id !== folderId))
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
                id: `person-${crypto.randomUUID()}`,
                name: folder.name,
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
          const fallbackNames = photo.studentTags.length ? photo.studentTags : ['미지정']
          const targetNames = peopleNames.length ? peopleNames : fallbackNames
          const fileBuffer = await photo.file.arrayBuffer()

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
      setLastSaveResult({
        method: 'zip',
        rootName: `eum-photo-${eventSegment}.zip`,
        totalPhotos: savedTotal,
        folderCounts,
        locationHint: '브라우저 다운로드 폴더',
        savedAt: Date.now(),
      })
      setProjectMessage(`ZIP 파일 ${photos.length}장을 받았습니다. 다운로드 폴더를 확인해 주세요.`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : '알 수 없음'
      setProjectMessage(`ZIP 만들기에 실패했어요: ${reason}. 사진 수가 너무 많거나 메모리가 부족할 수 있어요.`)
    } finally {
      setIsZipping(false)
    }
  }

  async function exportToLocalFolder() {
    if (!photos.length || isFolderSaving) return

    if (!window.showDirectoryPicker) {
      setProjectMessage('현재 브라우저는 폴더 직접 저장을 지원하지 않습니다. 정리본 ZIP을 사용하세요.')
      return
    }

    setIsFolderSaving(true)
    const folderCounts: Record<string, number> = {}
    let savedTotal = 0
    try {
      const root = await window.showDirectoryPicker({ mode: 'readwrite' })
      const eventSegment = safePathSegment(`${photos[0]?.dateKey ?? getDateKey(new Date())}_${eventInput}`)
      const eventDirectory = await getOrCreateDirectory(root, [eventSegment])
      const usedPaths = new Map<string, number>()

      await writeFileToDirectory(
        eventDirectory,
        '_정리안.csv',
        buildPlanRows()
          .map((row) => row.map(csvEscape).join(','))
          .join('\n'),
      )
      await writeFileToDirectory(eventDirectory, '_정리안.json', JSON.stringify(buildPlanExport(), null, 2))

      for (const [index, photo] of photos.entries()) {
        const extension = getFileExtension(photo.name)
        const statusFolder = STATUS_FOLDER_LABELS[photo.status]
        const peopleNames = photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter((name): name is string => Boolean(name))
        const fallbackNames = photo.studentTags.length ? photo.studentTags : ['미지정']
        const targetNames = peopleNames.length ? peopleNames : fallbackNames
        const fileBuffer = await photo.file.arrayBuffer()

        for (const [targetIndex, targetName] of targetNames.entries()) {
          const personSegment = safePathSegment(targetName)
          const baseName = safePathSegment(
            `${photo.dateKey}_${photo.eventTag}_${personSegment}_${STATUS_LABELS.get(photo.status) ?? photo.status}_${String(index + 1).padStart(3, '0')}`,
          )
          const duplicateSuffix = targetNames.length > 1 ? `_단체${targetIndex + 1}` : ''
          const folderPath = `${safePathSegment(statusFolder)}/${personSegment}`
          const rawPath = `${folderPath}/${baseName}${duplicateSuffix}.${extension}`
          const usedCount = usedPaths.get(rawPath) ?? 0
          usedPaths.set(rawPath, usedCount + 1)
          const finalName = usedCount
            ? `${baseName}${duplicateSuffix}_${usedCount + 1}.${extension}`
            : `${baseName}${duplicateSuffix}.${extension}`
          const targetDirectory = await getOrCreateDirectory(eventDirectory, [safePathSegment(statusFolder), personSegment])

          await writeFileToDirectory(targetDirectory, finalName, fileBuffer)
          folderCounts[folderPath] = (folderCounts[folderPath] ?? 0) + 1
          savedTotal += 1
        }
      }

      setLastSaveResult({
        method: 'folder',
        rootName: eventSegment,
        totalPhotos: savedTotal,
        folderCounts,
        locationHint: `선택하신 폴더 안 「${eventSegment}」`,
        savedAt: Date.now(),
      })
      setProjectMessage(`${eventSegment} 폴더에 정리된 사진과 정리안 CSV/JSON을 저장했습니다.`)
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      const reason = error instanceof Error ? error.message : '알 수 없음'
      if (name === 'AbortError') {
        // 사용자가 폴더 선택 취소 — 조용히 무시
      } else if (name === 'NotAllowedError') {
        setProjectMessage('폴더 쓰기 권한이 거부됐어요. 다시 시도하시거나 「ZIP 파일로 받기」를 사용해 주세요.')
      } else if (name === 'NoModificationAllowedError') {
        setProjectMessage('이 폴더는 잠겨 있어 저장할 수 없어요. 다른 폴더를 선택해 주세요.')
      } else {
        setProjectMessage(`로컬 폴더 저장 중 문제가 발생했어요: ${reason}. 「ZIP 파일로 받기」를 대신 사용해 주세요.`)
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
    let savedTotal = 0
    try {
      const token = await requestGoogleAccessToken(GOOGLE_CLIENT_ID)
      const eventSegment = safePathSegment(`${photos[0]?.dateKey ?? getDateKey(new Date())}_${eventInput}`)
      const rootFolderId = await driveCreateFolder(token, `eum-photo_${eventSegment}`)

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
      const usedNames = new Map<string, number>()

      for (const [index, photo] of photos.entries()) {
        const statusFolderName = STATUS_FOLDER_LABELS[photo.status]
        const statusKey = safePathSegment(statusFolderName)
        let statusFolderId = statusFolderIds.get(statusKey)
        if (!statusFolderId) {
          statusFolderId = await driveCreateFolder(token, statusKey, rootFolderId)
          statusFolderIds.set(statusKey, statusFolderId)
        }

        const peopleNames = photo.personFolderIds
          .map((folderId) => personFolderById.get(folderId)?.name)
          .filter((name): name is string => Boolean(name))
        const fallbackNames = photo.studentTags.length ? photo.studentTags : ['미지정']
        const targetNames = peopleNames.length ? peopleNames : fallbackNames

        for (const [targetIndex, targetName] of targetNames.entries()) {
          const personSegment = safePathSegment(targetName)
          const personKey = `${statusKey}/${personSegment}`
          let personParentId = personFolderIds.get(personKey)
          if (!personParentId) {
            personParentId = await driveCreateFolder(token, personSegment, statusFolderId)
            personFolderIds.set(personKey, personParentId)
          }

          const extension = getFileExtension(photo.name)
          const baseName = safePathSegment(
            `${photo.dateKey}_${photo.eventTag}_${personSegment}_${STATUS_LABELS.get(photo.status) ?? photo.status}_${String(index + 1).padStart(3, '0')}`,
          )
          const duplicateSuffix = targetNames.length > 1 ? `_단체${targetIndex + 1}` : ''
          const rawName = `${baseName}${duplicateSuffix}.${extension}`
          const usedCount = usedNames.get(`${personKey}/${rawName}`) ?? 0
          usedNames.set(`${personKey}/${rawName}`, usedCount + 1)
          const finalName = usedCount
            ? `${baseName}${duplicateSuffix}_${usedCount + 1}.${extension}`
            : rawName

          await driveUploadFile(
            token,
            personParentId,
            finalName,
            photo.file.type || 'image/jpeg',
            photo.file,
          )
          folderCounts[personKey] = (folderCounts[personKey] ?? 0) + 1
          savedTotal += 1
        }
      }

      setLastSaveResult({
        method: 'drive',
        rootName: `eum-photo_${eventSegment}`,
        totalPhotos: savedTotal,
        folderCounts,
        locationHint: 'Google Drive 내 「내 드라이브」',
        savedAt: Date.now(),
      })
      setProjectMessage(`Google Drive 'eum-photo_${eventSegment}' 폴더에 ${photos.length}장과 정리안을 업로드했습니다.`)
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

  const selectedCount = selectedIds.length
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

  useEffect(() => {
    if (!photos.length) return
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [photos.length])

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

      const shortcutStatus = STATUS_SHORTCUTS[event.key]
      if (shortcutStatus) {
        event.preventDefault()
        setActivePhotoStatus(shortcutStatus)
      }

      if (event.key === ' ') {
        event.preventDefault()
        const targetId = activePhotoId ?? photos[0]?.id
        if (targetId) toggleSelected(targetId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    activePhotoId,
    moveActivePhoto,
    moveViewerPhoto,
    photos,
    setActivePhotoStatus,
    toggleSelected,
    viewerPhotoId,
  ])

  return (
    <main className={`app-shell ${isSidebarOpen ? 'sidebar-open' : ''}`}>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setIsSidebarOpen((value) => !value)}
        aria-expanded={isSidebarOpen}
        aria-label={isSidebarOpen ? '메뉴 닫기' : '메뉴 열기'}
      >
        <span aria-hidden="true">{isSidebarOpen ? '✕' : '☰'}</span>
        <span className="sr-only">메뉴</span>
      </button>
      {isSidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          onClick={() => setIsSidebarOpen(false)}
          aria-label="메뉴 닫기"
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          <img src="/eum-logo.png" alt="" />
          <div>
            <strong>이음 포토</strong>
            <span>사진은 내 컴퓨터에만</span>
          </div>
        </div>

        <button className="primary-action" type="button" onClick={() => fileInputRef.current?.click()}>
          <ImagePlus size={18} />
          사진 추가
        </button>
        <input
          ref={fileInputRef}
          className="hidden-input"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => void handleFiles(event.target.files)}
        />

        <section className="panel compact-panel">
          <h2>1. 행사 / 학생 이름 적기</h2>
          <label>
            행사명
            <input
              value={eventInput}
              onChange={(event) => setEventInput(event.target.value)}
              placeholder="예: 봄 수련회, 여름성경학교"
            />
          </label>
          {!normalizeTag(eventInput) && photos.length > 0 && (
            <p className="event-empty-warning">
              행사명을 비워두면 새로 추가된 사진은 「주일학교」로 저장됩니다.
            </p>
          )}
          <p className="panel-hint">
            학생 이름은 두 가지 방법 중 편한 쪽으로. 명단을 불러오면 아래 이름 칩 클릭으로:
            <br />· <strong>사진 선택 없이</strong> 누르면 그 이름으로 사진 필터링
            <br />· <strong>사진 선택 후</strong> 누르면 그 이름을 일괄 태그
          </p>
          <label>
            학생 이름 직접 입력
            <input
              value={studentInput}
              onChange={(event) => setStudentInput(event.target.value)}
              placeholder="예: 김하은, 박시온"
            />
          </label>
          <button
            className="secondary-action"
            type="button"
            onClick={applyTagsToSelected}
            title="입력한 이름을 선택된 사진 모두에 태그로 추가합니다."
          >
            <Tags size={16} />
            선택 {selectedCount}장에 적용
          </button>
          <input
            ref={rosterInputRef}
            className="hidden-input"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void importRoster(event.target.files)}
          />
          <button
            className="secondary-action subtle-action"
            type="button"
            onClick={() => rosterInputRef.current?.click()}
            title="이름 컬럼이 있는 CSV를 불러오면 이름 칩으로 빠르게 태그할 수 있어요. 「공개동의/초상권/consent」 컬럼이 있으면 동의 상태도 함께 표시됩니다."
          >
            <Upload size={16} />
            학생 명단 CSV
          </button>
          {rosterMessage && <p className="scan-message">{rosterMessage}</p>}
          {rosterMatch.hasRoster && (
            <p className="roster-summary">
              명단 {rosterMatch.entries.length}명 · 매칭 {rosterMatch.covered.length} · 미매칭 {rosterMatch.uncovered.length}
              {rosterMatch.orphanTags.length > 0 && ` · 명단 외 ${rosterMatch.orphanTags.length}`}
            </p>
          )}
          {rosterNames.length > 0 && (
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
                const consentLabel =
                  consent === 'yes' ? '단톡방 공유 OK' : consent === 'no' ? '단톡방 공유 안 됨' : consent === 'unknown' ? '동의 확인 필요' : ''
                const baseTitle = count > 0 ? `${count}장 매칭됨` : '아직 매칭된 사진 없음'
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => applyRosterName(name)}
                    className={`${count > 0 ? 'roster-chip-covered' : 'roster-chip-uncovered'} ${consentClass}`.trim()}
                    title={consentLabel ? `${baseTitle} · ${consentLabel}` : baseTitle}
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
          )}
          {rosterMatch.orphanTags.length > 0 && (
            <div className="roster-orphan">
              <p>명단 외 태그</p>
              <div className="roster-chip-list">
                {rosterMatch.orphanTags.map((entry) => (
                  <span key={entry.name} className="roster-chip-orphan" title="명단 CSV에 없는 이름">
                    {entry.name}
                    <span className="roster-chip-count">{entry.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        <button
          type="button"
          className="advanced-toggle"
          onClick={() => setIsAdvancedOpen((value) => !value)}
          aria-expanded={isAdvancedOpen}
        >
          <span>⚙ 고급 기능</span>
          <small>{isAdvancedOpen ? '접기' : '펼치기'}</small>
        </button>
        {isAdvancedOpen && (
          <>
        <section className="panel compact-panel">
          <h2>사람별 모음 (인물 폴더)</h2>
          <p className="panel-hint">
            「학생 태그」보다 더 정밀한 분류 방식이에요. 같은 사람의 사진을 한곳에 모으고 대표 사진 1장을 지정합니다.
            <br /><strong>사용법</strong>:
            <br />1. 사진을 클릭해 활성화한 뒤 아래 「현재 사진을 대표로 등록」
            <br />2. 또는 사진 「확대」 → 얼굴 박스 클릭 → 이름 입력
            <br />3. 「후보 찾기」 누르면 비슷한 사진 자동 추천
            <br /><small>※ 학생 태그만으로 충분하면 이 기능은 안 써도 됩니다.</small>
          </p>
          <label>
            인물 이름
            <input
              value={personNameInput}
              onChange={(event) => setPersonNameInput(event.target.value)}
              placeholder="예: 김하은"
            />
          </label>
          <button className="secondary-action" type="button" onClick={createPersonFolderFromActive}>
            <UserRoundPlus size={16} />
            현재 사진을 대표로 등록
          </button>
          <div className="person-folder-list">
            {personFolders.map((folder) => (
              <article key={folder.id} className="person-folder-card">
                <button
                  type="button"
                  onClick={() => assignSelectedToPerson(folder.id)}
                  title="선택된 사진을 이 인물 폴더에 배정합니다."
                >
                  <Users size={14} />
                  <span>{folder.name}</span>
                  <strong>{folder.photoIds.length}</strong>
                </button>
                <button
                  type="button"
                  onClick={() => findSimilarCandidates(folder.id)}
                  title="대표 사진과 유사한 사진을 찾아 후보로 표시합니다."
                >
                  <WandSparkles size={14} />
                  <span>후보 찾기</span>
                  <strong>{folder.candidatePhotoIds.length}</strong>
                </button>
                <div className="person-folder-tools">
                  <button type="button" onClick={() => renamePersonFolder(folder.id)} title="이름 변경">
                    이름 변경
                  </button>
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => deletePersonFolder(folder.id)}
                    title="이 인물 폴더만 삭제 (사진은 유지)"
                  >
                    삭제
                  </button>
                </div>
              </article>
            ))}
            {!personFolders.length && (
              <p>
                인물 폴더는 같은 사람의 사진을 한곳에 모으는 자리입니다. 사진을 확대해서 얼굴 박스를 클릭하고 이름을 입력하면 그
                사진이 대표 사진으로 등록됩니다.
              </p>
            )}
          </div>
        </section>

        <section className="panel compact-panel">
          <h2>얼굴 자동으로 찾기</h2>
          <button className="secondary-action" type="button" onClick={() => void scanPeoplePhotos()} disabled={!photos.length || isFaceScanning}>
            <Search size={16} />
            {isFaceScanning ? '얼굴 찾는 중' : '얼굴 있는 사진 찾기'}
          </button>
          {faceScanMessage && <p className="scan-message">{faceScanMessage}</p>}
        </section>

        <section className="panel compact-panel">
          <h2>누적 통계</h2>
          <button
            className="secondary-action"
            type="button"
            onClick={archiveCurrentPlan}
            disabled={!photos.length}
            title="이 컴퓨터 브라우저에만 저장됩니다. 학생별 사진 수가 행사를 거듭할수록 누적되어 등장 균형을 비교할 수 있어요."
          >
            <Archive size={16} />
            이 행사 누적에 추가
          </button>
          {cumulativeStats.eventCount === 0 ? (
            <p className="scan-message">정리가 끝난 행사를 추가하면 다음 행사에서 학생별 누적 사진 수를 비교할 수 있어요.</p>
          ) : (
            <>
              <p className="cumulative-summary">
                기록 {cumulativeStats.eventCount}건 · 누적 사진 {cumulativeStats.totalPhotos}장
              </p>
              <p className="cumulative-warning">
                ※ 학생 이름이 이 컴퓨터 브라우저에만 저장됩니다. 공용 컴퓨터를 쓰셨다면 끝나고 「기록 비우기」를 눌러 주세요.
              </p>
              <div className="cumulative-archive">
                {cumulativeStats.eventEntries.map((entry) => (
                  <div key={entry.id} className="cumulative-event-row">
                    <span>
                      <strong>{entry.eventName}</strong>
                      <small>
                        {' '}
                        · {entry.earliestDate} · {entry.photoCount}장
                      </small>
                    </span>
                    <button type="button" onClick={() => removeArchivedPlan(entry.id)} title="이 기록 삭제">
                      <XCircle size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {cumulativeStats.ranking.length > 0 && (
                <div className="cumulative-ranking">
                  {cumulativeStats.ranking.slice(0, 12).map((entry) => (
                    <span key={entry.name}>
                      {entry.name}
                      <strong>{entry.count}</strong>
                    </span>
                  ))}
                </div>
              )}
              <button className="secondary-action subtle-action" type="button" onClick={clearArchivedPlansWithConfirm}>
                <Trash2 size={14} />
                기록 비우기
              </button>
            </>
          )}
        </section>
          </>
        )}

        <section className="panel compact-panel">
          <h2>2. 선택한 사진 분류하기</h2>
          <p className="panel-hint">여러 사진을 클릭해서 선택한 뒤 아래 버튼을 누르면 한 번에 분류됩니다. 한 장씩 처리하려면 위쪽 「한 장씩 분류」 버튼을 사용하세요.</p>
          <div className="status-actions">
            {STATUS_OPTIONS.map((option) => {
              const Icon = option.icon
              const shortcut = STATUS_KEYS[option.value]

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    captureSnapshot(`${selectedIds.length}장 「${option.label}」로 분류`)
                    setStatusForPhotos(selectedIds, option.value)
                  }}
                  disabled={!selectedCount}
                  title={`${option.label} — ${option.description}`}
                >
                  <Icon size={15} />
                  {option.label}
                  <kbd className="shortcut-badge">{shortcut}</kbd>
                </button>
              )
            })}
          </div>
        </section>

        <section className="panel compact-panel">
          <h2>로컬 원칙</h2>
          <p>
            지금 버전은 서버 업로드 없이 브라우저 메모리에서만 분석합니다. 새로고침하면 사진 목록은 사라집니다.
          </p>
        </section>
      </aside>

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
          <div>
            <p className="eyebrow">E:UM Photo MVP</p>
            <h1>교회학교 사진 정리 작업대</h1>
          </div>
          <div className="top-actions">
            <input
              ref={projectInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => void importProject(event.target.files)}
            />
            {undoSnapshot && (
              <button
                type="button"
                className="undo-action"
                onClick={performUndo}
                title={`되돌리기: ${undoSnapshot.label}`}
              >
                <ArrowLeft size={16} />
                방금 동작 취소
              </button>
            )}
            <div className="top-actions-group" aria-label="이어 하기">
              <button
                type="button"
                onClick={() => projectInputRef.current?.click()}
                title="이전에 저장해둔 정리 진행 상황을 다시 불러옵니다."
              >
                <Upload size={16} />
                이어 하기
              </button>
              <button
                type="button"
                onClick={exportProject}
                disabled={!photos.length}
                title="지금까지 정리한 내용(태그·분류·사람별 모음)을 작은 백업 파일로 저장해 둡니다. 사진 원본은 포함되지 않아요."
              >
                <Download size={16} />
                중간 저장
              </button>
            </div>
            <span className="top-actions-divider" aria-hidden="true" />
            <button
              type="button"
              className="result-action"
              onClick={() => setIsResultModalOpen(true)}
              disabled={!photos.length}
              title="정리 다 끝나셨어요? 사진을 어떻게 받을지 골라주세요."
            >
              <Download size={18} />
              결과 받기
            </button>
            <span className="top-actions-divider" aria-hidden="true" />
            <button
              type="button"
              className="danger-action"
              onClick={clearAll}
              disabled={!photos.length}
              title="현재 화면의 모든 사진과 정리한 내용을 지웁니다. 저장하지 않은 작업은 먼저 「중간 저장」으로 백업하세요."
            >
              <Trash2 size={16} />
              비우기
            </button>
          </div>
        </header>

        {projectMessage && (
          <div className="project-message" role="status">
            {projectMessage}
          </div>
        )}

        {lastSaveResult && (
          <section className="save-result-panel" role="status" aria-live="polite">
            <div className="save-result-head">
              <div>
                <h2>
                  ✓ 저장 완료 — {lastSaveResult.totalPhotos}장
                </h2>
                <p>
                  <strong>{lastSaveResult.rootName}</strong> · {lastSaveResult.locationHint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLastSaveResult(null)}
                className="save-result-close"
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <div className="save-result-body">
              <p className="save-result-hint">
                {lastSaveResult.method === 'folder'
                  ? '선택하신 폴더 안에 「행사 → 분류 상태 → 사람」 구조로 저장됐어요. 탐색기로 열어 확인하세요.'
                  : lastSaveResult.method === 'zip'
                  ? '브라우저 다운로드 폴더에 ZIP 파일이 생겼어요. 압축을 풀면 같은 구조로 정리됩니다.'
                  : 'Google Drive에 행사 폴더가 만들어졌어요. drive.google.com 에서 확인하세요.'}
              </p>
              <div className="save-result-folders">
                {Object.entries(lastSaveResult.folderCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([folder, count]) => (
                    <div key={folder} className="save-result-folder-row">
                      <span className="save-result-folder-name">{folder.replace(/\//g, ' › ')}</span>
                      <strong className="save-result-folder-count">{count}장</strong>
                    </div>
                  ))}
              </div>
              {lastSaveResult.method === 'zip' && (
                <p className="save-result-tip">
                  💡 압축 풀어 둘 위치를 정해두면 다음 행사부터는 「내 컴퓨터 폴더에 저장하기」가 더 편해요 (Chrome / Edge).
                </p>
              )}
            </div>
          </section>
        )}

        <ol className="workflow-stepper" aria-label="작업 진행 상황">
          {workflowSteps.map((step, index) => (
            <li key={step.key} className={`workflow-step workflow-step-${step.state}`}>
              <span className="workflow-step-num" aria-hidden="true">
                {step.state === 'done' ? '✓' : index + 1}
              </span>
              <div>
                <strong>{step.label}</strong>
                <small>{step.hint}</small>
              </div>
            </li>
          ))}
        </ol>

        {photos.length > 0 && (
          <section className="metrics-simple">
            <div className="metrics-simple-line">
              <Camera size={18} />
              <strong>{photos.length}장</strong>
              <span className="metrics-simple-sep">·</span>
              <span>분류 완료</span>
              <strong className="metrics-simple-progress">{sortedCount}</strong>
              <span>/ {photos.length}장</span>
              {(stats.duplicates + stats.blurry + reviewIssues.length) > 0 && (
                <span className="metrics-simple-warn" title={`중복 ${stats.duplicates} · 흐림 ${stats.blurry} · 자동 검토 ${reviewIssues.length}`}>
                  · 한 번 더 볼 사진 {stats.duplicates + stats.blurry + reviewIssues.length}
                </span>
              )}
            </div>
            <div className="metrics-simple-bar" aria-hidden="true">
              <div
                className="metrics-simple-bar-fill"
                style={{ width: `${photos.length ? Math.round((sortedCount / photos.length) * 100) : 0}%` }}
              />
            </div>
          </section>
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
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              <ImagePlus size={18} />
              사진 선택
            </button>
            <ol className="dropzone-steps" aria-label="작업 순서">
              <li>
                <strong>1</strong>
                <span>사진을 끌어오거나 선택해서 추가하세요.</span>
              </li>
              <li>
                <strong>2</strong>
                <span>왼쪽 사이드바에 행사명을 적습니다 (예: 봄 수련회).</span>
              </li>
              <li>
                <strong>3</strong>
                <span>선택 사항: 학생 명단 CSV를 불러오면 이름 버튼으로 빠르게 태그할 수 있어요.</span>
              </li>
              <li>
                <strong>4</strong>
                <span>정리가 끝나면 「로컬 폴더 저장」이나 「정리본 ZIP」으로 내보냅니다.</span>
              </li>
            </ol>
            <p className="dropzone-warning">
              새로고침하면 사진 목록이 사라집니다. 도중에 멈출 때는 상단의 「작업 저장」을 눌러 백업해 두세요.
            </p>
            {isAnalyzing && analysisProgress.total > 0 && (
              <p className="dropzone-progress" role="status">
                사진 분석 중 {analysisProgress.done}/{analysisProgress.total}
              </p>
            )}
          </section>
        ) : (
          <div className="content-grid">
            <section className="photo-board">
              <div className="section-heading">
                <div>
                  <h2>{isSingleMode ? '한 장씩 분류하기' : '사진 목록'}</h2>
                  <p>
                    {isSingleMode
                      ? '큰 사진을 보면서 「쓸 사진 / 안 쓸 사진」 버튼만 누르세요. 자동으로 다음 사진으로 넘어가요.'
                      : activePhoto
                      ? `${activeIndex + 1}/${photos.length} · ${activePhoto.name}`
                      : '사진을 클릭해 활성화하면 단축키로 빠르게 분류할 수 있어요.'}
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    type="button"
                    className={isSingleMode ? 'single-mode-toggle active' : 'single-mode-toggle'}
                    onClick={() => setIsSingleMode((value) => !value)}
                    title={isSingleMode ? '여러 사진을 한 번에 보는 화면으로 돌아갑니다.' : '한 장씩 큰 화면에서 빠르게 분류합니다.'}
                  >
                    {isSingleMode ? '목록 보기' : '한 장씩 분류'}
                  </button>
                  <button type="button" onClick={() => moveActivePhoto(-1)} disabled={activeIndex <= 0}>
                    <ArrowLeft size={15} />
                  </button>
                  <span>
                    {isAnalyzing
                      ? analysisProgress.total > 0
                        ? `분석 중 ${analysisProgress.done}/${analysisProgress.total}`
                        : '분석 중...'
                      : `${visiblePhotos.length}/${photos.length}장`}
                  </span>
                  <button
                    type="button"
                    onClick={() => moveActivePhoto(1)}
                    disabled={activeIndex < 0 || activeIndex >= photos.length - 1}
                  >
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
              {!isSingleMode && (
                <div className="filter-bar">
                  <label>
                    <Search size={14} />
                    <input
                      value={searchText}
                      onChange={(event) => setSearchText(event.target.value)}
                      placeholder="파일명, 이름, 행사 검색"
                    />
                  </label>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                    <option value="all">전체 상태</option>
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select value={faceFilter} onChange={(event) => setFaceFilter(event.target.value as FaceFilter)}>
                    <option value="all">전체 얼굴</option>
                    <option value="has_face">얼굴 있음</option>
                    <option value="no_face">얼굴 없음</option>
                    <option value="not_scanned">미검사</option>
                  </select>
                  <button type="button" onClick={selectVisiblePhotos} disabled={!visiblePhotos.length}>
                    보이는 사진 선택
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    disabled={!selectedIds.length}
                    title="선택된 사진을 모두 해제합니다."
                  >
                    선택 해제 ({selectedIds.length})
                  </button>
                  <button type="button" onClick={clearFilters} disabled={!searchText && statusFilter === 'all' && faceFilter === 'all'}>
                    필터 해제
                  </button>
                  <span>{visibleSelectedCount}장 선택됨</span>
                  <span className="filter-hint" title="←→ 사진 이동 · Space 선택 · 1 보관 · 2 대표 · 3 공개후보 · 4 제외">
                    단축키: ←→ Space 1 2 3 4
                  </span>
                </div>
              )}
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
              <div className="photo-grid">
                {visiblePhotos.map((photo) => {
                  const selected = selectedIds.includes(photo.id)
                  const duplicate = duplicateHashes.has(photo.hash)
                  const blurry = photo.blurScore < BLUR_THRESHOLD
                  const consent = photoConsentByPhotoId.get(photo.id)
                  const consentDenied = consent && consent.no.length > 0
                  const consentUnknown = consent && !consent.no.length && consent.unknown.length > 0 && !consent.yes.length

                  return (
                    <article
                      className={`photo-card ${selected ? 'selected' : ''} ${
                        activePhotoId === photo.id ? 'active' : ''
                      }`}
                      key={photo.id}
                    >
                      <button
                        className="photo-select"
                        type="button"
                        onClick={() => {
                          setActivePhotoId(photo.id)
                          toggleSelected(photo.id)
                        }}
                        title={selected ? '✕ 클릭하면 선택 해제됩니다.' : '여러 장을 선택해 일괄 태그·상태 변경할 수 있습니다.'}
                      >
                        <img src={photo.url} alt={photo.name} />
                        <span className={selected ? 'photo-check selected' : 'photo-check'}>
                          {selected ? '✓ 선택됨 (해제: 다시 클릭)' : '선택'}
                        </span>
                      </button>
                      <button className="photo-zoom" type="button" onClick={() => openViewer(photo.id)}>
                        <Maximize2 size={14} />
                        확대
                      </button>
                      <div className="photo-info">
                        <strong>{photo.name}</strong>
                        <span>
                          {photo.dateKey} · {formatBytes(photo.size)}
                        </span>
                      </div>
                      <div className="chips">
                        <span className={`status ${photo.status}`}>{STATUS_LABELS.get(photo.status)}</span>
                        {consentDenied && (
                          <span className="warn-strong" title={`단톡방 공유 안 됨: ${consent.no.join(', ')}`}>
                            단톡방 X · {consent.no.join(', ')}
                          </span>
                        )}
                        {consentUnknown && (
                          <span className="warn" title={`단톡방 공유 동의 확인 필요: ${consent.unknown.join(', ')}`}>
                            동의 확인 필요
                          </span>
                        )}
                        {duplicate && <span className="warn">중복 후보</span>}
                        {blurry && <span className="warn">흐림</span>}
                        {photo.faceScanStatus === 'done' && (photo.faceCount ?? 0) > 0 && (
                          <span className="face">얼굴 {photo.faceCount}명</span>
                        )}
                        {photo.faceScanStatus === 'done' && photo.faceCount === 0 && (
                          <span className="muted">얼굴 없음</span>
                        )}
                        {photo.faceScanStatus === 'unsupported' && <span className="muted">얼굴검출 미지원</span>}
                        {photo.studentTags.map((tag) => (
                          <span key={tag} className="chip-removable">
                            {tag}
                            <button
                              type="button"
                              className="chip-remove"
                              onClick={(event) => {
                                event.stopPropagation()
                                removeStudentTagFromPhoto(photo.id, tag)
                              }}
                              title={`「${tag}」 태그 빼기`}
                              aria-label={`${tag} 태그 빼기`}
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                        {photo.personFolderIds.map((folderId) => {
                          const folder = personFolderById.get(folderId)
                          return folder ? (
                            <span className="person chip-removable" key={folderId}>
                              {folder.name}
                              <button
                                type="button"
                                className="chip-remove"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  removePersonFolderFromPhoto(photo.id, folderId)
                                }}
                                title={`「${folder.name}」 모음에서 빼기`}
                                aria-label={`${folder.name} 모음에서 빼기`}
                              >
                                ✕
                              </button>
                            </span>
                          ) : null
                        })}
                      </div>
                      <div className="quick-status" aria-label={`${photo.name} 선별 상태`}>
                        {STATUS_OPTIONS.map((option) => {
                          const Icon = option.icon
                          const shortcut = STATUS_KEYS[option.value]

                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={photo.status === option.value ? 'active' : ''}
                              onClick={() => {
                                captureSnapshot(`「${option.label}」로 분류`)
                                setStatusForPhotos([photo.id], option.value)
                              }}
                              title={`${option.label} — ${option.description}`}
                            >
                              <Icon size={13} />
                              <span>{option.shortLabel}</span>
                              <kbd className="shortcut-badge">{shortcut}</kbd>
                            </button>
                          )
                        })}
                      </div>
                    </article>
                  )
                })}
              </div>
              )}
            </section>

            <section className="plan-panel">
              <div className="section-heading">
                <h2>정리안</h2>
                <span>{groups.length}개 폴더</span>
              </div>
              <div className="person-summary">
                <strong>인물 폴더</strong>
                {personFolders.length ? (
                  personFolders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => {
                        setSearchText(folder.name)
                        setProjectMessage(`「${folder.name}」 모음 사진만 보기로 필터링했어요.`)
                      }}
                      title={`「${folder.name}」 모음 사진만 보기`}
                    >
                      {folder.name} {folder.photoIds.length}장
                    </button>
                  ))
                ) : (
                  <span>아직 없음</span>
                )}
              </div>
              <div className="review-panel">
                <strong>검토 필요</strong>
                {reviewIssues.length ? (
                  <>
                    <p className="panel-hint">항목을 누르면 해당 사진이 확대 보기로 열립니다.</p>
                    {reviewIssues.map((issue) => (
                      <button
                        key={issue.id}
                        type="button"
                        onClick={() => openViewer(issue.photo.id)}
                        title={`${issue.label} — 클릭하면 ${issue.photo.name}이(가) 확대 보기로 열립니다.`}
                      >
                        <span>{issue.label}</span>
                        <p>{issue.photo.name} <em>확대해서 확인 →</em></p>
                      </button>
                    ))}
                  </>
                ) : (
                  <p>현재 자동 검토 항목은 없습니다. 좋은 상태예요.</p>
                )}
              </div>
              {personFolders.some((folder) => folder.candidatePhotoIds.length > 0) && (
                <div className="candidate-panel">
                  <strong>자동 후보</strong>
                  {personFolders.map((folder) =>
                    folder.candidatePhotoIds.map((candidateId) => {
                      const candidate = photos.find((photo) => photo.id === candidateId)
                      if (!candidate) return null

                      return (
                        <article key={`${folder.id}-${candidateId}`}>
                          <button type="button" onClick={() => openViewer(candidate.id)}>
                            <img src={candidate.url} alt={candidate.name} />
                          </button>
                          <div>
                            <span>{folder.name} 후보 · 유사도 {folder.candidateScores[candidate.id] ?? 0}%</span>
                            <p>{candidate.name}</p>
                            <div>
                              <button type="button" onClick={() => approveCandidate(folder.id, candidate.id)}>
                                승인
                              </button>
                              <button type="button" onClick={() => rejectCandidate(folder.id, candidate.id)}>
                                제외
                              </button>
                            </div>
                          </div>
                        </article>
                      )
                    }),
                  )}
                </div>
              )}
              <div className="folder-list">
                {groups.map(([label, items]) => (
                  <article key={label}>
                    <strong>{label}</strong>
                    <span>{items.length}장</span>
                    <p>
                      {items
                        .flatMap((item) => item.studentTags)
                        .filter(Boolean)
                        .slice(0, 5)
                        .join(', ') || '학생 태그 미지정'}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>
      {isResultModalOpen && (
        <div
          className="result-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="결과 받기"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsResultModalOpen(false)
          }}
        >
          <section className="result-modal">
            <header>
              <h2>정리 끝나셨어요? 사진을 어떻게 받을까요?</h2>
              <p>아래 카드 중 편한 방법을 골라 주세요. 사진 원본은 인터넷에 올라가지 않아요.</p>
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
                  <strong>내 컴퓨터 폴더에 저장하기</strong>
                  <p>사진을 행사·분류·사람별 폴더로 정리해서 직접 저장합니다. (Chrome / Edge 권장)</p>
                </button>
              )}
              <button
                type="button"
                className="result-card"
                disabled={isZipping}
                onClick={() => {
                  setIsResultModalOpen(false)
                  void exportOrganizedZip()
                }}
              >
                <Download size={32} />
                <strong>ZIP 파일로 받기</strong>
                <p>모든 기기에서 가능. 정리된 사진을 ZIP 파일로 다운로드해서 보관하세요.</p>
              </button>
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
                  <strong>Google Drive에 올리기</strong>
                  <p>구글 드라이브에 행사 폴더를 만들고 사진을 올립니다. 다른 교사와 공유하기 쉬워요.</p>
                </button>
              )}
            </div>
            <footer>
              <p className="result-modal-extra">
                <strong>정리표(엑셀용)만 따로 받기:</strong>
                <button type="button" onClick={() => { exportPlan(); setIsResultModalOpen(false) }}>
                  CSV
                </button>
                <button type="button" onClick={() => { exportPlanJson(); setIsResultModalOpen(false) }}>
                  JSON
                </button>
              </p>
            </footer>
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
                <span className="viewer-hint" title="ESC 닫기 · ←→ 사진 이동 · 1·2·3·4 상태 변경">
                  ESC ← → 1234
                </span>
                <button
                  type="button"
                  onClick={() => moveViewerPhoto(-1)}
                  disabled={viewerIndex <= 0}
                  title="이전 사진 (←)"
                >
                  <ArrowLeft size={16} />
                </button>
                {[1, 1.5, 2.5].map((zoom) => (
                  <button
                    key={zoom}
                    type="button"
                    className={viewerZoom === zoom ? 'active' : ''}
                    onClick={() => setViewerZoom(zoom)}
                    title={`확대 ${zoom}배`}
                  >
                    {zoom}x
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => moveViewerPhoto(1)}
                  disabled={viewerIndex < 0 || viewerIndex >= photos.length - 1}
                  title="다음 사진 (→)"
                >
                  <ArrowRight size={16} />
                </button>
                <button type="button" className="viewer-close" onClick={closeViewer} title="닫기 (ESC)">
                  닫기
                </button>
              </div>
            </header>
            <div className="viewer-body">
              <div className="viewer-image-frame" style={{ width: `${viewerZoom * 100}%` }}>
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
    </main>
  )
}

export default App
