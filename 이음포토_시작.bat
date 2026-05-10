@echo off
REM 이음 포토 데스크탑 — 새 빌드(dist) 모드로 실행
REM 매번 검증할 때 이 파일 더블클릭

cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "EUM_FORCE_DIST=1"
start "" "node_modules\electron\dist\electron.exe" .
