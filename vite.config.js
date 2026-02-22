import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon_111.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'shot-about.png', 'shot-tpn.png', 'shot-gir.png', 'logo-light.png', 'logo-dark.png', 'logo-light-c.png', 'logo-dark-c.png', 'icon-tpn.png', 'icon-gir.png', 'icon-nut.png'],
      manifest: {
        name: 'NeoNEST - Neonatal Essential Support Tools',
        short_name: 'NeoNEST',
        description: 'NICU digitalization suite — 30 sec TPN, GIR Calculator, Nutrition Audit',
        id: '/?source=pwa',
        theme_color: '#0077cc',
        background_color: '#f0f2f5',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        // ADD THE SCREENSHOTS ARRAY HERE
        screenshots: [
          {
            src: 'shot-about.png',
            sizes: '596x807',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'About NeoNEST'
          },
          {
            src: 'shot-tpn.png',
            sizes: '600x1059',
            type: 'image/png',
            form_factor: 'narrow',
            label: '30 secTPN Calculator'
          },
          {
            src: 'shot-gir.png',
            sizes: '596x1067',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'GIR Calculator'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts-cache', expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } }
          }
        ]
      }
    })
  ]
})
