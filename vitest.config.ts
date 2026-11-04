import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/helpers/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    // Unit tests call process.chdir, which worker threads don't support.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
