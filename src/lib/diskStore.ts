// 이음 포토 v2 — 디스크 = 진실의 출처. 메모리 = 화면 캐시.
//
// 모든 디스크 IO는 이 모듈을 거친다. UI는 이 모듈의 함수만 호출.
// localStorage·메모리 추상화 없음. 모든 변경은 즉시 디스크에 반영.
//
// 데이터 구조:
//   <root>/EUM-Photo/
//     ├── 원본/                ← 사진 마스터 (1회 import 후 누적)
//     ├── 정리/<상태>/<인물>/   ← 인물 폴더 = 디스크 폴더 그 자체
//     └── _프로젝트.json       ← 행사명·캐시·계층 등 (디스크 폴더로 표현 못 하는 메타)
//
// 메타 동기화 = 모든 변경 후 _프로젝트.json 즉시 쓰기 (디바운스 300ms).
// 사진 자체 변경 = 즉시 디스크에 복사·이동 (delta).
//
// 1주차 Day 1: 타입·경로 유틸·load/save 토대만. 폴더·사진 ops는 다음 단계.

export const META_FILE_NAME = '_프로젝트.json'
export const EUM_DIR_NAME = 'EUM-Photo'
export const ORIGINAL_DIR_NAME = '원본'
export const ORGANIZED_DIR_NAME = '정리'

export type PhotoStatus =
  | 'keep'
  | 'delete'
  | 'public_candidate'
  | 'review'
  | 'archive'

export type FaceBox = {
  x: number
  y: number
  width: number
  height: number
}

// 사진 한 장의 메타. 디스크 파일 자체는 <root>/EUM-Photo/원본/<fileName>.
// personFolderPaths = ['보관/김자현', '공개후보/단체사진'] 같이 디스크 정리 폴더 상대 경로.
// 단체사진(faceCount ≥ 2)은 personFolderPaths 여러 개 가질 수 있음 (자동 보호).
export type PhotoMeta = {
  fileName: string
  hash: string
  blurScore: number
  width: number
  height: number
  faceCount: number
  faceBoxes: FaceBox[]
  studentTags: string[]
  status: PhotoStatus
  personFolderPaths: string[]
  importedAt: string
}

// 인물 폴더 = 디스크 폴더 그 자체. 「정리/」 바로 밑 한 레벨 (또는 parentPath로 하위).
// 디스크 경로 = <root>/EUM-Photo/정리/<...parentPath>/<name>/
// status는 사진별 메타로만. 폴더 트리에는 status 그룹 X (평범 교사 멘탈 모델).
export type PersonFolder = {
  name: string
  parentPath: string | null  // null = 정리/ 바로 밑. 'A/B'면 정리/A/B/<name>
}

export type ProjectMeta = {
  app: 'eum-photo'
  version: 2
  savedAt: string
  rootPath: string  // 사용자가 선택한 작업 폴더 (예: D:\EUM-Photo의 부모)
  eventInput: string
  // photos는 fileName 키로 빠른 조회. 값에는 fileName 중복 안 함.
  photos: Record<string, Omit<PhotoMeta, 'fileName'>>
  personFolders: PersonFolder[]
}

// ===== 경로 유틸 =====

// 입력 경로의 구분자(\ 또는 /)를 따라 join. Windows 환경 일치.
export function joinPath(...parts: string[]): string {
  const filtered = parts.filter(Boolean)
  if (!filtered.length) return ''
  const first = filtered[0]
  const sep = first.includes('\\') ? '\\' : '/'
  return filtered.join(sep).replace(/[\\/]+/g, sep)
}

export function getEumDir(rootPath: string): string {
  // root가 이미 EUM-Photo로 끝나면 그대로, 아니면 <root>/EUM-Photo
  const norm = rootPath.replace(/[\\/]+$/, '')
  if (norm.endsWith(EUM_DIR_NAME)) return norm
  return joinPath(rootPath, EUM_DIR_NAME)
}

export function getMetaPath(rootPath: string): string {
  return joinPath(getEumDir(rootPath), META_FILE_NAME)
}

export function getOriginalDir(rootPath: string): string {
  return joinPath(getEumDir(rootPath), ORIGINAL_DIR_NAME)
}

