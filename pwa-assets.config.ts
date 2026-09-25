import { defineConfig } from '@vite-pwa/assets-generator/config';

// `npm run icons` regenerates the PNG and ICO icons in public/ from public/logo.svg. Keep the
// file names: the deployment's Cloudflare Access lets the manifest and icons through without a
// login, which is what makes installing the app work.
//
// The source is already a full-bleed tile, so no variant may add padding or a background: the
// generator's defaults (a transparent margin, and 30% white padding for the maskable and Apple
// icons) framed the tile in white on Android and iOS.
const background = '#0b0e13';

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']], padding: 0 },
    maskable: { sizes: [512], padding: 0, resizeOptions: { background } },
    apple: { sizes: [180], padding: 0, resizeOptions: { background } },
  },
  images: ['public/logo.svg'],
});
