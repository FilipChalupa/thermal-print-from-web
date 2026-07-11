import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/print': 'http://localhost:3000',
      '/print-test': 'http://localhost:3000',
      '/print-test-all': 'http://localhost:3000',
      '/config': 'http://localhost:3000',
      '/discover': 'http://localhost:3000',
      '/printers': 'http://localhost:3000',
      '/jobs': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})
