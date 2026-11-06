/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Extension pages + service worker. Pages and the (module) worker may share chunks.
// The content script cannot be an ES module, so it is built separately (vite.content.config.ts).
export default defineConfig(({ mode }) => ({
  root: 'src',
  publicDir: resolve(import.meta.dirname, 'public'),
  base: '',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode !== 'development',
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'src/sidepanel/index.html'),
        permission: resolve(import.meta.dirname, 'src/permission/index.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
