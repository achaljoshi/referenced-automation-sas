import { desktopTest as test, desktopExpect as expect } from '../recorder/support/desktopTest';
import { loadEnv } from '@automation/referenced-automation-utils';
import type { DesktopApp, DesktopLocator, WindowLocator } from '../../src/desktop';

const env = loadEnv();

/** What the recording typed, chose and expected, and the dialogs it dismissed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */
const CONSTANTS = {
  inputs: {
    get profilesListItem() {
      return env.get('SAS_SMC_PROFILE');
    },
    get userIdField() {
      return env.get('SAS_USER');
    },
    get passwordField() {
      return env.get('SAS_PASSWORD');
    },
    navigationTreeItem: 'User Manager',
    nameField: 'AUTO_demo_user',
    displayNameField: 'AUTO demo user',
  },
  expected: {
    autoDemoUserText: 'AUTO_demo_user',
  },
};

/** Every window and control the recording used, named once. When a screen changes, fix the locator here and every step follows. */
const LOCATORS = {
  connectionProfileWindow: (app: DesktopApp): WindowLocator => app.window(/^Connection Profile$/i),
  profilesList: (app: DesktopApp): DesktopLocator => LOCATORS.connectionProfileWindow(app).getByRole('List', { name: 'Profiles' }),
  okButton: (app: DesktopApp): DesktopLocator => LOCATORS.connectionProfileWindow(app).getByRole('Button', { name: 'OK' }),
  logOnWindow: (app: DesktopApp): WindowLocator => app.window(/^Log On$/i),
  userIdField: (app: DesktopApp): DesktopLocator => LOCATORS.logOnWindow(app).getByAutomationId('userIdField').orElse(LOCATORS.logOnWindow(app).getByRole('Edit', { name: 'User ID:' })),
  passwordField: (app: DesktopApp): DesktopLocator => LOCATORS.logOnWindow(app).getByAutomationId('passwordField').orElse(LOCATORS.logOnWindow(app).getByRole('Edit', { name: 'Password:' })),
  logOnOkButton: (app: DesktopApp): DesktopLocator => LOCATORS.logOnWindow(app).getByRole('Button', { name: 'OK' }),
  mainWindow: (app: DesktopApp): WindowLocator => app.window(/^SAS Management Console$/i),
  environmentManagementNode: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByRole('TreeItem', { name: 'Environment Management' }),
  navigationTree: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByAutomationId('navTree').orElse(LOCATORS.mainWindow(app).getByRole('Tree', { name: 'Navigation Tree' })),
  newUserButton: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByRole('Button', { name: 'New User...' }),
  newUserPropertiesWindow: (app: DesktopApp): WindowLocator => app.window(/^New User Properties$/i),
  nameField: (app: DesktopApp): DesktopLocator => LOCATORS.newUserPropertiesWindow(app).getByRole('Edit', { name: 'Name:' }),
  displayNameField: (app: DesktopApp): DesktopLocator => LOCATORS.newUserPropertiesWindow(app).getByRole('Edit', { name: 'Display Name:' }),
  newUserPropertiesOkButton: (app: DesktopApp): DesktopLocator => LOCATORS.newUserPropertiesWindow(app).getByRole('Button', { name: 'OK' }),
};

/**
 * Converted from examples/smc_create_user.sasrec.json by sas-desktop-to-playwright.
 * Review before committing:
 *  - reads SAS_SMC_PROFILE, SAS_USER, SAS_PASSWORD from the environment (.env.<name> / CI variables); none of those values is stored here
 *  - session: smcApp (the recording contains the logon): the program is launched and NOT logged on; the recorded logon steps run once and are never retried (retries are switched off for this file - a second try with a rejected password can lock the account)
 *  - no waits are needed: every step waits for its control to exist and for the program to go idle
 *  - event 2: the connection profile is read from SAS_SMC_PROFILE: the recorded profile name identifies a server and is not stored here
 *  - event 6: the user ID is read from SAS_USER, not stored here
 *  - event 7: what was typed into "Password:" was never recorded: the test reads SAS_PASSWORD from the environment
 */
// The recording logs on: a rejected password must never be retried (a retry would send the same wrong password again and can lock the account).
test.describe.configure({ retries: 0 });

test('recorded: smc_create_user @sas-desktop', async ({ smcApp: app }) => {
  await LOCATORS.profilesList(app).getByRole('ListItem', { name: CONSTANTS.inputs.profilesListItem }).select(); // event 2
  await LOCATORS.okButton(app).click(); // event 3
  await LOCATORS.userIdField(app).fill(CONSTANTS.inputs.userIdField); // event 6
  await LOCATORS.passwordField(app).fill(CONSTANTS.inputs.passwordField, { secret: true }); // event 7
  await LOCATORS.passwordField(app).press('{ENTER}'); // event 7
  await LOCATORS.logOnOkButton(app).click(); // event 8
  await LOCATORS.environmentManagementNode(app).expand(); // event 11
  await LOCATORS.navigationTree(app).getByRole('TreeItem', { name: CONSTANTS.inputs.navigationTreeItem }).select(); // event 12
  await LOCATORS.newUserButton(app).click(); // event 13
  await LOCATORS.nameField(app).fill(CONSTANTS.inputs.nameField); // event 15
  await LOCATORS.displayNameField(app).fill(CONSTANTS.inputs.displayNameField); // event 16
  await LOCATORS.newUserPropertiesOkButton(app).click(); // event 17
  await expect(LOCATORS.mainWindow(app).getByText(CONSTANTS.expected.autoDemoUserText).first()).toExist();
});
