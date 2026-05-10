# 이음 포토 (E:UM Photo)

평범한 교사를 위한 **사진 정리 도구**. 사진을 인물 폴더로 자유롭게 분류하고, **100% 로컬**에서 처리합니다 (인터넷·클라우드 X).

## 다운로드

👉 [최신 릴리스](https://github.com/lgh5440/eum-photo/releases/latest)에서 `EUM Photo Setup x.y.z.exe` 다운로드

## 누구에게 좋은가

- 매주/매월 행사 사진을 인물별로 정리해야 하는 **교사·교회학교 봉사자**
- 학생 사진을 외부 클라우드에 올리지 않고 본인 PC에만 두고 싶은 분
- 60대 이상 / 컴퓨터 익숙치 않은 분도 사용 가능 (큰 버튼·한국어 메시지·키보드 접근성)

## 주요 기능 (v0.0.1)

- 작업 폴더 한 번 정해두면 **영구 사용** (재시작 시 자동 복원)
- 인물 폴더: 만들기·이름변경·삭제·drill-in
- 사진 다중 선택 (Ctrl·Shift·빈 영역 드래그 박스)
- 사진을 폴더로 드래그 분류 — **원본 + 모든 사본 보존**
- 사진 이름 변경·영구 삭제
- 라이트박스 (사진 크게 보기, ←/→ 이동, 1:1 줌, 폴더 분류)

## 차별 가치

1. **단체사진 동의 보호** — 분류해도 원본은 그대로. 어느 폴더에서 사진을 빼도 다른 폴더 영향 없음. *(얼굴 인식 자동 보호는 다음 버전)*
2. **로컬 + 비공개** — 인터넷·클라우드 안 씀. 사진은 본인 PC만.
3. **60대 친화** — 큰 버튼, 한국어 메시지, focus-visible 키보드 접근성, 14px+ 폰트.

## 설치 (Windows)

1. [Releases](https://github.com/lgh5440/eum-photo/releases/latest)에서 `EUM Photo Setup x.y.z.exe` 다운로드
2. 더블클릭 → 「자세히 → 실행」 (SmartScreen 경고는 코드 사이닝 미적용 알파라 정상)
3. 시작 메뉴 「이음 포토」 클릭

## 디스크 구조

작업 폴더 안에 자동으로 다음 구조가 만들어집니다:

```text
<작업 폴더>/EUM-Photo/
  ├── 원본/                  ← 사진 마스터
  ├── 정리/<인물>/            ← 인물 폴더 사본
  └── _프로젝트.json          ← 메타데이터
```

원본·사본 모두 그냥 일반 파일이라, 앱이 없어도 Windows 탐색기로 그대로 사용할 수 있습니다.

## 시스템 요구사항

- Windows 10 / 11 (64비트)
- 디스크 200MB+ (앱 자체. 사진은 별도)

## 알려진 한계 (정직히)

- 단체사진 **자동 인식** 미구현 (수동 분류로 대신)
- 학생 명단 CSV + 동의 매칭 미구현 (다음 버전)
- 자동 업데이트 미구현 (수동 다운로드)
- macOS / Linux 미지원 (Windows 전용)

## 개발 (개발자용)

```bash
git clone https://github.com/lgh5440/eum-photo.git
cd eum-photo
npm install
npm run dev:electron
```

설치 인스톨러 빌드:

```bash
npm run build:electron
# release/ 폴더에 EUM Photo Setup x.y.z.exe 생성
```

### 기술 스택

- **Electron** 36 (CJS main process)
- **React** 19 + **TypeScript** 6
- **Vite** 8 (HMR + production build)
- **electron-builder** (NSIS 인스톨러)
- 디스크 데이터 모델 + IPC 통신 (메모리·DB 추상화 없음, 디스크가 진실의 출처)

## 기여

이슈·제안은 [Issues](https://github.com/lgh5440/eum-photo/issues).

## 라이선스

TBD (알파 단계 — 정식 출시 시 결정)

---

*만든이*: HOME ([@lgh5440](https://github.com/lgh5440))
