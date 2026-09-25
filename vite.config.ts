/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { syncDevServer } from './server/vitePlugin.ts';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // `npm run dev` also serves the sync and market-data APIs (same origin, like the production
    // server). The server side reads all of .env (e.g. the Alpaca key); the app only VITE_*.
    syncDevServer(loadEnv(mode, process.cwd(), '')),
    VitePWA({
      // 'prompt', not 'autoUpdate': an automatic reload could interrupt a drawing session.
      registerType: 'prompt',
      injectRegister: false,
      // Behind Cloudflare Access (or any cookie-protected proxy) the manifest must be fetched
      // with credentials; the default anonymous request is redirected to the login page and
      // installing the app fails.
      useCredentials: true,
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Draw-a-Chart',
        short_name: 'Draw-a-Chart',
        description: 'Stylus-first charting for Wyckoff study: the pen draws, fingers navigate.',
        theme_color: '#0b0e13',
        background_color: '#0b0e13',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only. Market data and sync traffic are never cached by the service worker.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    // Expose on the LAN so a physical iPad / Samsung tablet can reach the dev server.
    host: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // React + Lightweight Charts in one chunk, precached by the service worker.
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
}));