export function getOrganizedDir(rootPath: string): string {
  return joinPath(getEumDir(rootPath), ORGANIZED_DIR_NAME)
}

// 인물 폴더의 디스크 절대 경로 — EUM-Photo/정리/<인물>/ (사용자 결정: 정리 중간 폴더 유지)
export function getPersonFolderDiskPath(rootPath: string, folder: PersonFolder): string {
  const parts = [getOrganizedDir(rootPath)]
  if (folder.parentPath) parts.push(folder.parentPath)
  parts.push(folder.name)
  return joinPath(...parts)
}

// 예약 이름 — 인물 폴더로 못 만들게 차단
const RESERVED_FOLDER_NAMES = new Set([ORIGINAL_DIR_NAME, ORGANIZED_DIR_NAME, '_프로젝트', 'EUM-Photo'])

// 인물 폴더의 「정리/」 기준 상대 경로 — 사진의 personFolderPaths에 저장되는 형식
export function getPersonFolderRelPath(folder: PersonFolder): string {
  return folder.parentPath ? `${folder.parentPath}/${folder.name}` : folder.name
}

// ===== IPC 안전 접근 =====

class DiskStoreUnavailableError extends Error {
  constructor(reason: string) {
    super(`디스크 저장소를 사용할 수 없습니다: ${reason}`)
    this.name = 'DiskStoreUnavailableError'
  }
}

function ipc() {
  if (typeof window === 'undefined') {
    throw new DiskStoreUnavailableError('window 객체 없음 (SSR 환경 미지원)')
  }
  if (!window.eum?.isElectron || !window.eum.fs) {
    throw new DiskStoreUnavailableError(
      '브라우저 모드 (Electron 데스크탑 빌드 전용 — 차후 Web FS API 분기 추가 예정)',
    )
  }
  return window.eum.fs
}

export function isDiskStoreAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.eum?.isElectron && !!window.eum.fs
}

// ===== 프로젝트 메타 load/save =====

// 빈 프로젝트 (새 폴더 또는 메타 파일 없는 경우)
function emptyProject(rootPath: string): ProjectMeta {
  return {
    app: 'eum-photo',
    version: 2,
    savedAt: new Date().toISOString(),
    rootPath,
    eventInput: '',
    photos: {},
    personFolders: [],
  }
}

