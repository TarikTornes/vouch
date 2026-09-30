import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: Vite serves the UI and proxies /api to the Express server (one origin for the browser).
// Demo/production: `npm start` builds the UI and Express serves it from dist/.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } } },
})
