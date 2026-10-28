import { desktopConfig } from '../../../src/desktop';
import { canRunDesktop } from '../../../src/fixtures';
import { realTestsSkipReason } from '../../../tests/support/realOptIn';
import { baseTest } from '../../support/baseTest';

/**
 * The test of the scenarios for a machine with SAS (features/real): the REAL programs, or the stand-in when SAS_DESKTOP_SIMULATOR=true.
 * There are no worker options here on purpose - the settings come from .env.<ENV> / .env.<ENV>.local like any other real run.
 *
 * OPT-IN. These scenarios log on to the real Management Console and Enterprise Guide, so every one of them is SKIPPED, with the reason,
 * unless the run asked for them (`npm run test:real-samples`, `test:real-smoke` set SAS_REAL_TESTS=true) or runs on the stand-in
 * (SAS_DESKTOP_SIMULATOR=true: how the pipeline keeps them honest). The guard is an AUTOMATIC fixture of the project's own `test`, so a
 * feature file added to this folder cannot forget it; tests/optInForRealTests.spec.ts checks it is still here (tests/support/realOptIn.ts
 * is the rule). It is also what the desktop gate waits for, so the reason shown is the opt-in even where no desktop can be reached.
 */
// Playwright's types do not offer `auto` for a fixture that is overridden, but the override of `desktopGate` must stay automatic.
const AUTOMATIC = { auto: true } as unknown as { scope: 'test' };

export const test = baseTest.extend<{ realOptIn: void }>({
  realOptIn: [
    async ({}, use, testInfo) => {
      const skipReason = realTestsSkipReason({ realTests: process.env.SAS_REAL_TESTS, simulated: desktopConfig().simulator });
      testInfo.skip(skipReason !== undefined, skipReason ?? '');
      await use();
    },
    { auto: true },
  ],

  // The same gate as `desktopTest`'s, after the opt-in - and lifted for a scenario tagged @sas-cli (and not @sas-desktop): the command
  // line needs no desktop, so it runs on Windows, macOS and Linux, as `sasTest` does.
  desktopGate: [
    async ({ realOptIn, $tags, desktopSettings }, use, testInfo) => {
      void realOptIn;
      if ($tags.includes('@sas-cli') && !$tags.includes('@sas-desktop')) return use();
      const can = canRunDesktop(desktopSettings);
      testInfo.skip(!can.ok, can.ok ? undefined : can.reason);
      await use();
    },
    AUTOMATIC,
  ],
});
