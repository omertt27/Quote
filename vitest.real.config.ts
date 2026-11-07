import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/real/**/*.test.ts'],
    testTimeout: 300000,
    pool: 'forks',
  },
});
