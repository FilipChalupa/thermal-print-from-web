import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'sw',
      filename: 'sw.ts',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
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
        // Share an image from the phone straight into the print form.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            files: [{ name: 'images', accept: ['image/*'] }],
          },
        },
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
      '/queue': 'http://localhost:3000',
      '/drawer': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})
