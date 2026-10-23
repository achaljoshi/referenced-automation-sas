import { expect, test } from './support/exampleTest';
import { sampleProgramName, sampleProjectPath } from '../../src/fixtures';

/**
 * EXAMPLE 2 - SAS Enterprise Guide by COM: open a project, run it, read the log, export the results. THIS is the first way to drive
 * Enterprise Guide: no window is clicked, no desktop has to be visible, and it is faster and steadier than the screens (example 3).
 *
 *     npm run try:simulator -- 02_
 *
 * The settings the example relies on - every one is explained in .env.example:
 *   SAS_DESKTOP_SIMULATOR   true = the built-in stand-in desktop with a fake Enterprise Guide object model (this file forces it)
 *   SAS_EG_PROGID           the exact COM class, e.g. SASEGObjectModel.Application.8.3 (the number is your Enterprise Guide's version;
 *                           without it the newest registered class is found by itself)
 *   SAS_EG_PROFILE          the server profile Enterprise Guide runs the project against (as its connection dialog lists it)
 *   SAS_COM_PROGIDS         the COM classes the bridge may create at all (allow-list; SASEGObjectModel.Application.* by default)
 *   SAS_DESKTOP_POWERSHELL  a 32-bit Enterprise Guide needs the 32-bit PowerShell, or its COM class is "not registered"
 *   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  the declared SAS environment: running a project is an UPDATE, allowed only in a nonprod one
 *   SAS_ALLOW_OUTSIDE_NAMESPACE (+ _REASON)  lets a run change objects that are not named AUTO_<runId>_...: see the project name below
 *   SAS_CLEANUP_FAILURE     what a clean-up that could not remove something does to its test: fail (default) or warn
 *   SAS_EVIDENCE            what the report gets automatically on failure
 */

const CONSTANTS = {
  /** `C:\Projects\AUTO_<runId>_Sales.egp`. The project is named with the run's NAMESPACE because running it is an update and the safety
   *  policy lets a run change only objects named with its own. Your real project already has its own name: either name test projects
   *  AUTO_<runId>_..., or deliberately run an existing one with SAS_ALLOW_OUTSIDE_NAMESPACE=true and a SAS_ALLOW_OUTSIDE_NAMESPACE_REASON
   *  (the reason goes to the audit log). Example 4 shows what happens without. */
  program: 'Program',
  summary: 'Summary',
  expectedInLog: 'observations read',
};

test.describe('EXAMPLE 2 - Enterprise Guide by COM', () => {
  test('open a project, run it, read the log and export the results @sas-desktop @eg-com @example', async ({ egCom, runContext, cleanup, fakeDesktop }) => {
    // ---- 1. egCom: the fixture created the Enterprise Guide application object (SAS_EG_PROGID, else discovered) and activated the profile
    //         (SAS_EG_PROFILE). Nothing was clicked. Enterprise Guide runs in the background.
    expect(await egCom.version()).not.toBe('');

    // ---- 2. openProject: reading the project is a 'read'; nothing runs yet. The name is the file name.
    const project = sampleProjectPath(runContext);
    expect(await egCom.openProject(project)).toBe(`${runContext.ns('Sales')}.egp`);
    expect((await egCom.listItems()).map((item) => `${item.kind}:${item.name}`)).toEqual([
      'processFlow:Main Flow',
      `program:${sampleProgramName(runContext, 'Program')}`,
      `program:${sampleProgramName(runContext, 'Summary')}`,
    ]);

    // ---- 3. runProject: SAS code runs on the profile's server - an UPDATE, so the safety policy judges it once, as a whole: the
    //         environment must be nonprod and the project inside this run's namespace. The result is one status per program, taken from
    //         the object model's own member where there is one, else from the ERROR / WARNING lines of the log.
    const statuses = await egCom.runProject();
    const byName = new Map(statuses.map((s) => [s.name, s]));
    expect(byName.get(sampleProgramName(runContext, 'Program'))).toMatchObject({ status: 'Succeeded', errors: 0, warnings: 0 });
    expect(byName.get(sampleProgramName(runContext, 'Summary'))).toMatchObject({ status: 'Warning', errors: 0, warnings: 1 });

    // ---- 4. programLog: what the program wrote to the SAS log. Assert on what matters to you, not on the whole text.
    expect(await egCom.programLog(sampleProgramName(runContext, 'Program'))).toContain(CONSTANTS.expectedInLog);

    // ---- 5. exportResults: saves every result of a program into a folder. It CREATES files, so the folder must be inside the namespace
    //         too (run.ns('export') = AUTO_<runId>_export). Register what you create the moment you create it: `cleanup` undoes it after
    //         the test, pass or fail, newest first. (Against a real machine the undo would remove the folder with fs.rmSync.)
    const folder = `C:\\Exports\\${runContext.ns('export')}`;
    const written = await egCom.exportResults({ program: sampleProgramName(runContext, 'Summary'), folder });
    cleanup.register({
      type: 'folder',
      name: folder,
      undo: () => {
        for (const file of written) fakeDesktop?.eg.com.files.delete(file);
      },
    });
    expect(written).toEqual([`${folder}\\Summary.html`, `${folder}\\Summary.pdf`]);
    expect([...(fakeDesktop?.eg.com.files.keys() ?? [])]).toEqual(expect.arrayContaining(written));

    // ---- 6. saveProject / the fixture's teardown: the fixture quits Enterprise Guide and releases every COM object, even when the test failed.
    await egCom.saveProject();
  });

  test('one process flow can be run on its own @sas-desktop @eg-com @example', async ({ egCom, runContext }) => {
    await egCom.openProject(sampleProjectPath(runContext));
    await egCom.runProcessFlow('Main Flow'); // the target the policy judges is "<project> / Main Flow": inside the namespace through the project
    expect((await egCom.programStatus(sampleProgramName(runContext, 'Summary'))).status).toBe('Warning');
  });
});
