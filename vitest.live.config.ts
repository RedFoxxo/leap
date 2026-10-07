import { defineConfig } from 'vitest/config'

// Live tests: real requests against OPENGYM_URL. Never part of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
