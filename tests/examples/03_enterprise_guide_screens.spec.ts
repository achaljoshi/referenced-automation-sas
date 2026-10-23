import { expect, test } from './support/exampleTest';
import { sampleProgramName, sampleProjectPath } from '../../src/fixtures';

/**
 * EXAMPLE 3 - SAS Enterprise Guide's own screens: connect, open a project, run a program, read the results. The SECOND way to drive
 * Enterprise Guide (example 2, COM, is the first): use it only for tests ABOUT Enterprise Guide's screens, and keep them few. They
 * are slower, break when a screen changes and need an unlocked interactive desktop.
 *
 *     npm run try:simulator -- 03_
 *
 * The settings the example relies on - every one is explained in .env.example:
 *   SAS_DESKTOP_SIMULATOR   true = the built-in stand-in desktop with a fake Enterprise Guide window (this file forces it)
 *   SAS_EG_PATH             the full path of SEGuide.exe: with it the fixture LAUNCHES Enterprise Guide (SAS_APP_MODE=launch / auto)
 *   SAS_APP_MODE            launch | attach | auto
 *   SAS_EG_PROFILE          the server profile chosen in the connect dialog, spelled as the dialog lists it
 *   SAS_EG_USER, SAS_EG_PASSWORD  (or SAS_USER, SAS_PASSWORD)  the login; the password is a secret: .env.<ENV>.local only
 *   SAS_LOGON_FAILURE_COOLDOWN_MIN  a rejected logon is never repeated within this many minutes (protects the account)
 *   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  the declared SAS environment: running a program is an UPDATE, allowed only in a nonprod one
 *   SAS_ALLOW_OUTSIDE_NAMESPACE (+ _REASON)  see example 2: the program below is named with the run's namespace for that reason
 *   SAS_DESKTOP_TIMEOUT_MS  how long any one step waits; a long program needs the `timeoutMs` option of runProgram as well
 *   SAS_DESKTOP_EVIDENCE    `steps` adds a screenshot after every step that may change something (SAS_EVIDENCE=steps does the same)
 */

test.describe('EXAMPLE 3 - Enterprise Guide screens', () => {
  test('connect, open a project, run a program and read the results @sas-desktop @eg-ui @example', async ({ eg, egLoggedOn, runContext }) => {
    // ---- 1. egLoggedOn: Enterprise Guide is open AND connected. The fixture launched it (SAS_EG_PATH), clicked Connect, chose the profile
    //         (SAS_EG_PROFILE), typed the login (SAS_EG_USER / SAS_EG_PASSWORD, else SAS_USER / SAS_PASSWORD) through the logon guard, and
    //         waited for "Connected to <profile>". A wrong password is typed ONCE: the guard then refuses the same login for a while.
    await expect(eg.mainWindow).toHaveTitle(/SAS Enterprise Guide/);
    await expect(eg.mainWindow.getByName(/^Connected to/)).toExist();

    // ---- 2. openProject: Ctrl+O, the file name, Open - then waits until the main window carries the project's name.
    await eg.openProject(sampleProjectPath(runContext));
    await expect(eg.mainWindow).toHaveTitle(/Sales/);

    // ---- 3. runProgram: selects the program, presses Run and waits until it is no longer running (Stop is disabled). It is an UPDATE: the
    //         program name is judged by the safety policy, so it carries the run's namespace (see example 2 for why).
    const program = sampleProgramName(runContext, 'Summary');
    const run = await eg.runProgram(program);

    // ---- 4. The results: the log and results text the screens show, and a count of ERROR / WARNING lines.
    expect(run.errors).toBe(0);
    expect(run.warnings).toBe(1);
    expect(run.log).toContain('PROCEDURE MEANS');
    expect(await eg.readLog()).toBe(run.log);

    // ---- 5. Dialogs: say once what to do about one that may appear in front of any step, instead of `if (dialog exists)` everywhere.
    egLoggedOn.onDialog(/Tip of the Day/i, (dialog) => dialog.getByRole('Button', { name: 'Close' }).click(), { name: 'tip of the day' });

    // ---- 6. Evidence for the report.
    await egLoggedOn.evidence(`${program} done`);
  });

  test('without the logon fixture Enterprise Guide waits to be connected @sas-desktop @eg-ui @example', async ({ egApp, eg }) => {
    await expect(egApp.window(/SAS Enterprise Guide/)).toExist();
    await expect(eg.mainWindow.getByName('Connect')).toBeEnabled(); // nothing was typed: nothing could have been rejected
  });
});
