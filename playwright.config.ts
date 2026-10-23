import { createPlaywrightConfig, loadEnv } from '@automation/referenced-automation-utils';
import { defineBddConfig } from 'playwright-bdd';
import { initRunContext } from './src/core';
import { desktopWorkerPlan } from './src/fixtures/parallelism';

// Every repo in the family runs Playwright the same way, defined once in utils - see createPlaywrightConfig's doc comment for every
// env var it reads (BROWSER, HEADLESS, WORKERS, RETRIES, TEST_TIMEOUT_MS ... all optional). This repo has no browser tests: the
// browser is only started by a test that asks for `page`.

// One run = one id. The id names the test namespace (AUTO_<id>_...), the audit file and the evidence folder; it is exported as
// SAS_RUN_ID so every Playwright worker of this run shares it. An id already in SAS_RUN_ID (a CI pipeline number) is kept.
initRunContext();

// Gherkin features: `bddgen` turns features/*.feature + features/steps/*.ts into runnable tests in .features-gen/ (the npm scripts run
// it first). They are their own project, so `--project=bdd` runs only them. They run against the built-in stand-in desktop.
const bddTestDir = defineBddConfig({
  features: 'features/*.feature',
  steps: 'features/steps/*.ts',
  outputDir: '.features-gen',
});

// ---- Parallelism: the SAS programs are driven through ONE desktop ----
// Where a real desktop can be reached (Windows or SAS_DESKTOP_TRANSPORT=remote, and SAS_DESKTOP_SIMULATOR is not on) the run gets one
// worker and no fully-parallel files, whatever WORKERS says: two workers would type into the same windows. With the stand-in desktop
// every worker has its own and parallelism is honoured. The `desktopHost` fixture independently refuses a real desktop with more than
// one worker, so `--workers=4` on the command line fails loudly instead of corrupting a run.
// (The npm scripts that only use the stand-in - test:bdd, try:simulator - pass --workers themselves.)
const plan = desktopWorkerPlan(loadEnv({ dir: __dirname }));
if (plan.ignored && process.env.TEST_WORKER_INDEX === undefined) console.warn(plan.ignored);

export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-sas',
  testTimeoutMs: 60_000,
  overrides: plan.oneWorker ? { workers: 1, fullyParallel: false } : {},
  extraProjects: [{ name: 'bdd', testDir: bddTestDir }],
});
