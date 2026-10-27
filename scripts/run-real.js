#!/usr/bin/env node
'use strict';
/**
 * Runs the tests of the REAL SAS programs on purpose: `node scripts/run-real.js @real-conformance`, `@real-smoke` or `@real-sample`.
 *
 * They are skipped in every other run (see tests/support/realOptIn.ts), so `npm test` never opens the real programs or types a login.
 * This launcher sets SAS_REAL_TESTS=true for the one Playwright run it starts - the same on Windows, macOS and Linux (no `set X=1 &&`
 * or `X=1 command` syntax, which differ between shells) - and starts Playwright by its own entry point with an argument array, no shell.
 *
 *   node scripts/run-real.js @real-conformance [more playwright arguments]
 *   node scripts/run-real.js @real-smoke
 *   node scripts/run-real.js @real-sample     the read-only samples (tests/real/sample_*.spec.ts)
 */
const { spawnSync } = require('node:child_process');

const TAGS = ['@real-conformance', '@real-smoke', '@real-sample'];
const [tag, ...rest] = process.argv.slice(2);
if (!TAGS.includes(tag)) {
  process.stderr.write(`usage: node scripts/run-real.js ${TAGS.join(' | ')} [playwright arguments]\n`);
  process.exit(2);
}
const playwright = require.resolve('@playwright/test/cli');
const run = spawnSync(process.execPath, [playwright, 'test', 'tests/real', '--grep', tag, ...rest], {
  stdio: 'inherit',
  env: { ...process.env, SAS_REAL_TESTS: 'true' },
});
if (run.error) {
  process.stderr.write(`could not start Playwright: ${run.error.message}\n`);
  process.exit(1);
}
process.exit(run.status ?? 1);
