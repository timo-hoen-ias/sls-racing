import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // pipeline and roadGraph tests both rebuild public/tiles, so test files must not run in parallel.
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false },
});
