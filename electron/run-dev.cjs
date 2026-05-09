// dev 모드 Electron 시작 wrapper.
// 사용자 시스템에 ELECTRON_RUN_AS_NODE=1이 영구 설정된 환경 우회 — Electron이 Node 모드로 빠지는 걸 차단.
// require('electron')은 ELECTRON_RUN_AS_NODE=1이면 빈 객체 반환하므로,
// 환경 변수 삭제 후 child process로 electron CLI 실행.

delete process.env.ELECTRON_RUN_AS_NODE

const path = require('node:path')
const { spawn } = require('node:child_process')

const isWindows = process.platform === 'win32'
const electronBin = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  isWindows ? 'electron.cmd' : 'electron',
)

const proc = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: { ...process.env },  // ELECTRON_RUN_AS_NODE 이미 삭제된 환경 상속
  shell: isWindows,
  cwd: path.join(__dirname, '..'),
})

proc.on('exit', (code) => process.exit(code ?? 0))
proc.on('error', (err) => {
  console.error('electron 실행 실패:', err.message)
  process.exit(1)
})