// 디스크에서 프로젝트 메타를 로드. 메타 파일이 없거나 손상되면 빈 프로젝트.
//
// 마이그레이션:
//   - 옛 메타의 status 필드 무시 (PersonFolder.status 폐기됨)
//   - 모든 폴더가 새 디스크 위치(정리/<name>/)에 존재하도록 ensureDir
//   - 메타가 v1이거나 status 필드 있으면 즉시 디스크 갱신 트리거
export async function loadProject(rootPath: string): Promise<ProjectMeta> {
  const fs = ipc()
  const metaPath = getMetaPath(rootPath)

  if (!(await fs.exists(metaPath))) {
    return emptyProject(rootPath)
  }

  const parsed = await (async (): Promise<Partial<ProjectMeta> | null> => {
    try {
      const buf = await fs.readFile(metaPath)
      const text = new TextDecoder('utf-8').decode(buf)
      return JSON.parse(text) as Partial<ProjectMeta>
    } catch (err) {
      console.warn('[diskStore] _프로젝트.json 파싱 실패:', err)
      return null
    }
  })()

  if (!parsed || parsed.app !== 'eum-photo') {
    console.warn('[diskStore] _프로젝트.json 없거나 형식 오류 — 빈 프로젝트로 시작.')
    return emptyProject(rootPath)
  }

  // status 필드 무시 + name·parentPath만 추출 (v1·v2 메타 모두 처리)
  const rawFolders = Array.isArray(parsed.personFolders) ? parsed.personFolders : []
  const cleanFolders: PersonFolder[] = rawFolders
    .map((raw: { name?: string; parentPath?: string | null }) => ({
      name: raw.name ?? '',
      parentPath: raw.parentPath ?? null,
    }))
    .filter((f) => f.name.length > 0)

  // 마이그레이션: 옛 디스크 위치 후보들 → 새 위치(EUM-Photo/정리/<인물>/)
  // 후보 1: EUM-Photo/<인물>/ (평면 구조 잔재)
  // 후보 2: EUM-Photo/정리/keep/<인물>/ (더 옛 status 분기 잔재)
  // 새 위치 = EUM-Photo/정리/<인물>/ (현재 결정)
  const fsExt = ipcExt()
  const eumDir = getEumDir(rootPath)
  const oldOrganizedRoot = joinPath(eumDir, ORGANIZED_DIR_NAME)
  for (const folder of cleanFolders) {
    const newPath = getPersonFolderDiskPath(rootPath, folder)
    if (await fs.exists(newPath)) continue  // 이미 새 위치 있음 — skip
    const candidates = [
      joinPath(eumDir, folder.parentPath ?? '', folder.name),
      joinPath(oldOrganizedRoot, 'keep', folder.parentPath ?? '', folder.name),
    ]
    for (const oldPath of candidates) {
      if (oldPath === newPath) continue
      if (await fs.exists(oldPath)) {
        try {
          await fsExt.rename(oldPath, newPath)
          console.info(`[migrate] 「${folder.name}」: ${oldPath} → ${newPath}`)
          break
        } catch (err) {
          console.warn(`[migrate] 「${folder.name}」 이동 실패:`, err)
        }
      }
    }
  }

  // 디스크 동기화 — 새 위치에 폴더 보장 (idempotent)
  for (const folder of cleanFolders) {
    try {
      await fs.ensureDir(getPersonFolderDiskPath(rootPath, folder))
    } catch (err) {
      console.warn(`[diskStore] 폴더 「${folder.name}」 디스크 생성 실패:`, err)
    }
  }

  const meta: ProjectMeta = {
    app: 'eum-photo',
    version: 2,
    savedAt: parsed.savedAt ?? new Date().toISOString(),
    rootPath,
    eventInput: parsed.eventInput ?? '',
    photos: parsed.photos ?? {},
    personFolders: cleanFolders,
  }

  // v1 → v2 마이그레이션 발생 시 즉시 메타 디스크 갱신 (status 필드 영구 제거)
  const wasMigrated =
    rawFolders.some((f) => 'status' in (f as object)) ||
    (parsed.version ?? 0) < 2
  if (wasMigrated) {
    saveProjectMetaDebounced(meta, 0)  // 즉시 flush
  }

  return meta
}

// 즉시 디스크 쓰기. UI 흐름 막지 않게 await 호출은 디바운스 함수에서.
export async function saveProjectMetaNow(meta: ProjectMeta): Promise<void> {
  const fs = ipc()
  await fs.ensureDir(getEumDir(meta.rootPath))
  const payload: ProjectMeta = { ...meta, savedAt: new Date().toISOString() }
  await fs.writeFile(getMetaPath(meta.rootPath), JSON.stringify(payload, null, 2))
}

// 300ms 디바운스 저장. 같은 프로젝트에 대한 연속 변경은 마지막 1번만 디스크 쓰기.
// 다른 프로젝트(rootPath 변경) 시 즉시 flush.
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingMeta: ProjectMeta | null = null

export function saveProjectMetaDebounced(meta: ProjectMeta, delayMs = 300): void {
  if (pendingMeta && pendingMeta.rootPath !== meta.rootPath) {
    // 다른 프로젝트 — 직전 변경 즉시 flush
    void saveProjectMetaNow(pendingMeta).catch((err) =>
      console.warn('[diskStore] 직전 메타 flush 실패:', err),
    )
  }
  pendingMeta = meta
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const m = pendingMeta
    pendingMeta = null
    saveTimer = null
    if (m) {
      void saveProjectMetaNow(m).catch((err) =>
        console.warn('[diskStore] 메타 저장 실패:', err),
      )
    }
  }, delayMs)
}

// 앱 종료 또는 프로젝트 전환 시 호출 — 보류 중인 저장 즉시 flush.
export async function flushPendingMeta(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const m = pendingMeta
  pendingMeta = null
  if (m) {
    await saveProjectMetaNow(m)
  }
}

// ===== 입력 정제 유틸 =====

