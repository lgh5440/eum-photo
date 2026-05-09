# 이음 포토 — 부채 청산·재출발 전략

작성: 2026-05-09 (Claude, 사용자 의뢰)
관련: [PRODUCT_PLAN.md](./PRODUCT_PLAN.md) (제품 비전 — 변경 없음)

이 문서는 PRODUCT_PLAN.md의 비전을 그대로 두고, 현재 누적된 코드 부채를 청산해 단순한 핵심으로 재출발하기 위한 전략이다. 코드는 손대지 않는다. 사용자가 검토 후 OK 주면 그때 단계적으로 코드 시작.

---

## 1. 왜 재출발인가 (현재 부채 진단)

| 증상 | 원인 | 위치 |
| :--- | :--- | :--- |
| 저장 30초+ 소요 | 매 저장마다 「정리」 폴더 통째 비운 후 사진 N장 다시 씀 (delta 없음) | [App.tsx:2963](../src/App.tsx#L2963) |
| 「하나 바꾸면 다른 데서 꼬임」 | 단일 파일 4833라인, 동기화 대상 6개(메모리 + localStorage 2 + IndexedDB 2 + 디스크 3계층) | App.tsx 전반 |
| 삭제한 폴더 부활 | 디스크 `_정리안.json`이 「작업 저장」 시점에만 갱신 → stale 메타로 부활 | loadFromSavedFolderElectron |
| 「복사」 라벨인데 이동 동작 | mode 매개변수 무시, hideSorted 정책과 충돌 | movePhotosToFolder |

→ 패치 누적은 비효율. 단순 핵심으로 재출발.

---

## 2. 차별 가치 (시장 검증 2026-05-09)

WebSearch로 한국/해외 사진 정리 도구 시장을 점검한 결과:

| 차별 가치 | 시장 빈자리 여부 | 근거 |
| :--- | :--- | :--- |
| ① 단체사진 동의 보호 자동화 (`faceCount ≥ 2`는 강제 복사) | **확정 — 어떤 도구에도 없음** | Excire Foto, digiKam, Tag That Photo, Microsoft Photos 등 모두 일반 사진용 |
| ② Windows + 로컬 + 얼굴 인식 + 한국어 | **확정 — 한국 시장 빈자리** | 한국 검색에서 학교용 「사진 정리 + 얼굴 인식」 데스크탑 제품 0건 |
| ③ 60대 디지털 약자 친화 + 한국 교회학교 워크플로 | **확정** | 디지털교과서·교적관리는 있지만 사진 정리 워크플로 X |

미국 FERPA·COPPA 2025 개정으로 얼굴 인식·학생 이미지 클라우드 업로드 규제 강화 — 한국에도 동일 흐름 예상. **로컬 처리 + 동의 보호 = 법적 정당성 + 시장 빈자리.** 만들 가치 명확.

---

## 3. 새 핵심 데이터 모델 (재출발의 토대)

**원칙: 디스크 = 진실의 출처. 메모리 = 화면 캐시. 메타 = 디스크 사이드카.**

```
EUM-Photo/
├── 원본/                  ← 사진 마스터 (1회 import 후 누적)
│   ├── 사진001.jpg
│   └── ...
├── 정리/                  ← 디스크 폴더 = 인물 폴더 그 자체
│   ├── 보관/
│   │   ├── 김자현/
│   │   │   ├── 사진001.jpg (원본 하드링크 또는 사본)
│   │   │   └── _meta.json   ← 그 폴더 메타 (작은 파일)
│   │   └── 이규홍/
│   └── 공개후보/
│       └── 단체사진_001.jpg
└── _프로젝트.json         ← 행사명·전체 캐시·트리 계층 등 (작은, 자동 갱신)
```

**핵심 변화:**
- 「인물 폴더」 = 디스크 폴더 그 자체. 메모리 추상화 폐기.
- 사진 분류 = 디스크에서 즉시 복사·이동 (delta).
- 모든 변경은 자동으로 디스크에 즉시 반영. 「💾 작업 저장」 버튼 폐지.
- `_프로젝트.json` = 디스크 폴더로 표현 못 하는 정보(태그·캐시·계층) 보존. 메모리 변경 시 즉시 동기화.

---

## 4. 워크플로 재정의 — 3단계로 끝

| 현재 | 새 워크플로 |
| :--- | :--- |
| 폴더 선택 → 작업 폴더 import → 메모리 작업 → 작업 저장 | **① 작업 폴더 한 번 선택** (없으면 만들기) |
| 작업 저장 누르고 30초 기다림 | **② 사진 추가·분류·태그** (모든 변경 즉시 디스크) |
| 새로고침하면 자동 복원·부활 등 위험 | **③ 끝 — 닫고 켜도 그대로** |

**저장 단계 자체가 워크플로에 없음.** 60대 사용자가 「저장 안 했는데 꺼졌어요」 같은 두려움 사라짐.

---

## 5. 기존 자산 — 유지 vs 폐기

### 유지 (그대로 옮김)
- React/Electron/Vite 앱 골격
- 얼굴 인식 코드 (`faceBoxes`·`candidatePhotoIds`·candidate scoring)
- **단체사진 자동 보호 로직** (`faceCount ≥ 2` 강제 복사) — 차별 가치 ①의 핵심
- 한국어 UI 톤·디지털 약자 메시지·CSS·아이콘
- IndexedDB Blob 캐시 (성능용 — 디스크 read 가속)
- 학생 명단 CSV import + 매칭 + 동의 컬럼 처리
- 정리안 CSV/JSON export 형식 (이름은 `_프로젝트.json`으로 통일)

### 폐기 (부채 청산)
- 메모리 `personFolders` ↔ 디스크 폴더 트리 이중 모델
- localStorage `eum-photo:autosave:v1` 의존
- localStorage `eum-photo:folders-tree:v1` 의존
- 「💾 작업 저장」 버튼 + `emptyDirectory` + 통째 다시 쓰기
- `isAlias` 모델 (단순 핵심에선 디스크 복사 = 진짜 사본, 추상화 불필요)
- `hideSorted`·`folderDrillIn`·`activeFolderId` 다중 정책 변수 → 단일 「현재 폴더」 상태로 통합

---

## 6. 단계별 로드맵 (3주, 매주 검증 가능)

### 1주차 — 새 데이터 모델 + 폴더 화면
- [ ] 새 디스크 IPC API: `listFolders`, `createFolder`, `renameFolder`, `deleteFolder`, `movePhoto`, `copyPhoto`
- [ ] 디스크 폴더 트리를 화면에 직접 표시 (메모리 캐시 1초 TTL)
- [ ] `_프로젝트.json` 자동 갱신 함수 (300ms 디바운스)
- [ ] **체크포인트**: 폴더 생성·삭제·이름 변경이 즉시 디스크와 화면에 반영. 「작업 저장」 버튼 없이 동작.

### 2주차 — 사진 분류 + 차별 가치 통합
- [ ] 사진 import → `EUM-Photo/원본/`에 즉시 저장
- [ ] 우클릭 「📂 「OOO」로 보내기」 → 디스크 즉시 복사 (단순화: 기본 복사. 「이동」은 별도 상태 변경)
- [ ] 단체사진 보호 = 디스크 복사 시 자동 분기 (faceCount ≥ 2면 메인에 그대로)
- [ ] 얼굴 인식 결과 `_프로젝트.json`에 캐시
- [ ] **체크포인트**: 100장 import → 분류 → 닫고 다시 열기 → 그대로 보임. 저장 대기 X.

### 3주차 — UX 마감 + 베타
- [ ] 첫 진입 30초 안에 차별 가치 체감되는 안내 (단체 보호 배지·로컬 표시 등)
- [ ] 학생 명단 CSV·매칭·동의 워크플로 통합
- [ ] 「💾 작업 저장」 흔적 완전 제거
- [ ] 데이터 마이그레이션 (기존 사용자가 있으면 한 번 변환) — 사용자 본인 1명만이라 수동 가능
- [ ] **체크포인트**: 60대 사용자 테스트 (사용자 본인) → 「폴더 만들고 사진 분류, 끝」 흐름이 30분 안에 익숙해지는가.

---

## 7. 능력 한계 — 포기하는 부분 (정직하게)

다음은 **구현하지 않습니다** (이번 재출발 범위 밖):

| 포기 항목 | 이유 |
| :--- | :--- |
| Windows 파일 탐색기(`explorer.exe`) 자체 임베드 | OS 보안·Electron 한계로 사실상 불가능. 자체 재현은 가능하나 비용 1~2주 추가 — 먼저 단순 화면으로 검증 후 결정 |
| 파일 탐색기 → 앱 양방향 라이브 동기 (`fs.watch`) | race·rename 추적 등 검증 비용 큼. 사용자가 파일 탐색기에서 직접 폴더 조작하는 시나리오는 드물어 우선순위 낮음 |
| 100% 트랜잭션 무결성 (디스크 쓰기 도중 전원 차단 시 일관성 보장) | 데스크탑 단일 사용자 환경 + 자동 백업으로 충분. 분산 시스템 수준 보장은 과도 |
| Google Drive 자동 동기 (PRODUCT_PLAN의 3단계) | 1~2주 재출발 범위 밖. 코어 안정 후 별도 |
| iOS/Android 모바일 동기 | 범위 밖. PWA 1단계로 만족 |

**일정 추정 정확도**: 1~2주 추정은 통상 추정. ±30% 오차 가능. 매주 체크포인트로 조정.

---

## 8. 검증 — 매주 사용자가 확인할 것

- 1주차 끝: 폴더 만들고 지우기 5번 반복. 디스크에서도 즉시 사라지는가? 30초 이상 대기 없는가?
- 2주차 끝: 사진 100장 추가 → 분류 → 닫고 다시 열기. 그대로 보이는가? 단체사진은 메인에서 안 빠지는가?
- 3주차 끝: 학생 명단 CSV → 동의 표시 → 공개 후보 검토. 30분 안에 흐름이 익숙해지는가?

각 체크포인트에서 막히면 그 자리에서 멈추고 진단·조정. 다음 주 진입 X.

---

## 9. 다음 행동

이 문서를 사용자가 검토하고 **OK 주시면** 1주차 작업 시작:
1. 새 디스크 IPC API (electron/main.mjs 보강)
2. `_프로젝트.json` 자동 갱신 함수
3. 폴더 화면 새로 (기존 React 컴포넌트 일부 재사용)

기존 코드는 **그대로 둠** — 새 빌드가 사용자 검증 통과한 후에 갈아끼움. 그동안 사용자는 현재 버전 계속 사용 가능.

문서 검토 후 다음 중 하나 알려주시면 됩니다:
- **「OK 시작해」** → 1주차 작업 시작
- **「조정」** → 어떤 부분을 어떻게 조정할지 말씀해 주시면 문서만 수정
- **「다른 방향」** → 재출발 X, 현재 코드 패치 계속 (덜 추천)

---

## Appendix — 시장 검증 검색 결과 (2026-05-09)

### 한국 검색
- [얼굴 인식 출석관리 시스템](https://patents.google.com/patent/KR101710200B1/ko) — 출결 시스템 (사진 정리 X)
- [온맘교적](http://num.onmam.com/) — 교회학교 학생 관리 (사진 정리 X)
- [아이스크림미디어](https://i-screammedia.com/front/boardlist.do?cmsDirPkid=31&cmsLocalPkid=0) — 디지털교과서 (사진 정리 X)
- [함께학교](https://www.togetherschool.go.kr/) — 교사·학부모 소통 (사진 정리 X)
→ **한국 시장에 「학교/교회학교 교사 + 학생 사진 정리 + 얼굴 인식」 데스크탑 도구 0건.**

### 해외 검색
- [Photo Organizer with Face Recognition Respecting Privacy (CYME)](https://cyme.io/en/blog/photo-organizer-with-face-recognition-respecting-privacy/)
- [Best Photo Organizer Software for Windows PCs (PhotoWorkout 2026)](https://www.photoworkout.com/best-software-organize-photos-windows/)
- [FERPA School Photos: What Districts Must Know (2026)](https://capturely.com/ferpa-school-photography/)
- [Facial-Recognition-Photo-Organiser (GitHub)](https://github.com/revoconner/Facial-Recognition-Photo-Organiser)
- [Top 14 Photo Managers with Face Recognition in 2026](https://tonfotos.com/articles/best-face-recognition-software/)
- [Tag That Photo](https://tagthatphoto.com/)
→ Excire Foto·digiKam 등 강력한 도구 다수. 단 **「학교 교사 워크플로 + 단체사진 동의 보호 자동화」를 갖춘 제품 0건.**
