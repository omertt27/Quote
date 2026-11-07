import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/real/**'],
    testTimeout: 15000,
    pool: 'forks',
  },
});
