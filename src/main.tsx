import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import NewProjectView from './NewProjectView.tsx'

// refactor/clean-restart 브랜치 — Electron 환경에서는 새 화면, 브라우저는 기존 App.
// 단계 4 main 머지 시점에 App.tsx 정리 + NewProjectView를 단일 진입점으로.
const isElectron = typeof window !== 'undefined' && !!window.eum?.isElectron

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isElectron ? <NewProjectView /> : <App />}
  </StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
