import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'app-icon.svg'],
      manifest: {
        name: 'CuriousKids AI',
        short_name: 'Leo',
        description: 'A voice-first educational companion for curious kids aged 4-6',
        theme_color: '#7C3AED',
        background_color: '#F4F1FF',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        // SVG icons keep the app zero-asset and fully offline-installable in
        // modern Chromium browsers. sizes:"any" + maskable covers install + splash.
        icons: [
          {
            src: 'app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml'
          },
          {
            src: 'app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // StaleWhileRevalidate for shell assets
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // NetworkOnly for API requests
            urlPattern: /\/api\/.*/i,
            handler: 'NetworkOnly'
          },
          {
            // StaleWhileRevalidate for app shell
            urlPattern: /\.(js|css|html)$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'app-shell-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 7 // 1 week
              }
            }
          }
        ]
      }
    })
  ]
})
