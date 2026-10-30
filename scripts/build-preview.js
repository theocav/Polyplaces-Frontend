#!/usr/bin/env node
/**
 * build-preview.js
 * Bundles the in-browser 3D preview (src/preview) into assets/js/preview/.
 * The worker is built first and its content hash is baked into the main
 * bundle's worker URL, since /assets/* is served immutable.
 *
 * Usage:  node scripts/build-preview.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets/js/preview');

const common = {
  bundle: true,
  minify: true,
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'warning',
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const workerFile = path.join(OUT, 'preview-worker.js');
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'src/preview/worker.js')],
    format: 'iife',
    outfile: workerFile,
  });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(workerFile)).digest('hex').slice(0, 8);

  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'src/preview/index.js')],
    format: 'esm',
    outfile: path.join(OUT, 'preview.js'),
    define: { __PREVIEW_WORKER_URL__: JSON.stringify(`/assets/js/preview/preview-worker.js?v=${hash}`) },
  });

  for (const f of ['preview.js', 'preview-worker.js']) {
    const kb = (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
    console.log(`  built  assets/js/preview/${f}  ${kb} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
