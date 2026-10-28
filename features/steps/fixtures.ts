import { baseTest } from '../support/baseTest';

/**
 * The test the Gherkin steps run in: `desktopTest` (session, environment, safety policy, audit, logon guard, clean-up, evidence ...)
 * pointed at the built-in stand-in desktop, so the sample features run on any machine - macOS and Linux included - without SAS.
 *
 * Against the real programs: set `desktopSimulator` to `undefined` (it then follows SAS_DESKTOP_SIMULATOR, default false) and drop
 * `sasSettings`, fill in .env.<ENV> / .env.<ENV>.local as for any other desktop test - and adapt the sample features' values (profile,
 * users, project) to your system: they describe the stand-in. playwright-bdd needs its own `test` underneath; `baseTest` combines it
 * with ours (features/support/baseTest.ts). The scenarios that need other settings - a production environment, the real programs -
 * live in features/production and features/real, each with a `test` of its own.
 */
export const test = baseTest.extend({
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
