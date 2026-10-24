import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/**/*.test.ts'] },
});
