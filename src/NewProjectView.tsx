// 이음 포토 v2 — 새 화면 (refactor/clean-restart)
//
// 디스크 = 진실의 출처. 모든 변경은 즉시 디스크 + 메타 디바운스 동기화.
// 「💾 작업 저장」 버튼 없음. 작업 폴더 한 번 정하면 이후 자동.
//
// 단계 2 Day 4: 작업 폴더 선택 + 폴더 트리 + 폴더 만들기·삭제·이름변경.
// 사진 추가·표시·분류는 Day 5~6.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addPhotos,
  createPersonFolder,
  deletePersonFolder,
  getOriginalDir,
  getPersonFolderRelPath,
  joinPath,
  loadProject,
  movePhotoToFolder,
  renamePersonFolder,
  type PersonFolder,
  type ProjectMeta,
} from './lib/diskStore'

// 사진 카드 → 폴더 드래그 시 dataTransfer type. 외부 파일 드롭과 구분.
// 값 = JSON 배열(string[]) — 다중 선택 시 여러 fileName 한꺼번에.
const DRAG_TYPE_FILENAMES = 'application/x-eum-photo-filenames'

type Screen = 'no-folder' | 'loading' | 'ready'
type FolderContextMenu = { folder: PersonFolder; x: number; y: number }

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
  // (이전 버전: contextmenu close가 새 메뉴를 즉시 닫는 이중 처리 버그 있었음)
  useEffect(() => {
    if (!folderMenu) return
    const close = () => setFolderMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [folderMenu])

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
    if (!drillInFolder) return all
    const rel = getPersonFolderRelPath(drillInFolder)
    return all.filter((n) => meta.photos[n].personFolderPaths.includes(rel))
  }, [meta, drillInFolder])

  // ===== Rubber band 영역 선택 (파일 탐색기 처럼) =====
  // 빈 영역에서 mousedown → 사각형 → 그 안 사진 선택. Shift/Ctrl이면 기존 선택 유지.
  const handleMainMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0) return  // 좌클릭만
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
    [selectedFileNames],
  )

  // ===== 키보드 단축키 (Ctrl+A 전체 / Esc 해제) =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return  // 입력 중이면 무시
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelectedFileNames(new Set(visiblePhotoNames))
      } else if (e.key === 'Escape') {
        if (selectedFileNames.size > 0) {
          setSelectedFileNames(new Set())
          lastSelectedRef.current = null
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visiblePhotoNames, selectedFileNames])

  // ===== 화면 =====

  if (screen === 'no-folder') {
    return (
      <div style={styles.fullScreen}>
        <div style={styles.welcomeCard}>
          <h1 style={styles.welcomeTitle}>이음 포토</h1>
          <p style={styles.welcomeText}>
            행사 사진을 학생별로 정리하는 데스크탑 도구예요.
          </p>
          <p style={styles.welcomeHint}>
            먼저 사진을 모을 작업 폴더를 한 번 정해 주세요.<br />
            폴더 안에 「EUM-Photo」가 자동으로 만들어져요.
          </p>
          <button type="button" style={styles.bigButton} onClick={handlePickFolder}>
            📂 작업 폴더 선택
          </button>
        </div>
      </div>
    )
  }

  if (screen === 'loading') {
    return (
      <div style={styles.fullScreen}>
        <div style={styles.welcomeCard}>
          <p style={styles.welcomeText}>{statusMessage}</p>
        </div>
      </div>
    )
  }

  if (!meta) return null

  const sortedFolders = [...meta.personFolders].sort((a, b) =>
    a.name.localeCompare(b.name, 'ko'),
  )

  // 정렬 순서대로 1~N 번호 부여. key = folder rel path (= folderKey).
  // 폴더 추가/삭제/이름변경 시 번호 자동 재할당. UI는 번호로만 표시 → 더미 라벨 가독성↑.
  const folderNumberMap = new Map<string, number>()
  sortedFolders.forEach((f, i) => folderNumberMap.set(folderKey(f), i + 1))

  return (
    <div style={styles.app}>
      {/* 상단 바 */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.appTitle}>이음 포토</h1>
          <span style={styles.workFolder} title={statusMessage}>
            {statusMessage}
          </span>
        </div>
        <div style={styles.headerRight}>
          <button
            type="button"
            style={styles.smallButton}
            onClick={() => {
              if (window.eum?.isElectron && meta.rootPath) {
                void window.eum.openInExplorer(meta.rootPath)
              }
            }}
          >
            📂 탐색기 열기
          </button>
          <button type="button" style={styles.smallButtonDanger} onClick={handlePickFolder}>
            🔄 다른 폴더로
          </button>
        </div>
      </header>

      <div style={styles.body}>
        {/* 좌측 — 폴더 트리 */}
        <aside style={styles.sidebar}>
          <div style={styles.sidebarSection}>
            <h2 style={styles.sidebarTitle}>📁 인물 폴더</h2>

            {/* 폴더 만들기 */}
            <div style={styles.newFolderRow}>
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
                style={styles.newFolderInput}
              />
              <button type="button" style={styles.newFolderButton} onClick={() => void handleCreateFolder()}>
                + 만들기
              </button>
            </div>

            {/* 폴더 트리 — 단순 평면 리스트 (인물 폴더 = 정리/<인물>) */}
            {sortedFolders.length === 0 ? (
              <p style={styles.emptyHint}>
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
                      style={{
                        ...styles.folderRow,
                        ...(isActive ? styles.folderRowActive : null),
                        ...(isDrillIn ? styles.folderRowDrillIn : null),
                        ...(isDropTarget ? styles.folderRowDropTarget : null),
                      }}
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
                      <span style={styles.folderIcon}>📁</span>
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
                          style={styles.renameInput}
                        />
                      ) : (
                        <span style={styles.folderName}>
                          <span style={styles.folderNumber}>
                            {folderNumberMap.get(key)}.
                          </span>{' '}
                          {folder.name}
                        </span>
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
          style={styles.mainArea}
          onDragOver={blockExternalDrop}
          onDrop={blockExternalDrop}
          onMouseDown={handleMainMouseDown}
        >
          <div style={styles.mainHeader}>
            <div style={styles.mainHeaderLeft}>
              <h2 style={styles.mainHeaderTitle}>
                {drillInFolder ? `📁 ${drillInFolder.name}` : '📷 모든 사진'}
              </h2>
              <span style={styles.mainHeaderCount}>
                {visiblePhotoNames.length}장
                {selectedFileNames.size > 0 && (
                  <span style={styles.selectedCount}>
                    {' '}
                    · 선택 {selectedFileNames.size}장
                  </span>
                )}
              </span>
              {drillInFolder && (
                <button
                  type="button"
                  style={styles.smallButton}
                  onClick={() => changeDrillIn(null)}
                >
                  ← 전체 보기
                </button>
              )}
              {selectedFileNames.size > 0 && (
                <button
                  type="button"
                  style={styles.smallButton}
                  onClick={() => setSelectedFileNames(new Set())}
                >
                  선택 해제
                </button>
              )}
            </div>
            <div style={styles.mainHeaderRight}>
              <button
                type="button"
                style={styles.bigAddButton}
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
              style={{
                ...styles.rubberBand,
                left: rubberBand.x,
                top: rubberBand.y,
                width: rubberBand.w,
                height: rubberBand.h,
              }}
            />
          )}

          {visiblePhotoNames.length === 0 ? (
            <div style={styles.emptyDropZone}>
              <p style={styles.emptyDropTitle}>
                {drillInFolder
                  ? `「${drillInFolder.name}」 폴더에 아직 사진이 없어요`
                  : '아직 사진이 없어요'}
              </p>
              <p style={styles.emptyDropHint}>
                {drillInFolder ? (
                  <>
                    「← 전체 보기」로 돌아가서 사진을 「{drillInFolder.name}」 폴더로<br />
                    끌어다 놓으면 이 폴더로 보내져요.
                  </>
                ) : (
                  <>
                    위 「+ 사진 추가」 버튼을 눌러 사진을 불러오세요.
                  </>
                )}
              </p>
            </div>
          ) : (
            <div style={styles.grid}>
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
                    style={{
                      ...styles.photoCard,
                      ...(isSelected ? styles.photoCardSelected : null),
                    }}
                    draggable
                    onClick={handlePhotoClick(name, visiblePhotoNames)}
                    onDragStart={handlePhotoDragStart(name)}
                    title={
                      folderEntries.length > 0
                        ? `${folderEntries.length}개 폴더에 들어있음: ${tooltipNames}`
                        : '클릭 = 선택 · Ctrl/Shift+클릭 = 다중 선택 · 끌어서 좌측 인물 폴더로'
                    }
                  >
                    <div style={styles.photoThumbWrap}>
                      {url ? (
                        <img
                          src={url}
                          alt={name}
                          style={styles.photoImg}
                          draggable={false}
                        />
                      ) : (
                        <div style={styles.photoLoading}>로드 중…</div>
                      )}
                      {isSelected && (
                        <div style={styles.selectedBadge}>✓</div>
                      )}
                    </div>
                    <span style={styles.photoCaption} title={name}>
                      {name}
                    </span>
                    {folderEntries.length > 0 && (
                      <div style={styles.folderTagsList}>
                        {folderEntries.map((entry, i) => (
                          <span
                            key={i}
                            style={styles.folderTag}
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
    </div>
  )
}

// ===== 헬퍼 =====

function folderKey(f: PersonFolder): string {
  return f.parentPath ? `${f.parentPath}/${f.name}` : f.name
}

// ===== 스타일 (인라인 — 단계 3에서 CSS 분리) =====

const styles: Record<string, React.CSSProperties> = {
  fullScreen: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#FFF8EC',
    fontFamily: '"Pretendard", "맑은 고딕", system-ui, sans-serif',
  },
  welcomeCard: {
    maxWidth: 520,
    padding: '48px 40px',
    background: '#fff',
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
    textAlign: 'center',
  },
  welcomeTitle: {
    fontSize: 32,
    margin: '0 0 16px',
    color: '#5C3A1E',
  },
  welcomeText: {
    fontSize: 18,
    color: '#333',
    margin: '0 0 12px',
  },
  welcomeHint: {
    fontSize: 15,
    color: '#666',
    lineHeight: 1.6,
    margin: '0 0 32px',
  },
  bigButton: {
    fontSize: 20,
    padding: '16px 40px',
    background: '#FFB84D',
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer',
    color: '#3C2510',
    fontWeight: 600,
  },
  app: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#FFF8EC',
    fontFamily: '"Pretendard", "맑은 고딕", system-ui, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    background: '#fff',
    borderBottom: '1px solid #EAD8B7',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 16 },
  appTitle: { fontSize: 20, margin: 0, color: '#5C3A1E' },
  workFolder: {
    fontSize: 14,
    color: '#666',
    maxWidth: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerRight: { display: 'flex', gap: 8 },
  smallButton: {
    fontSize: 14,
    padding: '8px 14px',
    background: '#F5E5C7',
    border: '1px solid #D9C29A',
    borderRadius: 8,
    cursor: 'pointer',
    color: '#5C3A1E',
  },
  smallButtonDanger: {
    fontSize: 14,
    padding: '8px 14px',
    background: '#fff',
    border: '1px solid #D9C29A',
    borderRadius: 8,
    cursor: 'pointer',
    color: '#A05A3A',
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 280,
    minWidth: 280,
    background: '#FCF1DD',
    borderRight: '1px solid #EAD8B7',
    overflowY: 'auto',
  },
  sidebarSection: { padding: 16 },
  sidebarTitle: { fontSize: 16, margin: '0 0 12px', color: '#5C3A1E' },
  newFolderRow: { display: 'flex', gap: 6, marginBottom: 16 },
  newFolderInput: {
    flex: 1,
    fontSize: 14,
    padding: '8px 10px',
    border: '1px solid #D9C29A',
    borderRadius: 6,
    background: '#fff',
  },
  newFolderButton: {
    fontSize: 14,
    padding: '8px 12px',
    background: '#FFB84D',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    color: '#3C2510',
    fontWeight: 600,
  },
  emptyHint: {
    fontSize: 13,
    color: '#888',
    lineHeight: 1.6,
    padding: '16px 8px',
    background: '#fff',
    borderRadius: 8,
    border: '1px dashed #D9C29A',
  },
  statusGroup: { marginBottom: 12 },
  statusGroupLabel: {
    fontSize: 12,
    color: '#999',
    margin: '4px 0 4px 4px',
  },
  folderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: 14,
  },
  folderRowActive: { background: '#FFE7B0' },
  folderRowDrillIn: { background: '#FFB84D', color: '#3C2510', fontWeight: 600 },
  folderRowDropTarget: {
    background: '#7FC97F',
    color: '#1F3A1F',
    fontWeight: 600,
    outline: '2px solid #4FA64F',
    outlineOffset: -2,
  },
  folderIcon: { fontSize: 16 },
  folderName: { flex: 1 },
  folderNumber: { color: '#A05A3A', fontWeight: 600 },
  renameInput: {
    flex: 1,
    fontSize: 14,
    padding: '4px 6px',
    border: '1px solid #FFB84D',
    borderRadius: 4,
    background: '#fff',
    outline: 'none',
  },
  mainArea: {
    flex: 1,
    padding: 24,
    overflowY: 'auto',
    position: 'relative',
  },
  mainHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 12,
    flexWrap: 'wrap',
  },
  mainHeaderLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  mainHeaderRight: { display: 'flex', alignItems: 'center', gap: 8 },
  mainHeaderTitle: { fontSize: 18, color: '#5C3A1E', margin: 0 },
  mainHeaderCount: { fontSize: 14, color: '#888' },
  bigAddButton: {
    fontSize: 16,
    padding: '10px 20px',
    background: '#FFB84D',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    color: '#3C2510',
    fontWeight: 600,
  },
  emptyDropZone: {
    border: '2px dashed #D9C29A',
    borderRadius: 12,
    padding: 48,
    textAlign: 'center',
    background: '#fff',
  },
  emptyDropTitle: { fontSize: 18, color: '#5C3A1E', margin: '0 0 12px' },
  emptyDropHint: { fontSize: 14, color: '#888', lineHeight: 1.6, margin: 0 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 12,
  },
  photoCard: {
    background: '#fff',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid #EAD8B7',
    display: 'flex',
    flexDirection: 'column',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'box-shadow 0.1s, border-color 0.1s',
  },
  photoCardSelected: {
    border: '2px solid #FFB84D',
    boxShadow: '0 0 0 3px rgba(255, 184, 77, 0.32)',
  },
  photoThumbWrap: {
    width: '100%',
    aspectRatio: '1 / 1',
    background: '#FCF1DD',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  photoImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  photoLoading: {
    fontSize: 13,
    color: '#999',
  },
  photoCaption: {
    fontSize: 12,
    color: '#666',
    padding: '6px 8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  folderTagsList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    padding: '0 8px 8px',
  },
  folderTag: {
    fontSize: 11,
    background: '#FFE7B0',
    color: '#5C3A1E',
    padding: '2px 6px',
    borderRadius: 4,
    border: '1px solid #EAD8B7',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  selectedBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    background: '#FFB84D',
    color: '#3C2510',
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 14,
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
    pointerEvents: 'none',
  },
  selectedCount: {
    color: '#A05A3A',
    fontWeight: 600,
  },
  rubberBand: {
    position: 'absolute',
    border: '1px dashed #FFB84D',
    background: 'rgba(255, 184, 77, 0.12)',
    pointerEvents: 'none',
    zIndex: 5,
  },
  menu: {
    position: 'fixed',
    background: '#fff',
    border: '1px solid #D9C29A',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    padding: 4,
    minWidth: 180,
    zIndex: 1000,
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
    color: '#3C2510',
    borderRadius: 4,
  },
  menuItemDanger: { color: '#C73E3E' },
}
