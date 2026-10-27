import { desktopExpect as expect, desktopTest as test } from '../../src/fixtures';
import { desktopConfig } from '../../src/desktop';
import { realTestsSkipReason } from '../support/realOptIn';

/**
 * SAMPLE 2 - SAS MANAGEMENT CONSOLE (screens): log on, open a plug-in, read what it lists. READ-ONLY: nothing is created or changed.
 *
 *     npm run test:real-samples
 *
 * Screens are the LAST resort of this repo - use them for tests ABOUT the console. On the real machine the desktop must be unlocked and the
 * Java Access Bridge enabled (`npm run doctor` checks both). Settings - each one is explained in .env.example:
 *   SAS_SMC_PATH, SAS_SMC_PROFILE   which program to start and which connection profile to choose in its dialog
 *   SAS_SMC_USER, SAS_SMC_PASSWORD  (or SAS_USER, SAS_PASSWORD, in .env.<ENV>.local) the login; a rejected one is typed once, never retried
 *   SAS_SAMPLE_SMC_USER             optional: a user the User Manager must list, spelled as it lists it (the stand-in has "sasdemo")
 */
const skipReason = realTestsSkipReason({ realTests: process.env.SAS_REAL_TESTS, simulated: desktopConfig().simulator });
test.skip(skipReason !== undefined, skipReason ?? '');

test.describe('SAMPLE 2 - Management Console @real-sample @sas-desktop @smc-ui', () => {
  test('log on, open the User Manager and read the users @real-sample @sas-desktop @smc-ui', async ({ smc, smcLoggedOn, fakeDesktop, desktopSettings }) => {
    void smcLoggedOn; // asking for it logs the console on, through the logon guard

    await expect(smc.mainWindow).toHaveTitle(/SAS Management Console/);
    // empty to UI Automation = the Java Access Bridge is not enabled (npm run doctor says so)
    await expect(smc.mainWindow.getByRole('Tree')).toExist();

    await smc.openPlugin('User Manager');
    const users = await smc.listUsers();
    expect(users.length, 'the User Manager lists at least one user').toBeGreaterThan(0);

    const wanted = desktopSettings.env.getOptional('SAS_SAMPLE_SMC_USER') ?? (fakeDesktop ? 'sasdemo' : undefined);
    if (wanted !== undefined) expect(await smc.findUser(wanted)).toBe(wanted);
  });
});
