import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content scripts are classic scripts: bundle into one self-contained IIFE.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode !== 'development',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'ShadowingStudioContent',
      fileName: () => 'content.js',
    },
  },
}));
