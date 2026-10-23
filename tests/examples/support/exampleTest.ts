import { desktopExpect, desktopTest } from '../../../src/fixtures';

/**
 * The `test` and `expect` the worked examples import.
 *
 * `desktopTest` is the framework's own test (see src/fixtures/index.ts). The two worker options below point the examples at the built-in
 * stand-in desktop so they run on ANY machine - macOS and Linux included - with no SAS and no Windows (`npm run try:simulator`):
 *
 *   desktopSimulator   the same as SAS_DESKTOP_SIMULATOR=true
 *   sasSettings        settings laid over the .env files for these examples only. SAS_STATE_DIR is where the logon-failure marker and the
 *                      list of created objects go; under test-results it is emptied at the start of every run (the real default is
 *                      .sas-state), so a rejected logon in one run can never stop the next run of the examples.
 *
 * To run an example against the REAL programs: delete the `desktopSimulator` override (it then follows SAS_DESKTOP_SIMULATOR, default
 * false) and the `sasSettings` one, fill in .env.<ENV> and .env.<ENV>.local (see .env.example, "FIRST THINGS TO FILL IN"), and change the
 * CONSTANTS at the top of the example to names that exist in your SAS system - they describe the stand-in.
 */
export const test = desktopTest.extend({
  desktopSimulator: [
    async ({}, use) => {
      await use(true);
    },
    { scope: 'worker' },
  ],
  sasSettings: [
    async ({}, use) => {
      await use({ SAS_STATE_DIR: 'test-results/sas-state-examples' });
    },
    { scope: 'worker' },
  ],
});

/** Playwright's `expect` plus the desktop assertions (toExist, toBeEnabled, toHaveText, toContainText, toHaveTitle ...), all of which wait and retry. */
export const expect = desktopExpect;
