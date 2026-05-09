import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Electron file:// 환경에서 자산을 상대 경로로 (브라우저 dev에서도 동작 유지)
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
})
