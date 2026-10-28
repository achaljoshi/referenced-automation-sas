'use strict';
/**
 * Generates the Gherkin tests (what `npx bddgen` does) for the scripts that start Playwright themselves - run-real.js and
 * try-simulator.js - without a shell, so it works the same in PowerShell, cmd and sh. playwright-bdd does not export its CLI entry
 * point, so the path comes from its own package.json.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** Runs bddgen; returns the exit code (0 = generated). */
function generateGherkin(env = process.env) {
  const root = path.dirname(require.resolve('playwright-bdd/package.json'));
  const bddgen = path.join(root, require(path.join(root, 'package.json')).bin.bddgen);
  const run = spawnSync(process.execPath, [bddgen], { stdio: 'inherit', env });
  if (run.error) {
    process.stderr.write(`could not generate the Gherkin tests (bddgen): ${run.error.message}\n`);
    return 1;
  }
  if (run.status !== 0) process.stderr.write(`could not generate the Gherkin tests (bddgen): exit code ${run.status}\n`);
  return run.status ?? 1;
}

module.exports = { generateGherkin };
