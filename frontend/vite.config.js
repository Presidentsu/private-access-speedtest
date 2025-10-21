import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/caps': 'http://localhost:3000',
      '/download': 'http://localhost:3000',
      '/upload': 'http://localhost:3000',
      '/ws-echo': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/metrics': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
})
