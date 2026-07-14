import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  // O .env fica na raiz do monorepo (VITE_GOOGLE_CLIENT_ID vem de lá).
  envDir: resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@datahub/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
    },
  },
})
