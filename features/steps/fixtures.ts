import { mergeTests } from '@playwright/test';
import { test as bddTest } from 'playwright-bdd';
import { desktopTest } from '../../src/fixtures';

/**
 * The test the Gherkin steps run in: `desktopTest` (session, environment, safety policy, audit, logon guard, clean-up, evidence ...)
 * pointed at the built-in stand-in desktop, so the sample features run on any machine - macOS and Linux included - without SAS.
 *
 * Against the real programs: set `desktopSimulator` to `undefined` (it then follows SAS_DESKTOP_SIMULATOR, default false) and drop
 * `sasSettings`, fill in .env.<ENV> / .env.<ENV>.local as for any other desktop test - and adapt the sample features' values (profile,
 * users, project) to your system: they describe the stand-in. playwright-bdd needs its own `test` underneath; mergeTests combines it
 * with ours.
 */
export const test = mergeTests(bddTest, desktopTest).extend({
  desktopSimulator: [
    async ({}, use) => {
      await use(true);
    },
    { scope: 'worker' },
  ],
  // The logon-failure marker and the list of created objects of the sample features live under test-results, which Playwright empties
  // at the start of every run: a rejected logon of one run can then never stop the next run (the real default is .sas-state).
  sasSettings: [
    async ({}, use) => {
      await use({ SAS_STATE_DIR: 'test-results/sas-state-bdd' });
    },
    { scope: 'worker' },
  ],
});
