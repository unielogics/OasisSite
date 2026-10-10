import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.resolve(dir, 'src') } },
  test: {
    testTimeout: 30_000,
    exclude: [
      '**/node_modules/**',
      'dist/**',
      'dist-*/**',
      '.generated/**',
      'design/**',
      'parity-reports/**',
    ],
  },
})