// 양 끝 공백 제거 + 내부 공백 압축
function normalizeTag(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

// Windows 금지 문자 제거 + 80자 자르기 + 빈 값 fallback
function safePathSegment(value: string): string {
  return (
    normalizeTag(value)
      .replace(/[<>:"/\\|?*]/g, '_')
      .split('')
      .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
      .join('')
      .replace(/\.+$/g, '')
      .slice(0, 80) || '미지정'
  )
}

// ===== 확장 IPC 타입 (App.tsx 수정 없이 rename·copyFile 사용) =====

type EumFsBase = NonNullable<NonNullable<Window['eum']>['fs']>
type EumFsExtended = EumFsBase & {
  rename: (oldPath: string, newPath: string) => Promise<{ ok: boolean; reason?: string }>
  copyFile: (srcPath: string, destPath: string) => Promise<{ ok: boolean; reason?: string }>
}
function ipcExt(): EumFsExtended {
  return ipc() as EumFsExtended
}

// ===== 인물 폴더 ops =====

// 폴더 동등성: parentPath + name 일치
function sameFolder(a: PersonFolder, b: PersonFolder): boolean {
  return a.name === b.name && (a.parentPath ?? null) === (b.parentPath ?? null)
}

export async function createPersonFolder(
  meta: ProjectMeta,
  rawName: string,
  parentPath: string | null = null,
): Promise<ProjectMeta> {
  const fs = ipc()
  const name = safePathSegment(rawName)

  if (RESERVED_FOLDER_NAMES.has(name)) {
    throw new Error(`「${name}」은 시스템 예약 이름이라 사용할 수 없어요. 다른 이름을 써 주세요.`)
  }

  const folder: PersonFolder = { name, parentPath }

  if (meta.personFolders.some((f) => sameFolder(f, folder))) {
    throw new Error(`이미 같은 이름의 폴더가 있습니다: 「${name}」`)
  }

  await fs.ensureDir(getPersonFolderDiskPath(meta.rootPath, folder))

  const next: ProjectMeta = {
    ...meta,
    personFolders: [...meta.personFolders, folder],
  }
  saveProjectMetaDebounced(next)
  return next
}

export async function deletePersonFolder(
  meta: ProjectMeta,
  folder: PersonFolder,
): Promise<ProjectMeta> {
  const fs = ipc()
  const diskPath = getPersonFolderDiskPath(meta.rootPath, folder)
  const folderRelPath = getPersonFolderRelPath(folder)

  // 디스크 폴더 통째 제거 (안의 사본 사진들도 함께)
  // force:true라 ENOENT는 silent — 실제 삭제됐는지 stillExists로 확인.
  const removeResult = await fs.remove(diskPath, { recursive: true })
  if (!removeResult.ok) {
    throw new Error(`디스크 폴더 삭제 실패: ${removeResult.reason ?? '알 수 없음'}\n경로: ${diskPath}`)
  }
  const stillExists = await fs.exists(diskPath)
  if (stillExists) {
    throw new Error(
      `디스크 폴더가 안 지워졌어요. 파일 탐색기에서 직접 확인해 주세요.\n경로: ${diskPath}`,
    )
  }

  // 메타에서 제거 — 그 폴더 자신 + 하위(parentPath가 이 폴더로 시작) 모두
  const next: ProjectMeta = {
    ...meta,
    personFolders: meta.personFolders.filter(
      (f) =>
        !sameFolder(f, folder) &&
        !(f.parentPath?.startsWith(folderRelPath)),
    ),
    photos: Object.fromEntries(
      Object.entries(meta.photos).map(([fileName, p]) => [
        fileName,
        {
          ...p,
          personFolderPaths: p.personFolderPaths.filter(
            (rel) => rel !== folderRelPath && !rel.startsWith(folderRelPath + '/'),
          ),
        },
      ]),
    ),
  }
  saveProjectMetaDebounced(next)
  return next
}

export async function renamePersonFolder(
  meta: ProjectMeta,
  folder: PersonFolder,
  rawNewName: string,
): Promise<ProjectMeta> {
  const fs = ipcExt()
  const newName = safePathSegment(rawNewName)
  if (newName === folder.name) return meta

  const newFolder: PersonFolder = { ...folder, name: newName }
  if (meta.personFolders.some((f) => sameFolder(f, newFolder))) {
    throw new Error(`이미 같은 이름의 폴더가 있습니다: 「${newName}」`)
  }

  const oldDisk = getPersonFolderDiskPath(meta.rootPath, folder)
  const newDisk = getPersonFolderDiskPath(meta.rootPath, newFolder)
  const result = await fs.rename(oldDisk, newDisk)
  if (!result.ok) {
    throw new Error(`폴더 이름 변경 실패: ${result.reason ?? '알 수 없음'}`)
  }

  const oldRel = getPersonFolderRelPath(folder)
  const newRel = getPersonFolderRelPath(newFolder)

  const next: ProjectMeta = {
    ...meta,
    personFolders: meta.personFolders.map((f) => {
      if (sameFolder(f, folder)) return newFolder
      // 하위 폴더의 parentPath 갱신 (이 폴더가 부모인 모든 하위)
      if (f.parentPath === oldRel) return { ...f, parentPath: newRel }
      if (f.parentPath?.startsWith(oldRel + '/')) {
        return { ...f, parentPath: newRel + f.parentPath.slice(oldRel.length) }
      }
      return f
    }),
    photos: Object.fromEntries(
      Object.entries(meta.photos).map(([fileName, p]) => [
        fileName,
        {
          ...p,
          personFolderPaths: p.personFolderPaths.map((rel) => {
            if (rel === oldRel) return newRel
            if (rel.startsWith(oldRel + '/')) return newRel + rel.slice(oldRel.length)
            return rel
          }),
        },
      ]),
    ),
  }
  saveProjectMetaDebounced(next)
  return next
}

// ===== 사진 ops =====

// `원본/` 디스크 폴더 안 사진 파일 목록 (메타 동기화 용도)
export async function listPhotosInOriginal(rootPath: string): Promise<string[]> {
  const fs = ipc()
  const dir = getOriginalDir(rootPath)
  if (!(await fs.exists(dir))) return []
  const result = await fs.listDir(dir)
  if (!result.ok) return []
  return result.items
    .filter((it) => it.isFile && /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(it.name))
    .map((it) => it.name)
}

// addPhotos 반환 — 추가/건너뛴 결과를 호출자가 사용자에게 알리도록.
export type AddPhotosResult = {
  meta: ProjectMeta
  addedCount: number
  skippedNames: string[]
}

// 사진을 `원본/`에 복사 + 메타에 PhotoMeta 추가. 분석(hash·blurScore·faceCount)는 placeholder — 단계 3에서 채움.
// 중복 차단: 같은 fileName(공백·금지문자 정제 후)이 이미 메타 또는 디스크에 있으면 skip.
//   - 사용자 의도: 「같은 파일이 계속 받아지는 것 막아」 (2026-05-10).
//   - 단순 fileName 매칭. hash·size 매칭은 단계 3.
export async function addPhotos(meta: ProjectMeta, files: File[]): Promise<AddPhotosResult> {
  if (!files.length) return { meta, addedCount: 0, skippedNames: [] }
  const fs = ipc()
  const originalDir = getOriginalDir(meta.rootPath)
  await fs.ensureDir(originalDir)

  // 디스크 + 메타 양쪽의 기존 fileName 모음
  const existingNames = new Set<string>(Object.keys(meta.photos))
  const diskNames = await listPhotosInOriginal(meta.rootPath)
  for (const n of diskNames) existingNames.add(n)

  const newPhotos: Record<string, Omit<PhotoMeta, 'fileName'>> = {}
  const skippedNames: string[] = []
  const importedAt = new Date().toISOString()

  for (const file of files) {
    const safe = safePathSegment(file.name) || `사진_${Date.now()}.png`
    if (existingNames.has(safe)) {
      skippedNames.push(safe)
      continue
    }
    existingNames.add(safe)

    const buf = await file.arrayBuffer()
    await fs.writeFile(joinPath(originalDir, safe), buf)

    newPhotos[safe] = {
      hash: '',  // 단계 3에서 채움
      blurScore: 0,
      width: 0,
      height: 0,
      faceCount: 0,
      faceBoxes: [],
      studentTags: [],
      status: 'keep',
      personFolderPaths: [],
      importedAt,
    }
  }

  const next: ProjectMeta = {
    ...meta,
    photos: { ...meta.photos, ...newPhotos },
  }
  if (Object.keys(newPhotos).length > 0) {
    saveProjectMetaDebounced(next)
  }
  return {
    meta: next,
    addedCount: Object.keys(newPhotos).length,
    skippedNames,
  }
}

// 사진을 인물 폴더로 분류. mode = 'auto' | 'move' | 'copy'.
// 단체사진 자동 보호: faceCount ≥ 2 사진은 mode='auto' 시 자동으로 'copy'로 강제.
//   - 차별 가치 ① 단체사진 동의 보호 자동화.
export type MovePhotoMode = 'auto' | 'move' | 'copy'

export async function movePhotoToFolder(
  meta: ProjectMeta,
  fileName: string,
  folder: PersonFolder,
  mode: MovePhotoMode = 'auto',
): Promise<ProjectMeta> {
  const fs = ipcExt()
  const photo = meta.photos[fileName]
  if (!photo) throw new Error(`사진을 찾을 수 없습니다: ${fileName}`)

  const folderRelPath = getPersonFolderRelPath(folder)
  if (photo.personFolderPaths.includes(folderRelPath)) return meta  // 이미 그 폴더에 있음

  const isGroupPhoto = photo.faceCount >= 2
  const effectiveMode: 'move' | 'copy' = mode === 'auto' ? (isGroupPhoto ? 'copy' : 'move') : mode

  // 디스크 작업: `원본/<fileName>` → `정리/<status>/.../<폴더>/<fileName>`
  const srcPath = joinPath(getOriginalDir(meta.rootPath), fileName)
  const folderDisk = getPersonFolderDiskPath(meta.rootPath, folder)
  await fs.ensureDir(folderDisk)
  const destPath = joinPath(folderDisk, fileName)

  const cp = await fs.copyFile(srcPath, destPath)
  if (!cp.ok) throw new Error(`사진 복사 실패: ${cp.reason ?? '알 수 없음'}`)

  // 메타 갱신 — copy = 추가, move = 추가하고 다른 폴더에서 빠짐
  let nextPaths: string[]
  if (effectiveMode === 'copy') {
    nextPaths = [...photo.personFolderPaths, folderRelPath]
  } else {
    // 'move' = 다른 분류 다 빼고 이 폴더만
    // 다른 폴더 디스크 사본도 함께 제거
    for (const oldRel of photo.personFolderPaths) {
      if (oldRel === folderRelPath) continue
      const oldDisk = joinPath(getOrganizedDir(meta.rootPath), oldRel, fileName)
      void fs.remove(oldDisk, { recursive: false })  // 실패해도 메타는 갱신 (best-effort)
    }
    nextPaths = [folderRelPath]
  }

  const next: ProjectMeta = {
    ...meta,
    photos: {
      ...meta.photos,
      [fileName]: { ...photo, personFolderPaths: nextPaths },
    },
  }
  saveProjectMetaDebounced(next)
  return next
}

// 사진을 인물 폴더에서 빼기 (디스크 사본 제거 + 메타 갱신). 원본은 `원본/`에 그대로.
export async function removePhotoFromFolder(
  meta: ProjectMeta,
  fileName: string,
  folder: PersonFolder,
): Promise<ProjectMeta> {
  const fs = ipc()
  const photo = meta.photos[fileName]
  if (!photo) throw new Error(`사진을 찾을 수 없습니다: ${fileName}`)

  const folderRelPath = getPersonFolderRelPath(folder)
  if (!photo.personFolderPaths.includes(folderRelPath)) return meta

  const folderDisk = getPersonFolderDiskPath(meta.rootPath, folder)
  await fs.remove(joinPath(folderDisk, fileName), { recursive: false })

  const next: ProjectMeta = {
    ...meta,
    photos: {
      ...meta.photos,
      [fileName]: {
        ...photo,
        personFolderPaths: photo.personFolderPaths.filter((rel) => rel !== folderRelPath),
      },
    },
  }
  saveProjectMetaDebounced(next)
  return next
}
