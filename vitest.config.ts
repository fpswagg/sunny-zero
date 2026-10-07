import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { LOG_LEVEL: 'error', SUNNY_DATA_DIR: '/tmp/sunny-test-data', SUNNY_AGENTS_DIR: '/tmp/sunny-test-agents' },
  },
});
