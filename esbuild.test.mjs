// Bundles the test files to plain JS so node's built-in test runner can run them.
// Nothing here imports Obsidian, so no stubbing is needed.
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: [
    'tests/core.test.ts',
    'tests/endpoints.test.ts',
    'tests/messageTree.test.ts',
    'tests/context.test.ts',
    'tests/vault.test.ts',
    'tests/links.test.ts',
    'tests/diagnose.test.ts',
    'tests/agent.test.ts',
    'tests/plan.test.ts',
    'tests/analysis.test.ts',
    'tests/presets.test.ts',
    'tests/import.test.ts',
    'tests/settings.test.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['node:*'],
  outdir: '.test-build',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});
