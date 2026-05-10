// 이음 포토 v2 — 새 화면 (refactor/clean-restart)
//
// 디스크 = 진실의 출처. 모든 변경은 즉시 디스크 + 메타 디바운스 동기화.
// 「💾 작업 저장」 버튼 없음. 작업 폴더 한 번 정하면 이후 자동.
//
// 단계 2 Day 4: 작업 폴더 선택 + 폴더 트리 + 폴더 만들기·삭제·이름변경.
// 사진 추가·표시·분류는 Day 5~6.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import eumLogo from './assets/eum-logo.png'
import css from './NewProjectView.module.css'
import {
  addPhotos,
  createPersonFolder,
  deletePersonFolder,
  deletePhoto,
  getOriginalDir,
  getPersonFolderRelPath,
  joinPath,
  loadProject,
  movePhotoToFolder,
  removePhotoFromFolder,
  renamePersonFolder,
  renamePhoto,
  type PersonFolder,
  type ProjectMeta,
} from './lib/diskStore'

// 사진 카드 → 폴더 드래그 시 dataTransfer type. 외부 파일 드롭과 구분.
// 값 = JSON 배열(string[]) — 다중 선택 시 여러 fileName 한꺼번에.
const DRAG_TYPE_FILENAMES = 'application/x-eum-photo-filenames'

// CSS 모듈 클래스 합치기 helper. falsy 자동 제거.
function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

// 라이트박스 zoom 단계 (작 → 큼)
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4] as const

// ===== 이미지 resize (Canvas API) =====
// 입력 ArrayBuffer → 디코딩 → 긴 변 maxLongSide로 비율 유지 축소 → JPEG ArrayBuffer.
// 이미 작은 사진(longSide ≤ max)이면 그대로 다시 인코딩 (jpg 변환).
function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('이미지 디코딩 실패'))
    img.src = url
  })
}

async function resizeImageToJpegBuffer(
  srcBuffer: ArrayBuffer,
  srcMime: string,
  maxLongSide: number,
  quality: number,
): Promise<ArrayBuffer> {
  const blob = new Blob([srcBuffer], { type: srcMime })
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImageFromUrl(url)
    const w0 = img.naturalWidth
    const h0 = img.naturalHeight
    const long = Math.max(w0, h0)
    const scale = long > maxLongSide ? maxLongSide / long : 1
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2d context 실패')
    ctx.drawImage(img, 0, 0, w, h)
    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
    )
    if (!outBlob) throw new Error('toBlob 실패')
    return await outBlob.arrayBuffer()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function mimeFromFileName(name: string): string {
  const ext = (name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'image/jpeg'
  }
}

type Screen = 'no-folder' | 'loading' | 'ready'
type FolderContextMenu = { folder: PersonFolder; x: number; y: number }
type PhotoContextMenu = { fileName: string; x: number; y: number }

// 마지막 작업 폴더 경로를 localStorage에 보관 — 다음 앱 시작 시 자동 복원
const SAVED_ROOT_KEY = 'eum-photo:saved-root:v1'

