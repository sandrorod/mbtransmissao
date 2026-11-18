import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// CSP só no build final: em desenvolvimento o recarregamento do Vite precisa de script inline.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // estudio-midia: fotos e vídeos da área Mídias (servidos pelo próprio app, só da pasta dele).
  "img-src 'self' data: blob: estudio-midia: https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com",
  "media-src 'self' blob: mediastream: estudio-midia:",
  "connect-src 'self' estudio-midia:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function injectCsp(): Plugin {
  return {
    name: 'estudio-inject-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/main/index.ts') } } } },
  preload: { build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload/index.ts') } } } },
  renderer: {
    root: __dirname,
    plugins: [react(), injectCsp()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'index.html') } } },
  },
});
