import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// `base: './'` keeps every asset path relative, so the build works on
// GitHub Pages (served from /<repo>/), Netlify, or any static host.
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered in src/main.tsx so updates apply right away
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Baby Book',
        short_name: 'Baby Book',
        description: 'A cozy, private scrapbook helper. Your photos never leave your device.',
        theme_color: '#f7efe4',
        background_color: '#f7efe4',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The HEIC decoder is a ~3 MB chunk; precache it so HEIC import works offline.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        globIgnores: ['**/*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-*.woff2'],
      },
    }),
  ],
  build: { target: 'es2022' },
  test: { environment: 'node' },
} as any);