export default function NewProjectView() {
  const [screen, setScreen] = useState<Screen>('no-folder')
  const [meta, setMeta] = useState<ProjectMeta | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [activeFolderKey, setActiveFolderKey] = useState<string | null>(null)
  const [drillInKey, setDrillInKey] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [folderMenu, setFolderMenu] = useState<FolderContextMenu | null>(null)
  const [photoMenu, setPhotoMenu] = useState<PhotoContextMenu | null>(null)
  const [lightboxName, setLightboxName] = useState<string | null>(null)
  const [lightboxZoom, setLightboxZoom] = useState(1)
  const [showOnlyUnclassified, setShowOnlyUnclassified] = useState(false)
  const [renameDialog, setRenameDialog] = useState<{
    prefix: string
    isApplying: boolean
  } | null>(null)
  const [shrinkDialog, setShrinkDialog] = useState<{
    maxLongSide: number
    quality: number
    isApplying: boolean
    done: number
    total: number
  } | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map())
  const [isAdding, setIsAdding] = useState(false)
  const [addProgress, setAddProgress] = useState('')
  const [folderDragOverKey, setFolderDragOverKey] = useState<string | null>(null)
  const [selectedFileNames, setSelectedFileNames] = useState<Set<string>>(new Set())
  const [rubberBand, setRubberBand] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const lastSelectedRef = useRef<string | null>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLElement | null>(null)

  // 우클릭 메뉴 외부 클릭 시 닫기.
  // contextmenu에는 close 등록 X — 다른 위치 우클릭은 새 메뉴 열기로 자연 처리됨.
  useEffect(() => {
    if (!folderMenu) return
    const close = () => setFolderMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [folderMenu])

  useEffect(() => {
    if (!photoMenu) return
    const close = () => setPhotoMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [photoMenu])

  // ===== 작업 폴더 로드 (공통) =====
  const loadFromPath = useCallback(async (path: string) => {
    setScreen('loading')
    setStatusMessage(`「${path}」 폴더를 불러오는 중…`)
    try {
      const loaded = await loadProject(path)
      setMeta(loaded)
      setActiveFolderKey(null)
      setDrillInKey(null)
      setScreen('ready')
      setStatusMessage(`📂 ${path}`)
      try {
        localStorage.setItem(SAVED_ROOT_KEY, path)
      } catch {
        // localStorage 사용 불가 — 무시
      }
      return true
    } catch (err) {
      window.alert(`작업 폴더 불러오기에 실패했어요:\n${err instanceof Error ? err.message : String(err)}`)
      setScreen('no-folder')
      return false
    }
  }, [])

  // ===== 작업 폴더 선택 =====
  const handlePickFolder = useCallback(async () => {
    if (!window.eum?.isElectron) {
      window.alert('이 화면은 데스크탑(Electron) 빌드 전용이에요.\n\n웹 브라우저에서는 기존 화면을 사용해 주세요.')
      return
    }
    const path = await window.eum.pickDirectory({ title: '작업 폴더 선택' })
    if (!path) return
    await loadFromPath(path)
  }, [loadFromPath])

  // ===== 마운트 시 자동 복원 — 마지막 작업 폴더 그대로 =====
  useEffect(() => {
    if (!window.eum?.isElectron) return
    let cancelled = false
    void (async () => {
      const saved = ((): string | null => {
        try {
          return localStorage.getItem(SAVED_ROOT_KEY)
        } catch {
          return null
        }
      })()
      if (!saved || cancelled) return
      // 디스크에 폴더 여전히 있는지 확인 — 없으면 welcome 화면으로 fallback
      try {
        const exists = await window.eum!.fs.exists(saved)
        if (!exists) {
          localStorage.removeItem(SAVED_ROOT_KEY)
          return
        }
      } catch {
        return
      }
      if (cancelled) return
      await loadFromPath(saved)
    })()
    return () => {
      cancelled = true
    }
  }, [loadFromPath])

  // ===== 폴더 만들기 =====
  const handleCreateFolder = useCallback(async () => {
    if (!meta) return
    const name = newFolderName.trim()
    if (!name) {
      newFolderInputRef.current?.focus()
      return
    }
    try {
      const next = await createPersonFolder(meta, name, null)
      setMeta(next)
      setNewFolderName('')
      setStatusMessage(`「${name}」 폴더를 만들었어요.`)
      newFolderInputRef.current?.focus()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }, [meta, newFolderName])

  // ===== 폴더 삭제 =====
  const handleDeleteFolder = useCallback(
    async (folder: PersonFolder) => {
      if (!meta) return
      const confirmMsg =
        `「${folder.name}」 폴더를 지웁니다.\n\n` +
        `· 「원본/」 사진은 그대로 남아요.\n` +
        `· 이 폴더 안 사본만 사라져요.\n\n계속할까요?`
      if (!window.confirm(confirmMsg)) return
      try {
        const next = await deletePersonFolder(meta, folder)
        setMeta(next)
        if (activeFolderKey === folderKey(folder)) setActiveFolderKey(null)
        if (drillInKey === folderKey(folder)) {
          setDrillInKey(null)
          setSelectedFileNames(new Set())
          lastSelectedRef.current = null
        }
        setStatusMessage(`「${folder.name}」 폴더를 지웠어요.`)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [meta, activeFolderKey, drillInKey],
  )

  // ===== 폴더 이름 변경 (인라인 input — Electron의 window.prompt 비활성 회피) =====
  const startRename = useCallback((folder: PersonFolder) => {
    setRenamingKey(folderKey(folder))
    setRenameValue(folder.name)
    setActiveFolderKey(folderKey(folder))
  }, [])

  const cancelRename = useCallback(() => {
    setRenamingKey(null)
    setRenameValue('')
  }, [])

  const confirmRename = useCallback(async () => {
    if (!meta || !renamingKey) return
    const targetKey = renamingKey
    const folder = meta.personFolders.find((f) => folderKey(f) === targetKey)
    setRenamingKey(null)
    setRenameValue('')
    if (!folder) return
    const newName = renameValue.trim()
    if (!newName || newName === folder.name) return
    try {
      const next = await renamePersonFolder(meta, folder, newName)
      setMeta(next)
      setStatusMessage(`「${folder.name}」을 「${newName}」(으)로 바꿨어요.`)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }, [meta, renamingKey, renameValue])

  // ===== 사진 추가 (파일 선택 다이얼로그 전용) =====
  // 외부에서 영역에 드래그·드롭으로 추가하는 흐름은 비활성 — 사용자 결정(2026-05-10).
  // 드래그는 「사진 카드 → 인물 폴더」 분류용으로만.
  const processFiles = useCallback(
    async (files: File[]) => {
      if (!meta || files.length === 0) return
      setIsAdding(true)
      setAddProgress(`사진 ${files.length}장 처리 중…`)
      try {
        const result = await addPhotos(meta, files)
        setMeta(result.meta)
        const added = result.addedCount
        const skipped = result.skippedNames.length
        if (added === 0 && skipped > 0) {
          setStatusMessage(`이미 있는 사진이라 ${skipped}장 모두 건너뛰었어요.`)
        } else if (skipped > 0) {
          setStatusMessage(`사진 ${added}장 추가, ${skipped}장은 이미 있어서 건너뜀.`)
        } else {
          setStatusMessage(`사진 ${added}장을 「원본/」에 추가했어요.`)
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      } finally {
        setIsAdding(false)
        setAddProgress('')
      }
    },
    [meta],
  )

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = ''  // 같은 파일 다시 선택 가능하도록
      await processFiles(files)
    },
    [processFiles],
  )

  // 우측 main 영역에서 외부 파일 드롭 = 무시 (브라우저 기본 「파일 열기」만 차단).
  const blockExternalDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault()
    }
  }, [])

  // ===== 사진 다중 선택 =====
  // Click = 단일 / Ctrl(Cmd)+Click = 토글 / Shift+Click = 마지막 ~ 현재 범위.
  const handlePhotoClick = useCallback(
    (fileName: string, allNames: string[]) =>
      (e: React.MouseEvent<HTMLElement>) => {
        if (e.ctrlKey || e.metaKey) {
          setSelectedFileNames((curr) => {
            const next = new Set(curr)
            if (next.has(fileName)) next.delete(fileName)
            else next.add(fileName)
            return next
          })
          lastSelectedRef.current = fileName
        } else if (e.shiftKey && lastSelectedRef.current) {
          const lastIdx = allNames.indexOf(lastSelectedRef.current)
          const currIdx = allNames.indexOf(fileName)
          if (lastIdx === -1 || currIdx === -1) {
            setSelectedFileNames(new Set([fileName]))
            lastSelectedRef.current = fileName
            return
          }
          const [start, end] = [Math.min(lastIdx, currIdx), Math.max(lastIdx, currIdx)]
          setSelectedFileNames(new Set(allNames.slice(start, end + 1)))
        } else {
          setSelectedFileNames(new Set([fileName]))
          lastSelectedRef.current = fileName
        }
      },
    [],
  )

  // ===== 사진 카드 → 인물 폴더 드래그 분류 (복사 모드) =====
  // mode='copy' 통일 — 같은 사진을 여러 폴더에 같이 분류 가능.
  // 사용자 결정(2026-05-10): 「폴더로 끌면 기존 폴더 사진 안 사라져야」.
  const handlePhotoDragStart = useCallback(
    (fileName: string) => (e: React.DragEvent<HTMLElement>) => {
      // 끌리는 사진이 선택 안 돼 있으면 그것만 선택해서 끄는 사진 1장만 처리
      let names: string[]
      if (selectedFileNames.has(fileName) && selectedFileNames.size > 1) {
        names = [...selectedFileNames]
      } else {
        names = [fileName]
        setSelectedFileNames(new Set([fileName]))
        lastSelectedRef.current = fileName
      }
      e.dataTransfer.setData(DRAG_TYPE_FILENAMES, JSON.stringify(names))
      e.dataTransfer.effectAllowed = 'copy'
    },
    [selectedFileNames],
  )

  const handleFolderDragOver = useCallback(
    (folder: PersonFolder) => (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE_FILENAMES)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setFolderDragOverKey(folderKey(folder))
    },
    [],
  )

  const handleFolderDragLeave = useCallback(
    () => setFolderDragOverKey(null),
    [],
  )

  const handleFolderDrop = useCallback(
    (folder: PersonFolder) => async (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault()
      setFolderDragOverKey(null)
      const namesJson = e.dataTransfer.getData(DRAG_TYPE_FILENAMES)
      if (!namesJson || !meta) return
      let fileNames: string[]
      try {
        const parsed: unknown = JSON.parse(namesJson)
        fileNames = Array.isArray(parsed) ? (parsed as string[]) : []
      } catch {
        return
      }
      if (fileNames.length === 0) return

      let nextMeta = meta
      let putCount = 0
      let alreadyCount = 0
      const errors: string[] = []
      for (const fn of fileNames) {
        const photo = nextMeta.photos[fn]
        if (!photo) continue
        const rel = getPersonFolderRelPath(folder)
        if (photo.personFolderPaths.includes(rel)) {
          alreadyCount += 1
          continue
        }
        try {
          nextMeta = await movePhotoToFolder(nextMeta, fn, folder, 'copy')
          putCount += 1
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      setMeta(nextMeta)

      const parts: string[] = []
      if (putCount > 0) parts.push(`${putCount}장을 「${folder.name}」 폴더에 넣었어요`)
      if (alreadyCount > 0) parts.push(`${alreadyCount}장은 이미 들어있음`)
      if (errors.length > 0) parts.push(`${errors.length}장 실패`)
      setStatusMessage(parts.length ? parts.join(' · ') : '변경 없음')
      if (errors.length > 0) {
        window.alert('일부 사진 분류 실패:\n' + errors.slice(0, 3).join('\n'))
      }
    },
    [meta],
  )

  // ===== 활성 폴더 (좌측에서 한 번 클릭한 폴더) =====
  const activeFolder = useMemo(() => {
    if (!meta || !activeFolderKey) return null
    return meta.personFolders.find((f) => folderKey(f) === activeFolderKey) ?? null
  }, [meta, activeFolderKey])

  // 선택된 사진 묶음을 한 폴더로 보내기 (copy). drop 핸들러와 같은 정책.
  const sendSelectedToFolder = useCallback(
    async (folder: PersonFolder) => {
      if (!meta || selectedFileNames.size === 0) return
      let nextMeta = meta
      let putCount = 0
      let alreadyCount = 0
      const errors: string[] = []
      const rel = getPersonFolderRelPath(folder)
      for (const fn of selectedFileNames) {
        const photo = nextMeta.photos[fn]
        if (!photo) continue
        if (photo.personFolderPaths.includes(rel)) {
          alreadyCount += 1
          continue
        }
        try {
          nextMeta = await movePhotoToFolder(nextMeta, fn, folder, 'copy')
          putCount += 1
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      setMeta(nextMeta)
      const parts: string[] = []
      if (putCount > 0) parts.push(`${putCount}장을 「${folder.name}」 폴더에 넣었어요`)
      if (alreadyCount > 0) parts.push(`${alreadyCount}장은 이미 들어있음`)
      if (errors.length > 0) parts.push(`${errors.length}장 실패`)
      setStatusMessage(parts.length ? parts.join(' · ') : '변경 없음')
      if (errors.length > 0) {
        window.alert('일부 사진 분류 실패:\n' + errors.slice(0, 3).join('\n'))
      }
    },
    [meta, selectedFileNames],
  )

  // ===== 사진 우클릭 → 폴더에서 빼기 메뉴 =====
  const handlePhotoContextMenu = useCallback(
    (fileName: string) => (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setPhotoMenu({ fileName, x: e.clientX, y: e.clientY })
    },
    [],
  )

  const removeFromFolder = useCallback(
    async (fileName: string, folder: PersonFolder) => {
      if (!meta) return
      try {
        const next = await removePhotoFromFolder(meta, fileName, folder)
        setMeta(next)
        setStatusMessage(`「${fileName}」을 「${folder.name}」 폴더에서 뺐어요.`)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [meta],
  )

  // 사진 영구 삭제 — confirm 후 디스크 원본+사본+메타 제거. 다중 선택 지원.
  const deleteSelectedPhotos = useCallback(
    async (names: string[]) => {
      if (!meta || names.length === 0) return
      const msg =
        names.length === 1
          ? `「${names[0]}」을 영구 삭제할까요?\n\n· 원본 + 모든 폴더 사본이 디스크에서 제거됩니다.\n· 되돌릴 수 없어요.`
          : `사진 ${names.length}장을 영구 삭제할까요?\n\n· 원본 + 모든 폴더 사본이 디스크에서 제거됩니다.\n· 되돌릴 수 없어요.`
      if (!window.confirm(msg)) return

      let nextMeta = meta
      let okCount = 0
      const errors: string[] = []
      for (const name of names) {
        try {
          nextMeta = await deletePhoto(nextMeta, name)
          okCount += 1
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      setMeta(nextMeta)
      // 삭제된 사진의 blob URL 정리
      setPhotoUrls((curr) => {
        const next = new Map(curr)
        for (const name of names) {
          const url = next.get(name)
          if (url) URL.revokeObjectURL(url)
          next.delete(name)
        }
        return next
      })
      setSelectedFileNames((curr) => {
        const next = new Set(curr)
        for (const name of names) next.delete(name)
        return next
      })
      // 라이트박스에 삭제된 사진 떠있으면 닫기
      if (lightboxName && names.includes(lightboxName)) {
        setLightboxName(null)
        setLightboxZoom(1)
      }
      setStatusMessage(
        `사진 ${okCount}장 삭제 완료${errors.length > 0 ? ` · ${errors.length}장 실패` : ''}.`,
      )
      if (errors.length > 0) {
        window.alert('일부 삭제 실패:\n' + errors.slice(0, 3).join('\n'))
      }
    },
    [meta, lightboxName],
  )

  // drill-in 변경 = 다른 화면. 선택 같이 초기화하기 위해 헬퍼로 wrap.
  const changeDrillIn = useCallback((nextKey: string | null) => {
    setDrillInKey(nextKey)
    setSelectedFileNames(new Set())
    lastSelectedRef.current = null
  }, [])

  // ===== 사진 썸네일 blob URL 로드 =====
  // meta.photos 변경 시 새로 추가된 fileName 만 readFile + blob URL 만들기.
  // unmount 시 모두 revoke. 사진 삭제 케이스는 Day 7+에서.
  useEffect(() => {
    if (!meta) return
    const fs = window.eum?.fs
    if (!fs) return
    const fileNames = Object.keys(meta.photos)
    const need = fileNames.filter((n) => !photoUrls.has(n))
    if (need.length === 0) return

    let cancelled = false
    void (async () => {
      for (const name of need) {
        if (cancelled) return
        try {
          const buf = await fs.readFile(joinPath(getOriginalDir(meta.rootPath), name))
          if (cancelled) return
          const blob = new Blob([buf])
          const url = URL.createObjectURL(blob)
          setPhotoUrls((curr) => {
            if (curr.has(name)) {
              URL.revokeObjectURL(url)
              return curr
            }
            const next = new Map(curr)
            next.set(name, url)
            return next
          })
        } catch (err) {
          console.warn('[NewProjectView] 사진 로드 실패:', name, err)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.photos, meta?.rootPath])

  // unmount 시 모든 blob URL revoke
  useEffect(() => {
    return () => {
      for (const url of photoUrls.values()) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 보일 사진 목록 (drill-in 폴더 또는 전체) =====
  const drillInFolder = useMemo(() => {
    if (!meta || !drillInKey) return null
    return meta.personFolders.find((f) => folderKey(f) === drillInKey) ?? null
  }, [meta, drillInKey])

  const visiblePhotoNames = useMemo(() => {
    if (!meta) return []
    const all = Object.keys(meta.photos)
    if (drillInFolder) {
      const rel = getPersonFolderRelPath(drillInFolder)
      return all.filter((n) => meta.photos[n].personFolderPaths.includes(rel))
    }
    if (showOnlyUnclassified) {
      return all.filter((n) => meta.photos[n].personFolderPaths.length === 0)
    }
    return all
  }, [meta, drillInFolder, showOnlyUnclassified])

  // 분류 진행 통계 (전체 / 분류됨 / 미분류)
  const photoStats = useMemo(() => {
    if (!meta) return { total: 0, classified: 0, unclassified: 0 }
    let classified = 0
    let unclassified = 0
    for (const name of Object.keys(meta.photos)) {
      if (meta.photos[name].personFolderPaths.length > 0) classified += 1
      else unclassified += 1
    }
    return { total: classified + unclassified, classified, unclassified }
  }, [meta])

  // ===== 사이즈 일괄 변경 (공유용 폴더에 줄인 사본) =====
  const applyBulkShrink = useCallback(
    async (maxLongSide: number, quality: number) => {
      if (!meta || selectedFileNames.size === 0) return
      const fs = window.eum?.fs
      if (!fs) {
        window.alert('데스크탑(Electron) 빌드에서만 동작해요.')
        return
      }
      const names = [...selectedFileNames]
      const total = names.length
      setShrinkDialog((curr) =>
        curr
          ? { ...curr, isApplying: true, done: 0, total }
          : null,
      )

      const shareDir = joinPath(
        meta.rootPath.replace(/[\\/]+$/, ''),
        'EUM-Photo',
        '공유용',
      )
      let okCount = 0
      const errors: string[] = []

      for (let i = 0; i < names.length; i += 1) {
        const name = names[i]
        const photo = meta.photos[name]
        if (!photo) continue
        try {
          const srcPath = joinPath(getOriginalDir(meta.rootPath), name)
          const buffer = await fs.readFile(srcPath)
          const mime = mimeFromFileName(name)
          const resizedBuffer = await resizeImageToJpegBuffer(
            buffer,
            mime,
            maxLongSide,
            quality,
          )
          // 저장 이름 = 항상 .jpg 확장자
          const baseStem = name.replace(/\.[^.]+$/, '')
          const outName = `${baseStem}.jpg`

          const savePaths: string[] = []
          if (photo.personFolderPaths.length === 0) {
            savePaths.push(joinPath(shareDir, '_미분류', outName))
          } else {
            for (const rel of photo.personFolderPaths) {
              savePaths.push(joinPath(shareDir, rel, outName))
            }
          }
          for (const sp of savePaths) {
            await fs.writeFile(sp, resizedBuffer)
          }
          okCount += 1
        } catch (err) {
          errors.push(
            `${name}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        setShrinkDialog((curr) =>
          curr ? { ...curr, done: i + 1 } : null,
        )
      }

      setShrinkDialog(null)
      setStatusMessage(
        `${okCount}장 사이즈 변경 → 「공유용/」 폴더 저장${errors.length > 0 ? ` · ${errors.length}장 실패` : ''}.`,
      )
      if (errors.length > 0) {
        window.alert('일부 실패:\n' + errors.slice(0, 3).join('\n'))
      }
    },
    [meta, selectedFileNames],
  )

  // ===== 일괄 이름 변경 헬퍼 =====
  // 선택된 사진들에 패턴 적용. 미리보기 + 실제 적용 공유.
  const buildRenamePairs = useCallback(
    (prefix: string): Array<{ oldName: string; newName: string }> => {
      if (!meta || selectedFileNames.size === 0 || !prefix.trim()) return []
      const safePrefix = prefix
        .trim()
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 60)
      if (!safePrefix) return []
      const ordered = visiblePhotoNames.filter((n) => selectedFileNames.has(n))
      const total = ordered.length
      const digits = String(total).length
      const padded = (i: number) => String(i).padStart(Math.max(digits, 3), '0')
      return ordered.map((oldName, idx) => {
        const dotIdx = oldName.lastIndexOf('.')
        const ext = dotIdx > 0 ? oldName.slice(dotIdx + 1) : 'jpg'
        const newName = `${safePrefix}_${padded(idx + 1)}.${ext}`
        return { oldName, newName }
      })
    },
    [meta, selectedFileNames, visiblePhotoNames],
  )

  const applyBulkRename = useCallback(
    async (prefix: string) => {
      if (!meta) return
      const pairs = buildRenamePairs(prefix)
      if (pairs.length === 0) return

      const newNamesSet = new Set(pairs.map((p) => p.newName))
      if (newNamesSet.size !== pairs.length) {
        window.alert('생성될 새 이름 중 중복이 있어요. 다른 prefix를 시도해 주세요.')
        return
      }
      const oldNamesSet = new Set(pairs.map((p) => p.oldName))
      for (const p of pairs) {
        if (meta.photos[p.newName] && !oldNamesSet.has(p.newName)) {
          window.alert(
            `「${p.newName}」 이름이 이미 다른 사진에 쓰이고 있어요. 다른 prefix를 시도해 주세요.`,
          )
          return
        }
      }

      setRenameDialog((curr) => (curr ? { ...curr, isApplying: true } : curr))
      let nextMeta = meta
      let okCount = 0
      const errors: string[] = []
      for (const { oldName, newName } of pairs) {
        try {
          nextMeta = await renamePhoto(nextMeta, oldName, newName)
          okCount += 1
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      setMeta(nextMeta)

      setPhotoUrls((curr) => {
        const next = new Map(curr)
        for (const { oldName, newName } of pairs) {
          const url = next.get(oldName)
          if (url) {
            next.set(newName, url)
            next.delete(oldName)
          }
        }
        return next
      })

      setSelectedFileNames((curr) => {
        const next = new Set<string>()
        const map = new Map(pairs.map((p) => [p.oldName, p.newName]))
        for (const n of curr) next.add(map.get(n) ?? n)
        return next
      })

      if (lightboxName) {
        const found = pairs.find((p) => p.oldName === lightboxName)
        if (found) setLightboxName(found.newName)
      }

      setRenameDialog(null)
      setStatusMessage(
        `사진 ${okCount}장 이름 변경 완료${errors.length > 0 ? ` · ${errors.length}장 실패` : ''}.`,
      )
      if (errors.length > 0) {
        window.alert('일부 이름 변경 실패:\n' + errors.slice(0, 3).join('\n'))
      }
    },
    [meta, buildRenamePairs, lightboxName],
  )

  // 정렬된 인물 폴더 + 번호 맵. 정렬 순서대로 1~N 번호 부여.
  // 폴더 추가/삭제/이름변경 시 번호 자동 재할당. UI는 번호로만 표시 → 더미 라벨 가독성↑.
  const sortedFolders = useMemo(() => {
    if (!meta) return []
    return [...meta.personFolders].sort((a, b) =>
      a.name.localeCompare(b.name, 'ko'),
    )
  }, [meta])

  const folderNumberMap = useMemo(() => {
    const map = new Map<string, number>()
    sortedFolders.forEach((f, i) => map.set(folderKey(f), i + 1))
    return map
  }, [sortedFolders])

  // 폴더별 사진 수 (rel path → 그 폴더 사본 사진 수)
  const folderPhotoCount = useMemo(() => {
    const map = new Map<string, number>()
    if (!meta) return map
    for (const photo of Object.values(meta.photos)) {
      for (const rel of photo.personFolderPaths) {
        map.set(rel, (map.get(rel) ?? 0) + 1)
      }
    }
    return map
  }, [meta])

  // ===== 라이트박스 (사진 큰 화면 보기) =====
  const lightboxIndex = lightboxName
    ? visiblePhotoNames.indexOf(lightboxName)
    : -1

  const closeLightbox = useCallback(() => {
    setLightboxName(null)
    setLightboxZoom(1)
  }, [])

  const showPrevPhoto = useCallback(() => {
    if (lightboxIndex <= 0) return
    setLightboxName(visiblePhotoNames[lightboxIndex - 1])
    setLightboxZoom(1)
  }, [lightboxIndex, visiblePhotoNames])

  const showNextPhoto = useCallback(() => {
    if (lightboxIndex < 0 || lightboxIndex >= visiblePhotoNames.length - 1) return
    setLightboxName(visiblePhotoNames[lightboxIndex + 1])
    setLightboxZoom(1)
  }, [lightboxIndex, visiblePhotoNames])

  const zoomIn = useCallback(() => {
    setLightboxZoom((z) => {
      const next = ZOOM_STEPS.find((s) => s > z)
      return next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    })
  }, [])

  const zoomOut = useCallback(() => {
    setLightboxZoom((z) => {
      const list = [...ZOOM_STEPS].reverse()
      const next = list.find((s) => s < z)
      return next ?? ZOOM_STEPS[0]
    })
  }, [])

  // 라이트박스에서 숫자키(1~9) 또는 키패드 클릭 → 폴더 토글.
  // 들어있으면 빼기, 안 들어있으면 추가 (copy). 다음 사진은 → 키로 명시 이동.
  const handleLightboxToggleFolder = useCallback(
    async (num: number) => {
      if (!meta || !lightboxName) return
      let targetFolder: PersonFolder | null = null
      for (const folder of meta.personFolders) {
        if (folderNumberMap.get(folderKey(folder)) === num) {
          targetFolder = folder
          break
        }
      }
      if (!targetFolder) {
        setStatusMessage(`${num}번 폴더가 없어요.`)
        return
      }
      const photo = meta.photos[lightboxName]
      if (!photo) return

      const rel = getPersonFolderRelPath(targetFolder)
      const folderLabel = `${num}. ${targetFolder.name}`
      try {
        if (photo.personFolderPaths.includes(rel)) {
          const next = await removePhotoFromFolder(meta, lightboxName, targetFolder)
          setMeta(next)
          setStatusMessage(`「${folderLabel}」에서 뺐어요.`)
        } else {
          const next = await movePhotoToFolder(meta, lightboxName, targetFolder, 'copy')
          setMeta(next)
          setStatusMessage(`「${folderLabel}」에 추가했어요.`)
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [meta, lightboxName, folderNumberMap],
  )

  // ===== Rubber band 영역 선택 (파일 탐색기 처럼) =====
  // 빈 영역에서 mousedown → 사각형 → 그 안 사진 선택. Shift/Ctrl이면 기존 선택 유지.
  const handleMainMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0) return  // 좌클릭만
      if (lightboxName) return  // 라이트박스 떠있을 땐 비활성
      // 사진 카드 위에서 시작 = OS drag 동작에 양보
      if ((e.target as HTMLElement).closest('[data-photo-card]')) return
      // 버튼·입력 위는 무시
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return
      const main = mainRef.current
      if (!main) return

      const rect = main.getBoundingClientRect()
      const startX = e.clientX - rect.left + main.scrollLeft
      const startY = e.clientY - rect.top + main.scrollTop

      // 빈 영역에서 단순 클릭 시작 → 우선 모두 deselect (Shift/Ctrl 누르면 유지)
      const keepBase = e.shiftKey || e.ctrlKey || e.metaKey
      const baseSelection = keepBase ? new Set(selectedFileNames) : new Set<string>()
      if (!keepBase) {
        setSelectedFileNames(new Set())
        lastSelectedRef.current = null
      }
      setRubberBand({ x: startX, y: startY, w: 0, h: 0 })

      const onMove = (ev: MouseEvent) => {
        const m = mainRef.current
        if (!m) return
        const r = m.getBoundingClientRect()
        const cx = ev.clientX - r.left + m.scrollLeft
        const cy = ev.clientY - r.top + m.scrollTop
        const x = Math.min(startX, cx)
        const y = Math.min(startY, cy)
        const w = Math.abs(cx - startX)
        const h = Math.abs(cy - startY)
        setRubberBand({ x, y, w, h })

        // 사각형 안 카드 selection 갱신 (실시간)
        const newSel = new Set(baseSelection)
        const cards = m.querySelectorAll('[data-photo-card]') as NodeListOf<HTMLElement>
        cards.forEach((card) => {
          const cr = card.getBoundingClientRect()
          const cardX = cr.left - r.left + m.scrollLeft
          const cardY = cr.top - r.top + m.scrollTop
          const cardX2 = cardX + cr.width
          const cardY2 = cardY + cr.height
          if (cardX < x + w && cardX2 > x && cardY < y + h && cardY2 > y) {
            const photoName = card.getAttribute('data-photo-card')
            if (photoName) newSel.add(photoName)
          }
        })
        setSelectedFileNames(newSel)
      }
      const onUp = () => {
        setRubberBand(null)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [selectedFileNames, lightboxName],
  )

  // ===== 키보드 단축키 =====
  // 일반 모드: Ctrl+A 전체 / Esc 해제 / Space 활성 폴더로 추가
  // 라이트박스 모드: ←→ 이전/다음 / +/- 확대/축소 / Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // 라이트박스 모드 — 그리드 단축키 무시
      if (lightboxName) {
        if (e.key === 'Escape') {
          e.preventDefault()
          closeLightbox()
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          showPrevPhoto()
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          showNextPhoto()
        } else if (e.key === '+' || e.key === '=') {
          e.preventDefault()
          zoomIn()
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          zoomOut()
        } else if (e.key === '0') {
          e.preventDefault()
          setLightboxZoom(1)
        } else if (e.key >= '1' && e.key <= '9') {
          // 숫자 1~9 = 그 번호 폴더 토글 (들어있으면 빼고, 없으면 추가)
          e.preventDefault()
          void handleLightboxToggleFolder(parseInt(e.key, 10))
        }
        return
      }

      // 일반 모드
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelectedFileNames(new Set(visiblePhotoNames))
      } else if (e.key === 'Escape') {
        if (selectedFileNames.size > 0) {
          setSelectedFileNames(new Set())
          lastSelectedRef.current = null
        }
      } else if (e.key === ' ') {
        e.preventDefault()
        if (selectedFileNames.size === 0) {
          setStatusMessage('먼저 사진을 선택해 주세요 (클릭·Ctrl+클릭·드래그).')
          return
        }
        if (!activeFolder) {
          setStatusMessage('먼저 좌측에서 인물 폴더를 한 번 클릭해 주세요.')
          return
        }
        void sendSelectedToFolder(activeFolder)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedFileNames.size === 0) return
        e.preventDefault()
        void deleteSelectedPhotos([...selectedFileNames])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    visiblePhotoNames,
    selectedFileNames,
    activeFolder,
    sendSelectedToFolder,
    deleteSelectedPhotos,
    lightboxName,
    closeLightbox,
    showPrevPhoto,
    showNextPhoto,
    zoomIn,
    zoomOut,
    handleLightboxToggleFolder,
  ])

  // ===== 화면 =====

  if (screen === 'no-folder') {
    return (
      <div className={css.fullScreen}>
        <div className={css.welcomeCard}>
          <img src={eumLogo} alt="E:UM" className={css.welcomeLogo} />
          <h1 className={css.welcomeTitle}>E:UM Photo</h1>
          <p className={css.welcomeText}>
            행사 사진을 학생별로 정리하는 데스크탑 도구예요.
          </p>
          <p className={css.welcomeHint}>
            먼저 사진을 모을 작업 폴더를 한 번 정해 주세요.<br />
            폴더 안에 「EUM-Photo」가 자동으로 만들어져요.
          </p>
          <button type="button" className={css.bigButton} onClick={handlePickFolder}>
            📂 작업 폴더 선택
          </button>
        </div>
      </div>
    )
  }

  if (screen === 'loading') {
    return (
      <div className={css.fullScreen}>
        <div className={css.welcomeCard}>
          <p className={css.welcomeText}>{statusMessage}</p>
        </div>
      </div>
    )
  }

  if (!meta) return null

  return (
    <div className={css.app}>
      {/* 상단 바 */}
      <header className={css.header}>
        <div className={css.headerLeft}>
          <img src={eumLogo} alt="E:UM" className={css.headerLogo} />
          <h1 className={css.appTitle}>E:UM Photo</h1>
          <span className={css.workFolder} title={statusMessage}>
            {statusMessage}
          </span>
        </div>
        <div className={css.headerRight}>
          <button
            type="button"
            className={css.smallButton}
            onClick={() => {
              if (window.eum?.isElectron && meta.rootPath) {
                void window.eum.openInExplorer(meta.rootPath)
              }
            }}
          >
            📂 탐색기 열기
          </button>
        </div>
      </header>

      <div className={css.body}>
        {/* 좌측 — 폴더 트리 */}
        <aside className={css.sidebar}>
          <div className={css.sidebarSection}>
            <h2 className={css.sidebarTitle}>📁 인물 폴더</h2>

            {/* 폴더 만들기 */}
            <div className={css.newFolderRow}>
              <input
                ref={newFolderInputRef}
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleCreateFolder()
                  }
                }}
                placeholder="새 폴더 이름 (예: 홍길동)"
                className={css.newFolderInput}
              />
              <button type="button" className={css.newFolderButton} onClick={() => void handleCreateFolder()}>
                + 만들기
              </button>
            </div>

            {/* 폴더 트리 — 단순 평면 리스트 (인물 폴더 = 정리/<인물>) */}
            {sortedFolders.length === 0 ? (
              <p className={css.emptyHint}>
                아직 폴더가 없어요.<br />
                위 입력창에 학생 이름을 넣고 「만들기」를 눌러 보세요.
              </p>
            ) : (
              <div>
                {sortedFolders.map((folder) => {
                  const key = folderKey(folder)
                  const isActive = activeFolderKey === key
                  const isDrillIn = drillInKey === key
                  const isDropTarget = folderDragOverKey === key
                  return (
                    <div
                      key={key}
                      className={cn(
                        css.folderRow,
                        isActive && css.folderRowActive,
                        isDrillIn && css.folderRowDrillIn,
                        isDropTarget && css.folderRowDropTarget,
                      )}
                      onClick={() => {
                        setActiveFolderKey(key)
                        setStatusMessage(
                          `「${folder.name}」 폴더 선택. 사진을 끌어다 놓으면 이 폴더로 보낼 수 있어요.`,
                        )
                      }}
                      onDoubleClick={() => {
                        changeDrillIn(drillInKey === key ? null : key)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setFolderMenu({ folder, x: e.clientX, y: e.clientY })
                      }}
                      onDragOver={handleFolderDragOver(folder)}
                      onDragLeave={handleFolderDragLeave}
                      onDrop={handleFolderDrop(folder)}
                      title="클릭 = 폴더 선택 · 더블클릭 = 이 폴더 사진만 보기 · 사진 끌어다 놓기 = 분류 · 우클릭 = 메뉴"
                    >
                      <span className={css.folderIcon}>📁</span>
                      {renamingKey === key ? (
                        <input
                          autoFocus
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void confirmRename()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelRename()
                            }
                          }}
                          onBlur={() => void confirmRename()}
                          className={css.renameInput}
                        />
                      ) : (
                        <>
                          <span className={css.folderName}>
                            <span className={css.folderNumber}>
                              {folderNumberMap.get(key)}.
                            </span>{' '}
                            {folder.name}
                          </span>
                          <span className={css.folderCount}>
                            {folderPhotoCount.get(getPersonFolderRelPath(folder)) ?? 0}
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        {/* 우측 — 사진 추가 + 썸네일 그리드. 외부 드롭으로 추가는 비활성. */}
        <main
          ref={mainRef}
          className={css.mainArea}
          onDragOver={blockExternalDrop}
          onDrop={blockExternalDrop}
          onMouseDown={handleMainMouseDown}
        >
          <div className={css.mainHeader}>
            <div className={css.mainHeaderLeft}>
              <h2 className={css.mainHeaderTitle}>
                {drillInFolder
                  ? `📁 ${drillInFolder.name}`
                  : showOnlyUnclassified
                    ? '🗂 미분류 사진'
                    : '📷 모든 사진'}
              </h2>
              <span className={css.mainHeaderCount}>
                {visiblePhotoNames.length}장
                {!drillInFolder && photoStats.total > 0 && (
                  <>
                    {' '}· 전체 {photoStats.total} ·{' '}
                    <span className={css.statClassified}>
                      분류 {photoStats.classified}
                    </span>{' '}
                    ·{' '}
                    <span className={css.statUnclassified}>
                      미분류 {photoStats.unclassified}
                    </span>
                  </>
                )}
                {selectedFileNames.size > 0 && (
                  <span className={css.selectedCount}>
                    {' '}· 선택 {selectedFileNames.size}장
                  </span>
                )}
              </span>
              {drillInFolder && (
                <button
                  type="button"
                  className={css.smallButton}
                  onClick={() => changeDrillIn(null)}
                >
                  ← 전체 보기
                </button>
              )}
              {!drillInFolder && photoStats.total > 0 && (
                <label className={css.toggleRow}>
                  <input
                    type="checkbox"
                    checked={showOnlyUnclassified}
                    onChange={(e) => setShowOnlyUnclassified(e.target.checked)}
                  />
                  미분류만 보기
                </label>
              )}
              {selectedFileNames.size > 0 && (
                <button
                  type="button"
                  className={css.smallButton}
                  onClick={() => setSelectedFileNames(new Set())}
                >
                  선택 해제
                </button>
              )}
              {selectedFileNames.size > 0 && (
                <button
                  type="button"
                  className={css.smallButton}
                  onClick={() => setRenameDialog({ prefix: '', isApplying: false })}
                  title="선택된 사진들의 이름을 한꺼번에 변경"
                >
                  ✏️ 이름 일괄 변경
                </button>
              )}
              {selectedFileNames.size > 0 && (
                <button
                  type="button"
                  className={css.smallButton}
                  onClick={() =>
                    setShrinkDialog({
                      maxLongSide: 1920,
                      quality: 0.85,
                      isApplying: false,
                      done: 0,
                      total: selectedFileNames.size,
                    })
                  }
                  title="선택된 사진들의 크기를 줄여 「공유용」 폴더에 사본 저장 (원본 보존)"
                >
                  📐 사이즈 변경
                </button>
              )}
              {selectedFileNames.size > 0 && activeFolder && (
                <span className={css.spaceHint}>
                  💡 스페이스바 = 「
                  {folderNumberMap.get(folderKey(activeFolder)) != null
                    ? `${folderNumberMap.get(folderKey(activeFolder))}. `
                    : ''}
                  {activeFolder.name}」에 추가
                </span>
              )}
            </div>
            <div className={css.mainHeaderRight}>
              <button
                type="button"
                className={css.bigAddButton}
                onClick={() => fileInputRef.current?.click()}
                disabled={isAdding}
              >
                {isAdding ? addProgress : '+ 사진 추가'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                onChange={handleFileInputChange}
                style={{ display: 'none' }}
              />
            </div>
          </div>

          {rubberBand && (
            <div
              className={css.rubberBand}
              style={{
                left: rubberBand.x,
                top: rubberBand.y,
                width: rubberBand.w,
                height: rubberBand.h,
              }}
            />
          )}

          {visiblePhotoNames.length === 0 ? (
            <div className={css.emptyDropZone}>
              {drillInFolder ? (
                <>
                  <p className={css.emptyDropTitle}>
                    「{drillInFolder.name}」 폴더에 아직 사진이 없어요
                  </p>
                  <p className={css.emptyDropHint}>
                    「← 전체 보기」로 돌아가서 사진을 「{drillInFolder.name}」 폴더로<br />
                    끌어다 놓으면 이 폴더로 보내져요.
                  </p>
                </>
              ) : showOnlyUnclassified && photoStats.total > 0 ? (
                <>
                  <p className={css.emptyDropTitle}>미분류 사진이 없어요</p>
                  <p className={css.emptyDropHint}>
                    분류 안 된 사진이 더 있다면 「☐ 미분류만 보기」를 끄고<br />
                    원본을 다시 확인해 주세요.
                  </p>
                </>
              ) : (
                <>
                  <p className={css.emptyDropTitle}>아직 사진이 없어요</p>
                  <p className={css.emptyDropHint}>
                    위 「+ 사진 추가」 버튼을 눌러 사진을 불러오세요.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className={css.grid}>
              {visiblePhotoNames.map((name) => {
                const url = photoUrls.get(name)
                const isSelected = selectedFileNames.has(name)
                const photo = meta.photos[name]
                // 카드 뱃지: 번호만. 툴팁: 「번호. 이름」.
                const folderEntries = photo
                  ? photo.personFolderPaths.map((rel) => {
                      const num = folderNumberMap.get(rel)
                      const segs = rel.split('/')
                      const folderName = segs[segs.length - 1]
                      return { num, name: folderName }
                    })
                  : []
                const tooltipNames = folderEntries
                  .map((e) => (e.num != null ? `${e.num}. ${e.name}` : e.name))
                  .join(', ')
                return (
                  <div
                    key={name}
                    data-photo-card={name}
                    className={cn(
                      css.photoCard,
                      isSelected && css.photoCardSelected,
                    )}
                    draggable
                    onClick={handlePhotoClick(name, visiblePhotoNames)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setLightboxName(name)
                      setLightboxZoom(1)
                    }}
                    onDragStart={handlePhotoDragStart(name)}
                    onContextMenu={handlePhotoContextMenu(name)}
                    title={
                      folderEntries.length > 0
                        ? `${folderEntries.length}개 폴더에 들어있음: ${tooltipNames} · 더블클릭 = 크게 보기`
                        : '클릭 = 선택 · 더블클릭 = 크게 보기 · Ctrl/Shift+클릭 = 다중 선택 · 끌어서 좌측 인물 폴더로 · 우클릭 = 폴더에서 빼기'
                    }
                  >
                    <div className={css.photoThumbWrap}>
                      {url ? (
                        <img
                          src={url}
                          alt={name}
                          className={css.photoImg}
                          draggable={false}
                        />
                      ) : (
                        <div className={css.photoLoading}>로드 중…</div>
                      )}
                      {isSelected && (
                        <div className={css.selectedBadge}>✓</div>
                      )}
                    </div>
                    <span className={css.photoCaption} title={name}>
                      {name}
                    </span>
                    {folderEntries.length > 0 && (
                      <div className={css.folderTagsList}>
                        {folderEntries.map((entry, i) => (
                          <span
                            key={i}
                            className={css.folderTag}
                            title={entry.name}
                          >
                            {entry.num != null ? entry.num : entry.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </main>
      </div>

      {/* 폴더 우클릭 메뉴 */}
      {folderMenu && (
        <div
          style={{ ...styles.menu, top: folderMenu.y, left: folderMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              changeDrillIn(folderKey(folderMenu.folder))
              setFolderMenu(null)
            }}
          >
            📂 이 폴더 사진만 보기
          </button>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              startRename(folderMenu.folder)
              setFolderMenu(null)
            }}
          >
            ✏️ 이름 변경
          </button>
          <button
            type="button"
            style={{ ...styles.menuItem, ...styles.menuItemDanger }}
            onClick={() => {
              void handleDeleteFolder(folderMenu.folder)
              setFolderMenu(null)
            }}
          >
            🗑 삭제
          </button>
        </div>
      )}

      {/* 사진 우클릭 메뉴 — 들어있는 폴더 중 빼기 + 영구 삭제 */}
      {photoMenu && meta && (() => {
        const photo = meta.photos[photoMenu.fileName]
        if (!photo) return null
        const photoFolders = photo.personFolderPaths
          .map((rel) => {
            const folder = meta.personFolders.find(
              (f) => getPersonFolderRelPath(f) === rel,
            )
            if (!folder) return null
            return {
              folder,
              num: folderNumberMap.get(folderKey(folder)),
            }
          })
          .filter((x): x is { folder: PersonFolder; num: number | undefined } => x !== null)

        // 우클릭한 사진이 선택돼있으면 다중 삭제, 아니면 그 1장만
        const targetNames =
          selectedFileNames.has(photoMenu.fileName) && selectedFileNames.size > 1
            ? [...selectedFileNames]
            : [photoMenu.fileName]

        return (
          <div
            style={{ ...styles.menu, top: photoMenu.y, left: photoMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={styles.menuHeader}>
              {photoFolders.length === 0
                ? '아직 어느 폴더에도 들어있지 않아요'
                : `${photoFolders.length}개 폴더에 들어있어요 — 어디서 뺄까요?`}
            </div>
            {photoFolders.map(({ folder, num }) => (
              <button
                key={getPersonFolderRelPath(folder)}
                type="button"
                style={{ ...styles.menuItem, ...styles.menuItemDanger }}
                onClick={() => {
                  void removeFromFolder(photoMenu.fileName, folder)
                  setPhotoMenu(null)
                }}
              >
                ❌ 「{num != null ? `${num}. ` : ''}{folder.name}」 폴더에서 빼기
              </button>
            ))}
            <div style={styles.menuDivider} />
            <button
              type="button"
              style={{ ...styles.menuItem, ...styles.menuItemDanger }}
              onClick={() => {
                void deleteSelectedPhotos(targetNames)
                setPhotoMenu(null)
              }}
            >
              🗑 사진 영구 삭제
              {targetNames.length > 1 ? ` (선택한 ${targetNames.length}장)` : ''}
            </button>
          </div>
        )
      })()}

      {/* 일괄 이름 변경 모달 */}
      {renameDialog && (() => {
        const pairs = buildRenamePairs(renameDialog.prefix)
        const previewPairs = pairs.slice(0, 3)
        const total = selectedFileNames.size
        const canApply = pairs.length === total && pairs.length > 0
        return (
          <div
            style={styles.modalOverlay}
            onClick={() => !renameDialog.isApplying && setRenameDialog(null)}
          >
            <div
              style={styles.modalCard}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={styles.modalTitle}>
                ✏️ 사진 {total}장 이름 일괄 변경
              </h3>
              <p style={styles.modalHint}>
                새 이름은 「<b>입력한 단어 + 번호.확장자</b>」 형태가 됩니다.
              </p>
              <input
                type="text"
                value={renameDialog.prefix}
                onChange={(e) =>
                  setRenameDialog({ ...renameDialog, prefix: e.target.value })
                }
                placeholder="예: 방학동총잡이"
                autoFocus
                style={styles.modalInput}
                disabled={renameDialog.isApplying}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canApply) {
                    e.preventDefault()
                    void applyBulkRename(renameDialog.prefix)
                  } else if (e.key === 'Escape') {
                    setRenameDialog(null)
                  }
                }}
              />

              <div style={styles.modalPreview}>
                <div style={styles.modalPreviewLabel}>
                  미리보기 ({pairs.length === 0 ? '단어를 입력하세요' : `처음 ${previewPairs.length}장 / 총 ${pairs.length}장`})
                </div>
                {previewPairs.map(({ oldName, newName }) => (
                  <div key={oldName} style={styles.modalPreviewRow}>
                    <span style={styles.modalPreviewOld}>{oldName}</span>
                    <span style={styles.modalPreviewArrow}>→</span>
                    <span style={styles.modalPreviewNew}>{newName}</span>
                  </div>
                ))}
              </div>

              <div style={styles.modalButtons}>
                <button
                  type="button"
                  className={css.smallButtonDanger}
                  onClick={() => setRenameDialog(null)}
                  disabled={renameDialog.isApplying}
                >
                  취소
                </button>
                <button
                  type="button"
                  style={
                    canApply && !renameDialog.isApplying
                      ? styles.modalApplyBtn
                      : styles.modalApplyBtnDisabled
                  }
                  onClick={() => void applyBulkRename(renameDialog.prefix)}
                  disabled={!canApply || renameDialog.isApplying}
                >
                  {renameDialog.isApplying
                    ? '변경 중…'
                    : `적용 (${pairs.length}장)`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 사이즈 일괄 변경 모달 */}
      {shrinkDialog && (() => {
        const presets = [640, 1024, 1280, 1920, 2560, 3840]
        const total = shrinkDialog.total
        return (
          <div
            style={styles.modalOverlay}
            onClick={() => !shrinkDialog.isApplying && setShrinkDialog(null)}
          >
            <div
              style={styles.modalCard}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={styles.modalTitle}>
                📐 사진 {total}장 사이즈 일괄 변경
              </h3>
              <p style={styles.modalHint}>
                「공유용/」 폴더에 줄인 jpg 사본을 저장해요. 원본은 그대로.
              </p>

              <div style={styles.modalLabel}>
                긴 변 최대 픽셀 — 100 ~ 16000 자유 입력
              </div>
              <div style={styles.modalPresetRow}>
                {presets.map((px) => (
                  <button
                    key={px}
                    type="button"
                    style={
                      shrinkDialog.maxLongSide === px
                        ? styles.modalPresetActive
                        : styles.modalPreset
                    }
                    onClick={() =>
                      setShrinkDialog({ ...shrinkDialog, maxLongSide: px })
                    }
                    disabled={shrinkDialog.isApplying}
                  >
                    {px}
                  </button>
                ))}
                <input
                  type="number"
                  min={100}
                  max={16000}
                  step={1}
                  value={shrinkDialog.maxLongSide}
                  onChange={(e) => {
                    const raw = Number(e.target.value)
                    // NaN/0/음수면 그대로 유지하지 않고 합리적 기본값
                    const next = Number.isFinite(raw) && raw > 0 ? raw : shrinkDialog.maxLongSide
                    setShrinkDialog({
                      ...shrinkDialog,
                      maxLongSide: Math.max(100, Math.min(16000, Math.round(next))),
                    })
                  }}
                  style={styles.modalNumberInput}
                  disabled={shrinkDialog.isApplying}
                />
                <span style={styles.modalUnit}>px</span>
              </div>

              <div style={styles.modalLabel}>
                품질 (jpg) — {Math.round(shrinkDialog.quality * 100)}%
              </div>
              <input
                type="range"
                min={50}
                max={95}
                step={5}
                value={Math.round(shrinkDialog.quality * 100)}
                onChange={(e) =>
                  setShrinkDialog({
                    ...shrinkDialog,
                    quality: Number(e.target.value) / 100,
                  })
                }
                disabled={shrinkDialog.isApplying}
                style={styles.modalRange}
              />

              {shrinkDialog.isApplying && (
                <div style={styles.modalProgress}>
                  처리 중… {shrinkDialog.done} / {shrinkDialog.total}장
                </div>
              )}

              <div style={styles.modalButtons}>
                <button
                  type="button"
                  className={css.smallButtonDanger}
                  onClick={() => setShrinkDialog(null)}
                  disabled={shrinkDialog.isApplying}
                >
                  취소
                </button>
                <button
                  type="button"
                  style={
                    !shrinkDialog.isApplying
                      ? styles.modalApplyBtn
                      : styles.modalApplyBtnDisabled
                  }
                  onClick={() =>
                    void applyBulkShrink(
                      shrinkDialog.maxLongSide,
                      shrinkDialog.quality,
                    )
                  }
                  disabled={shrinkDialog.isApplying}
                >
                  {shrinkDialog.isApplying
                    ? `처리 중… ${shrinkDialog.done}/${total}`
                    : `적용 (${total}장)`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 라이트박스 — 사진 큰 화면 보기 */}
      {lightboxName && meta && (() => {
        const url = photoUrls.get(lightboxName)
        const photo = meta.photos[lightboxName]
        const includedRels = new Set(photo?.personFolderPaths ?? [])
        const total = visiblePhotoNames.length
        const idx = lightboxIndex >= 0 ? lightboxIndex + 1 : 0
        const canPrev = lightboxIndex > 0
        const canNext = lightboxIndex >= 0 && lightboxIndex < total - 1
        return (
          <div style={styles.lightboxOverlay} onClick={closeLightbox}>
            <button
              type="button"
              style={styles.lightboxClose}
              onClick={closeLightbox}
              title="닫기 (Esc)"
            >
              ✕
            </button>

            <button
              type="button"
              style={{
                ...styles.lightboxNav,
                ...styles.lightboxNavLeft,
                ...(canPrev ? null : styles.lightboxNavDisabled),
              }}
              onClick={(e) => {
                e.stopPropagation()
                showPrevPhoto()
              }}
              disabled={!canPrev}
              title="이전 사진 (←)"
            >
              ◀
            </button>

            <div
              style={styles.lightboxImageWrap}
              onClick={(e) => e.stopPropagation()}
            >
              {url ? (
                <img
                  src={url}
                  alt={lightboxName}
                  draggable={false}
                  style={{
                    ...styles.lightboxImage,
                    transform: `scale(${lightboxZoom})`,
                  }}
                />
              ) : (
                <div style={{ color: '#fff' }}>로드 중…</div>
              )}
            </div>

            <button
              type="button"
              style={{
                ...styles.lightboxNav,
                ...styles.lightboxNavRight,
                ...(canNext ? null : styles.lightboxNavDisabled),
              }}
              onClick={(e) => {
                e.stopPropagation()
                showNextPhoto()
              }}
              disabled={!canNext}
              title="다음 사진 (→)"
            >
              ▶
            </button>

            {/* 폴더 키패드 — 들어있는 폴더 시각화 + 클릭으로 추가 */}
            {sortedFolders.length > 0 && (
              <div
                style={styles.lightboxFolderBar}
                onClick={(e) => e.stopPropagation()}
              >
                {sortedFolders.map((folder) => {
                  const num = folderNumberMap.get(folderKey(folder)) ?? 0
                  const rel = getPersonFolderRelPath(folder)
                  const isIncluded = includedRels.has(rel)
                  const hasShortcut = num >= 1 && num <= 9
                  return (
                    <button
                      key={rel}
                      type="button"
                      style={{
                        ...styles.lightboxFolderBtn,
                        ...(isIncluded ? styles.lightboxFolderBtnIncluded : null),
                      }}
                      onClick={() => void handleLightboxToggleFolder(num)}
                      title={
                        isIncluded
                          ? `${num}. ${folder.name} — 누르면 빼기${hasShortcut ? ` (키 ${num})` : ''}`
                          : `${num}. ${folder.name} — 누르면 추가${hasShortcut ? ` (키 ${num})` : ''}`
                      }
                    >
                      <span style={styles.lightboxFolderNum}>{num}</span>
                      <span style={styles.lightboxFolderName}>
                        {folder.name}
                      </span>
                      {isIncluded && (
                        <span style={styles.lightboxFolderCheck}>✓</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            <div
              style={styles.lightboxBottomBar}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={styles.lightboxInfo}>
                {lightboxName} · {idx}/{total}
                <span style={styles.lightboxKeyHint}>
                  {' '}· 💡 숫자 1~9 = 추가/빼기 토글 · ← → 사진 이동
                </span>
              </div>
              <div style={styles.lightboxControls}>
                <button
                  type="button"
                  style={styles.lightboxButton}
                  onClick={zoomOut}
                  disabled={lightboxZoom <= ZOOM_STEPS[0]}
                  title="축소 (−)"
                >
                  − 축소
                </button>
                <span style={styles.lightboxZoomLabel}>
                  {Math.round(lightboxZoom * 100)}%
                </span>
                <button
                  type="button"
                  style={styles.lightboxButton}
                  onClick={zoomIn}
                  disabled={lightboxZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  title="확대 (+)"
                >
                  + 확대
                </button>
                <button
                  type="button"
                  style={styles.lightboxButton}
                  onClick={() => setLightboxZoom(1)}
                  title="원본 크기 (0)"
                >
                  1:1
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ===== 헬퍼 =====

function folderKey(f: PersonFolder): string {
  return f.parentPath ? `${f.parentPath}/${f.name}` : f.name
}

// ===== 스타일 — 이음 패밀리 다크 네이비 톤 (eum-camp 토큰 기준) =====
//   배경: linear-gradient(135deg, #020818, #0a1628, #0f2040)
//   강조: 골드 (#fcd34d, #C9962B, #fef3c7)
//   텍스트: #f1f5f9 (옅은 회색-흰)

// styles 객체 — Day 7 R1·R2·R3에서 welcome/header/sidebar/폴더 트리/메인 영역·사진 그리드는 NewProjectView.module.css로 이전.
// 잔여 키는 다음 라운드(R4)에서 점진 이전 예정 (menu·modal·lightbox).
const styles: Record<string, React.CSSProperties> = {
  menu: {
    position: 'fixed',
    background: '#0f2040',
    border: '1px solid rgba(252, 211, 77, 0.25)',
    borderRadius: 8,
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.5)',
    padding: 4,
    minWidth: 180,
    zIndex: 1000,
    color: '#f1f5f9',
  },
  menuItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '8px 12px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 14,
    color: '#f1f5f9',
    borderRadius: 4,
  },
  menuItemDanger: { color: '#ff8a8a' },
  menuDivider: {
    height: 1,
    background: 'rgba(252, 211, 77, 0.20)',
    margin: '4px 0',
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.65)',
    zIndex: 1500,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 540,
    background:
      'linear-gradient(150deg, #0a1628 0%, #0f2040 50%, #1a1050 100%)',
    border: '1px solid rgba(252, 211, 77, 0.30)',
    borderRadius: 12,
    padding: '24px 24px 20px',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.6)',
    color: '#f1f5f9',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#fcd34d',
    margin: '0 0 8px',
  },
  modalHint: {
    fontSize: 13,
    color: 'rgba(241, 245, 249, 0.7)',
    margin: '0 0 16px',
    lineHeight: 1.5,
  },
  modalInput: {
    width: '100%',
    fontSize: 16,
    padding: '10px 12px',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    borderRadius: 6,
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#f1f5f9',
    outline: 'none',
    marginBottom: 16,
  },
  modalPreview: {
    background: 'rgba(0, 0, 0, 0.30)',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    minHeight: 80,
  },
  modalPreviewLabel: {
    fontSize: 12,
    color: 'rgba(241, 245, 249, 0.55)',
    marginBottom: 8,
  },
  modalPreviewRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    padding: '4px 0',
    fontFamily: 'monospace',
  },
  modalPreviewOld: {
    color: 'rgba(241, 245, 249, 0.55)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  modalPreviewArrow: {
    color: '#fcd34d',
    flexShrink: 0,
  },
  modalPreviewNew: {
    color: '#fef3c7',
    fontWeight: 600,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  modalButtons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  modalApplyBtn: {
    fontSize: 14,
    padding: '8px 18px',
    background:
      'linear-gradient(135deg, #fcd34d 0%, #C9962B 100%)',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    color: '#0F2540',
    fontWeight: 700,
  },
  modalApplyBtnDisabled: {
    fontSize: 14,
    padding: '8px 18px',
    background: 'rgba(255, 255, 255, 0.08)',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 6,
    cursor: 'not-allowed',
    color: 'rgba(241, 245, 249, 0.4)',
    fontWeight: 700,
  },
  modalLabel: {
    fontSize: 13,
    color: 'rgba(241, 245, 249, 0.7)',
    marginBottom: 8,
    fontWeight: 600,
  },
  modalPresetRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 16,
    alignItems: 'center',
  },
  modalPreset: {
    fontSize: 13,
    padding: '6px 12px',
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: 6,
    cursor: 'pointer',
    color: '#f1f5f9',
    minWidth: 60,
  },
  modalPresetActive: {
    fontSize: 13,
    padding: '6px 12px',
    background: 'rgba(252, 211, 77, 0.20)',
    border: '1px solid #fcd34d',
    borderRadius: 6,
    cursor: 'pointer',
    color: '#fef3c7',
    minWidth: 60,
    fontWeight: 700,
  },
  modalNumberInput: {
    fontSize: 13,
    padding: '6px 10px',
    width: 90,
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: 6,
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#f1f5f9',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  modalUnit: {
    fontSize: 13,
    color: 'rgba(241, 245, 249, 0.55)',
    marginLeft: -2,
  },
  modalRange: {
    width: '100%',
    marginBottom: 16,
    accentColor: '#fcd34d',
  },
  modalProgress: {
    fontSize: 13,
    color: '#fcd34d',
    background: 'rgba(252, 211, 77, 0.10)',
    border: '1px solid rgba(252, 211, 77, 0.30)',
    padding: '8px 12px',
    borderRadius: 6,
    marginBottom: 16,
    textAlign: 'center',
  },
  menuHeader: {
    padding: '8px 12px 6px',
    fontSize: 12,
    color: 'rgba(241, 245, 249, 0.55)',
    borderBottom: '1px solid rgba(252, 211, 77, 0.20)',
    marginBottom: 4,
  },
  lightboxOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.92)',
    zIndex: 2000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxClose: {
    position: 'absolute',
    top: 16,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    fontSize: 20,
    cursor: 'pointer',
    zIndex: 2,
  },
  lightboxNav: {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    width: 56,
    height: 56,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    fontSize: 22,
    cursor: 'pointer',
    zIndex: 2,
  },
  lightboxNavLeft: { left: 24 },
  lightboxNavRight: { right: 24 },
  lightboxNavDisabled: {
    opacity: 0.25,
    cursor: 'not-allowed',
  },
  lightboxImageWrap: {
    maxWidth: '85vw',
    maxHeight: '80vh',
    overflow: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxImage: {
    maxWidth: '85vw',
    maxHeight: '80vh',
    objectFit: 'contain',
    transformOrigin: 'center',
    transition: 'transform 0.12s ease-out',
    userSelect: 'none',
  },
  lightboxBottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '14px 24px',
    background: 'rgba(0,0,0,0.45)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    zIndex: 2,
  },
  lightboxInfo: {
    fontSize: 13,
    color: '#fef3c7',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  lightboxControls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  lightboxButton: {
    padding: '8px 14px',
    fontSize: 14,
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  lightboxZoomLabel: {
    fontSize: 14,
    color: '#fcd34d',
    minWidth: 56,
    textAlign: 'center',
    fontWeight: 600,
  },
  lightboxKeyHint: {
    color: '#fcd34d',
    fontWeight: 500,
  },
  lightboxFolderBar: {
    position: 'absolute',
    bottom: 64,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: 6,
    padding: '8px 12px',
    background: 'rgba(0,0,0,0.65)',
    border: '1px solid rgba(252, 211, 77, 0.25)',
    borderRadius: 12,
    zIndex: 2,
    maxWidth: '92vw',
    overflowX: 'auto',
  },
  lightboxFolderBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.06)',
    border: '2px solid transparent',
    borderRadius: 8,
    color: '#fff',
    cursor: 'pointer',
    minWidth: 64,
    transition: 'background 0.1s, border-color 0.1s',
  },
  lightboxFolderBtnIncluded: {
    background: 'rgba(127, 201, 127, 0.22)',
    borderColor: '#7FC97F',
  },
  lightboxFolderNum: {
    fontSize: 22,
    fontWeight: 700,
    color: '#fcd34d',
    lineHeight: 1,
  },
  lightboxFolderName: {
    fontSize: 11,
    color: '#fef3c7',
    maxWidth: 80,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  lightboxFolderCheck: {
    fontSize: 13,
    color: '#7FC97F',
    fontWeight: 700,
    marginTop: 2,
  },
}
