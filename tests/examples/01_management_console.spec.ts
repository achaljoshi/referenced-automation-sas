import { expect, test } from './support/exampleTest';

/**
 * EXAMPLE 1 - SAS Management Console: log on, open the User Manager, find a user. Read it top to bottom, then copy the parts you need.
 *
 *     npm run try:simulator -- 01_
 *
 * SAS Management Console is a Java Swing program. Its screens are the LAST resort of this framework (a command line or a metadata call
 * is faster and does not need a window): use this layer for tests ABOUT the console - is it usable, does the User Manager list who it
 * should - and keep those tests few. On a real machine the Java Access Bridge must be enabled (`jabswitch -enable`, then restart the
 * console), and the desktop must be unlocked: `npm run doctor` checks both.
 *
 * The settings the example relies on - every one is explained in .env.example (what it is for, valid values, default, where to find it):
 *   SAS_DESKTOP_SIMULATOR   true = run on the built-in stand-in desktop (what `npm run try:simulator` sets; this file also forces it)
 *   SAS_SMC_PATH            the full path of sasmc.exe: with it the fixture LAUNCHES the console (SAS_APP_MODE=launch / auto)
 *   SAS_APP_MODE            launch | attach | auto: attach = use a console that is already open and never close it
 *   SAS_SMC_PROFILE         the metadata profile chosen in the console's connection dialog, spelled as the dialog lists it
 *   SAS_SMC_USER, SAS_SMC_PASSWORD  (or SAS_USER, SAS_PASSWORD)  the login; the password is a secret: .env.<ENV>.local only
 *   SAS_LOGON_FAILURE_COOLDOWN_MIN  after a rejected logon the same login is not typed again for this long (protects the account)
 *   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  which declared SAS environment this run works against (dev, qa ...) and where they are declared
 *   SAS_DESKTOP_TIMEOUT_MS  how long any one step waits for its control (30 s by default)
 *   SAS_EVIDENCE            what the report gets automatically (a screenshot and the step journal on failure by default)
 */

/** What this flow looks for: change a value here and every step that uses it follows. These describe the stand-in. */
const CONSTANTS = {
  plugin: 'User Manager',
  user: 'sasdemo',
  missingUser: 'Nobody Atall',
  group: 'SAS Administrators',
  title: /SAS Management Console/,
};

test.describe('EXAMPLE 1 - SAS Management Console', () => {
  test('log on, open the User Manager and find a user @sas-desktop @smc-ui @example', async ({ smc, smcLoggedOn }) => {
    // ---- 1. smcLoggedOn: the console is open AND logged on. The fixture launched it (SAS_SMC_PATH), chose the profile (SAS_SMC_PROFILE),
    //         typed the login (SAS_SMC_USER / SAS_SMC_PASSWORD, else SAS_USER / SAS_PASSWORD) through the logon guard, and waited for the
    //         navigation tree. `smc` is the wrapper around that same console: asking for both gives you the console's methods.
    await expect(smc.mainWindow).toHaveTitle(CONSTANTS.title); // an assertion that retries until it holds (5 s by default; { timeout } changes it)
    await expect(smc.mainWindow.getByRole('Tree')).toExist(); // the navigation tree on the left: its presence means "connected"

    // ---- 2. openPlugin: selects the plug-in in the navigation tree (expanding the node it sits under) and waits until it is selected.
    //         Nothing here sleeps: every step waits for its control, up to SAS_DESKTOP_TIMEOUT_MS.
    await smc.openPlugin(CONSTANTS.plugin);

    // ---- 3. findUser / listUsers: read the User Manager's list. Best effort and NOT VERIFIED on the real console; where a metadata call
    //         or batch tool (src/process) can answer "does this user exist?", prefer it.
    expect(await smc.findUser(CONSTANTS.user)).toBe(CONSTANTS.user);
    expect(await smc.findUser(CONSTANTS.missingUser)).toBeUndefined();
    expect(await smc.listUsers()).toContain(CONSTANTS.user);
    expect(await smc.listGroups()).toContain(CONSTANTS.group);

    // ---- 4. Your own locators: a control is found the way a person finds it - by role and name - from its window. A name that matches two
    //         controls is an error that lists both (say .first() / .nth(i) on purpose), never a silent pick.
    await expect(smc.mainWindow.getByRole('TabItem', { name: 'Users' })).toExist();

    // ---- 5. Evidence: a screenshot that goes into the test report (`npx playwright show-report`). SAS_EVIDENCE decides what is taken on its
    //         own (a failing test gets one; `on` adds one after every test, `steps` after every step that may change something).
    await smcLoggedOn.evidence('user manager');
  });

  test('a control that is not on the screen fails with what IS on the screen @sas-desktop @smc-ui @example', async ({ smc, smcLoggedOn }) => {
    void smcLoggedOn; // asking for it logs the console on
    await smc.openPlugin(CONSTANTS.plugin);
    // The text below does not exist on this screen, on purpose. The assertion fails and says what is there - window title, controls with
    // their names and ids, the closest matches - so the test can be repaired without opening SAS.
    const failure = await expect(smc.mainWindow.getByName('Add User')).toExist({ timeout: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure, 'the missing control must fail the assertion').toBeDefined();
    expect(failure?.message).toContain('On the screen now'); // + the controls, and "Closest to ..." for a near-miss such as "Add Users"
  });

  test('without the logon fixture the console waits at its connection dialog @sas-desktop @smc-ui @example', async ({ smcApp }) => {
    // ---- smcApp / smc: launched but NOT logged on - what a test about the logon dialogs itself starts from. Nothing was typed, so
    //      nothing can have been rejected.
    await expect(smcApp.window(/Connection Profile/i)).toExist();
  });
});
