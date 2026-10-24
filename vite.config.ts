import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // pipeline.test and roadGraph.test both rebuild public/tiles; running files in parallel races on that folder.
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false },
});
