import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Serves and emits three's Basis transcoder at /basis/, matching the installed three version (KTX2Loader). */
function basisTranscoder(): Plugin {
  const dir = join(dirname(createRequire(import.meta.url).resolve('three')), '../examples/jsm/libs/basis');
  const files = ['basis_transcoder.js', 'basis_transcoder.wasm'];
  return {
    name: 'basis-transcoder',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/\/basis\/([\w.]+)$/)?.[1];
        if (!name || !files.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(dir, name)));
      });
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: 'asset', fileName: `basis/${f}`, source: readFileSync(join(dir, f)) });
    },
  };
}

export default defineConfig({
  plugins: [basisTranscoder()],
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // pipeline.test and roadGraph.test both rebuild public/tiles; running files in parallel races on that folder.
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false },
});
