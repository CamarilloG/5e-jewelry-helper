import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['docs/审阅证据/1.0.2/scan-analysis.test.ts'],
    testTimeout: 30_000,
    environment: 'node',
    pool: 'forks',
  },
});
