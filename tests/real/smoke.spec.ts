import { desktopExpect as expect, desktopTest as test } from '../../src';

/**
 * SMOKE tests of the REAL programs: log on, look, leave. They only READ (no project is run, nothing is created), so they are allowed in
 * any nonprod environment - and in production when SAS_ALLOW_PROD_READS=true. They need the logins (SAS_SMC_USER / SAS_SMC_PASSWORD,
 * SAS_EG_USER / SAS_EG_PASSWORD, or SAS_USER / SAS_PASSWORD in .env.<ENV>.local) and the program settings of .env.example (SAS_SMC_PATH,
 * SAS_SMC_PROFILE, SAS_EG_PATH, SAS_EG_PROFILE).
 *
 * Log on by hand with exactly these values first: a wrong password counts towards the account's lock limit. A rejected logon is never
 * repeated, and the logon guard refuses the same login for SAS_LOGON_FAILURE_COOLDOWN_MIN minutes.
 *
 * NOT VERIFIED on a real desktop. `SAS_DESKTOP_SIMULATOR=true npm run test:real-smoke` runs the same tests against the stand-in desktop so the
 * tests themselves cannot rot unnoticed; where no desktop can be reached they are SKIPPED with the reason.
 */
test.describe('real-program smoke @sas-desktop @real-smoke', () => {
  test('Management Console: log on, see the navigation tree, open the User Manager @real-smoke @smc-ui', async ({ smc, smcLoggedOn }) => {
    void smcLoggedOn; // asking for it logs the console on, through the logon guard
    await expect(smc.mainWindow.getByRole('Tree')).toExist(); // empty to UI Automation = the Java Access Bridge is not enabled (npm run doctor)
    await smc.openPlugin('User Manager');
    expect((await smc.listUsers()).length, 'the User Manager lists at least one user').toBeGreaterThan(0);
  });

  test('Enterprise Guide: connect and see the main window @real-smoke @eg-ui', async ({ eg, egLoggedOn }) => {
    void egLoggedOn;
    await expect(eg.mainWindow).toHaveTitle(/SAS Enterprise Guide/);
    await expect(eg.mainWindow.getByName(/^Connected to/)).toExist();
  });

  test('Enterprise Guide by COM: the object model answers @real-smoke @eg-com', async ({ egCom }) => {
    expect(await egCom.version()).not.toBe('');
  });
});
