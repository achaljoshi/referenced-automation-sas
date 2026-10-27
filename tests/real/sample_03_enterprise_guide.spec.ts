import { desktopExpect as expect, desktopTest as test, sampleProjectPath } from '../../src/fixtures';
import { desktopConfig } from '../../src/desktop';
import { realTestsSkipReason } from '../support/realOptIn';

/**
 * SAMPLE 3 - SAS ENTERPRISE GUIDE: the automation object model (COM, the first choice) and its screens. READ-ONLY: it opens a project and
 * lists what is in it; it does not run it, save it or change it. (Running a project is an update: see tests/examples/02 and the safety rules.)
 *
 *     npm run test:real-samples
 *
 * Settings - each one is explained in .env.example:
 *   SAS_EG_PATH, SAS_EG_PROFILE     which program to start and which server profile to activate (the screens)
 *   SAS_EG_PROGID, SAS_COM_PROGIDS  which COM class to create and which classes are allowed at all (`npm run doctor` lists what is registered)
 *   SAS_EG_USER, SAS_EG_PASSWORD    (or SAS_USER, SAS_PASSWORD) the login for the screens
 *   SAS_SAMPLE_EG_PROJECT           the full path of an existing .egp to open and list (the stand-in has its own)
 */
const skipReason = realTestsSkipReason({ realTests: process.env.SAS_REAL_TESTS, simulated: desktopConfig().simulator });
test.skip(skipReason !== undefined, skipReason ?? '');

test.describe('SAMPLE 3 - Enterprise Guide @real-sample @sas-desktop @eg-com @eg-ui', () => {
  test('by COM: the object model answers with its version @real-sample @sas-desktop @eg-com', async ({ egCom }) => {
    expect(await egCom.version()).not.toBe('');
  });

  test('by COM: open a project and list its process flows and programs @real-sample @sas-desktop @eg-com', async ({ egCom, fakeDesktop, runContext, desktopSettings }) => {
    const project = desktopSettings.env.getOptional('SAS_SAMPLE_EG_PROJECT') ?? (fakeDesktop ? sampleProjectPath(runContext) : undefined);
    test.skip(project === undefined, 'set SAS_SAMPLE_EG_PROJECT to the full path of an existing project (for example C:\\Projects\\Sales.egp)');
    const name = await egCom.openProject(project as string); // opening is a READ for the policy: nothing changes
    expect(name).toMatch(/\.egp$/i);
    const items = await egCom.listItems();
    expect(items.length, 'the project has at least one process flow or program').toBeGreaterThan(0);
    await egCom.closeProject();
  });

  test('by screens: connect and see the main window @real-sample @sas-desktop @eg-ui', async ({ eg, egLoggedOn }) => {
    void egLoggedOn;
    await expect(eg.mainWindow).toHaveTitle(/SAS Enterprise Guide/);
    await expect(eg.mainWindow.getByName(/^Connected to/)).toExist();
  });
});
