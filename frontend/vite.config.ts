import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Termální tisk',
        short_name: 'Termální tisk',
        description: 'Tisk obrázků na termální tiskárny + síťová AirPrint/IPP tiskárna',
        lang: 'cs',
        theme_color: '#0e0f14',
        background_color: '#0e0f14',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Never serve the SPA shell for backend API routes.
        navigateFallbackDenylist: [
          /^\/(print|print-test|print-test-all|config|discover|printers|virtual-printers|jobs|health)/,
        ],
      },
    }),
  ],
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
