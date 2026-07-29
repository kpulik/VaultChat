// Bundles the test files to plain JS so node's built-in test runner can run them.
// Nothing here imports Obsidian, so no stubbing is needed.
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tests/core.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['node:*'],
  outdir: '.test-build',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});
