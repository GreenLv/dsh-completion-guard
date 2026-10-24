import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // See tests/setup/clean-startup-argv.ts: runs before test files import src,
    // so the audited-cohort suites observe the clean DSH-host startup condition.
    setupFiles: ['tests/setup/clean-startup-argv.ts'],
  },
})
