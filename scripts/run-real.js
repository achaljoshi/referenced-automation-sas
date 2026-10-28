#!/usr/bin/env node
'use strict';
/**
 * Runs the tests of the REAL SAS programs on purpose: `node scripts/run-real.js @real-conformance`, `@real-smoke` or `@real-sample`.
 *
 * They are skipped in every other run (see tests/support/realOptIn.ts), so `npm test` never opens the real programs or types a login.
 * This launcher sets SAS_REAL_TESTS=true for the one Playwright run it starts - the same on Windows, macOS and Linux (no `set X=1 &&`
 * or `X=1 command` syntax, which differ between shells) - and starts Playwright by its own entry point with an argument array, no shell.
 *
 *   node scripts/run-real.js @real-conformance [more playwright arguments]    the checks that need no login (tests/real/conformance.spec.ts)
 *   node scripts/run-real.js @real-smoke                                      log on, look, leave (features/real/smoke.feature)
 *   node scripts/run-real.js @real-sample                                     the read-only samples (features/real/sample_*.feature)
 *
 * The smoke and sample scenarios are Gherkin: the launcher generates them first (what `bddgen` does) and runs the `bdd-real` project.
 */
const { spawnSync } = require('node:child_process');
const { generateGherkin } = require('./gherkin');

/** The tags the launcher takes, and where each one's tests are: a plain spec folder, or the Gherkin project `bdd-real`. */
const TARGETS = {
  '@real-conformance': { args: ['tests/real'], gherkin: false },
  '@real-smoke': { args: ['--project=bdd-real'], gherkin: true },
  '@real-sample': { args: ['--project=bdd-real'], gherkin: true },
};
const [tag, ...rest] = process.argv.slice(2);
if (!Object.keys(TARGETS).includes(tag)) {
  process.stderr.write(`usage: node scripts/run-real.js ${Object.keys(TARGETS).join(' | ')} [playwright arguments]\n`);
  process.exit(2);
}
const target = TARGETS[tag];
const env = { ...process.env, SAS_REAL_TESTS: 'true' };

if (target.gherkin) {
  const generated = generateGherkin(env);
  if (generated !== 0) process.exit(generated);
}
const playwright = require.resolve('@playwright/test/cli');
const run = spawnSync(process.execPath, [playwright, 'test', ...target.args, '--grep', tag, ...rest], { stdio: 'inherit', env });
if (run.error) {
  process.stderr.write(`could not start Playwright: ${run.error.message}\n`);
  process.exit(1);
}
process.exit(run.status ?? 1);
