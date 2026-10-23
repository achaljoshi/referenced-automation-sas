import { desktopTest as test, desktopExpect as expect } from '../recorder/support/desktopTest';
import { CONSTANTS, MainPage, SelectProfilePage, SasLogonPage, OpenPage } from './pages/EgRunProjectPages';

/**
 * Converted from examples/eg_run_project.sasrec.json by sas-desktop-to-playwright (page-object mode).
 * Review before committing:
 *  - reads SAS_EG_PROFILE, SAS_USER, SAS_PASSWORD from the environment (.env.<name> / CI variables); none of those values is stored here
 *  - every typed value (CONSTANTS) and every locator (LOCATORS) is at the top of ./pages/EgRunProjectPages.ts: change them there; the page and member names are mechanical - rename them
 *  - session: egApp (the recording contains the logon): the program is launched and NOT logged on; the recorded logon steps run once and are never retried (retries are switched off for this file - a second try with a rejected password can lock the account)
 *  - no waits are needed: every step waits for its control to exist and for the program to go idle
 *  - event 2: the "Tip of the Day" dialog is handled by a handler registered at the top of the test (button "Close")
 *  - event 5: the connection profile is read from SAS_EG_PROFILE: the recorded profile name identifies a server and is not stored here
 *  - event 9: the user ID is read from SAS_USER, not stored here
 *  - event 10: what was typed into "Password:" was never recorded: the test reads SAS_PASSWORD from the environment
 */
// The recording logs on: a rejected password must never be retried (a retry would send the same wrong password again and can lock the account).
test.describe.configure({ retries: 0 });

test('recorded: eg_run_project @sas-desktop', async ({ egApp: app }) => {
  app.onDialog(CONSTANTS.dialogs.tipOfTheDay.title, (dialog) => dialog.getByRole('Button', { name: CONSTANTS.dialogs.tipOfTheDay.button }).click(), { name: 'tipOfTheDay' });
  const mainPage = new MainPage(app);
  const selectProfilePage = new SelectProfilePage(app);
  const sasLogonPage = new SasLogonPage(app);
  const openPage = new OpenPage(app);
  await mainPage.connectButton.click(); // event 3
  await selectProfilePage.profilesList.getByRole('ListItem', { name: CONSTANTS.inputs.profilesListItem }).select(); // event 5
  await selectProfilePage.okButton.click(); // event 6
  await sasLogonPage.userIdField.fill(CONSTANTS.inputs.userIdField); // event 9
  await sasLogonPage.passwordField.fill(CONSTANTS.inputs.passwordField, { secret: true }); // event 10
  await sasLogonPage.passwordField.press('{ENTER}'); // event 10
  await sasLogonPage.sasLogonOkButton.click(); // event 11
  await mainPage.window.press('^o'); // event 13
  await openPage.fileNameField.fill(CONSTANTS.inputs.fileNameField); // event 15
  await openPage.openButton.click(); // event 16
  await mainPage.mainFlowList.getByRole('ListItem', { name: CONSTANTS.inputs.mainFlowListItem }).select(); // event 18
  await mainPage.runButton.click(); // event 19
  await expect(mainPage.window.getByText(CONSTANTS.expected.procedureMeansText).first()).toExist();
});
