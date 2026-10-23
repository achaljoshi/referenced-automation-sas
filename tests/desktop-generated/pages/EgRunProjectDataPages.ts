// CONSTANTS and LOCATORS first: change a value or fix a locator once, here. Then one class per window - rename the classes and members to business terms, add methods.
// Generated from examples/eg_run_project.sasrec.json by sas-desktop-to-playwright (page-object mode).
import { loadEnv } from '@automation/referenced-automation-utils';
import type { DesktopApp, DesktopLocator, WindowLocator } from '../../../src/desktop';

const env = loadEnv();

/** What the recording typed, chose and expected, and the dialogs it dismissed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */
export const CONSTANTS = {
  inputs: {
    get profilesListItem() {
      return env.get('SAS_EG_PROFILE');
    },
    get userIdField() {
      return env.get('SAS_USER');
    },
    get passwordField() {
      return env.get('SAS_PASSWORD');
    },
  },
  dialogs: {
    tipOfTheDay: { title: /^Tip of the Day$/i, button: 'Close' },
  },
  expected: {
    procedureMeansText: 'PROCEDURE MEANS',
  },
};

/** Every window and control the recording used, named once. When a screen changes, fix the locator here and every step follows. */
export const LOCATORS = {
  mainWindow: (app: DesktopApp): WindowLocator => app.window(/^(.+ - )?SAS Enterprise Guide$/i),
  connectButton: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByAutomationId('ConnectButton').orElse(LOCATORS.mainWindow(app).getByRole('Button', { name: 'Connect' })),
  mainFlowList: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByRole('List', { name: 'Main Flow' }),
  runButton: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByAutomationId('RunButton').orElse(LOCATORS.mainWindow(app).getByRole('Button', { name: 'Run' })),
  selectProfileWindow: (app: DesktopApp): WindowLocator => app.window(/^Select Profile$/i),
  profilesList: (app: DesktopApp): DesktopLocator => LOCATORS.selectProfileWindow(app).getByRole('List', { name: 'Profiles' }),
  okButton: (app: DesktopApp): DesktopLocator => LOCATORS.selectProfileWindow(app).getByRole('Button', { name: 'OK' }),
  sasLogonWindow: (app: DesktopApp): WindowLocator => app.window(/^SAS Logon$/i),
  userIdField: (app: DesktopApp): DesktopLocator => LOCATORS.sasLogonWindow(app).getByAutomationId('userIdField').orElse(LOCATORS.sasLogonWindow(app).getByRole('Edit', { name: 'User ID:' })),
  passwordField: (app: DesktopApp): DesktopLocator => LOCATORS.sasLogonWindow(app).getByAutomationId('passwordField').orElse(LOCATORS.sasLogonWindow(app).getByRole('Edit', { name: 'Password:' })),
  sasLogonOkButton: (app: DesktopApp): DesktopLocator => LOCATORS.sasLogonWindow(app).getByRole('Button', { name: 'OK' }),
  openWindow: (app: DesktopApp): WindowLocator => app.window(/^Open$/i),
  fileNameField: (app: DesktopApp): DesktopLocator => LOCATORS.openWindow(app).getByAutomationId('1148').orElse(LOCATORS.openWindow(app).getByRole('Edit', { name: 'File name:' })),
  openButton: (app: DesktopApp): DesktopLocator => LOCATORS.openWindow(app).getByAutomationId('1').orElse(LOCATORS.openWindow(app).getByRole('Button', { name: 'Open' })),
};

/** The "SAS Enterprise Guide" window. */
export class MainPage {
  constructor(readonly app: DesktopApp) {}

  /** The window itself. */
  get window(): WindowLocator {
    return LOCATORS.mainWindow(this.app);
  }

  get connectButton(): DesktopLocator {
    return LOCATORS.connectButton(this.app);
  }

  get mainFlowList(): DesktopLocator {
    return LOCATORS.mainFlowList(this.app);
  }

  get runButton(): DesktopLocator {
    return LOCATORS.runButton(this.app);
  }

  /** Waits until the window is on the screen. */
  async waitUntilDisplayed(timeout?: number): Promise<MainPage> {
    await this.window.waitFor({ timeout });
    return this;
  }
}

/** The "Select Profile" window. */
export class SelectProfilePage {
  constructor(readonly app: DesktopApp) {}

  /** The window itself. */
  get window(): WindowLocator {
    return LOCATORS.selectProfileWindow(this.app);
  }

  get profilesList(): DesktopLocator {
    return LOCATORS.profilesList(this.app);
  }

  get okButton(): DesktopLocator {
    return LOCATORS.okButton(this.app);
  }

  /** Waits until the window is on the screen. */
  async waitUntilDisplayed(timeout?: number): Promise<SelectProfilePage> {
    await this.window.waitFor({ timeout });
    return this;
  }
}

/** The "SAS Logon" window. */
export class SasLogonPage {
  constructor(readonly app: DesktopApp) {}

  /** The window itself. */
  get window(): WindowLocator {
    return LOCATORS.sasLogonWindow(this.app);
  }

  get userIdField(): DesktopLocator {
    return LOCATORS.userIdField(this.app);
  }

  get passwordField(): DesktopLocator {
    return LOCATORS.passwordField(this.app);
  }

  get sasLogonOkButton(): DesktopLocator {
    return LOCATORS.sasLogonOkButton(this.app);
  }

  /** Waits until the window is on the screen. */
  async waitUntilDisplayed(timeout?: number): Promise<SasLogonPage> {
    await this.window.waitFor({ timeout });
    return this;
  }
}

/** The "Open" window. */
export class OpenPage {
  constructor(readonly app: DesktopApp) {}

  /** The window itself. */
  get window(): WindowLocator {
    return LOCATORS.openWindow(this.app);
  }

  get fileNameField(): DesktopLocator {
    return LOCATORS.fileNameField(this.app);
  }

  get openButton(): DesktopLocator {
    return LOCATORS.openButton(this.app);
  }

  /** Waits until the window is on the screen. */
  async waitUntilDisplayed(timeout?: number): Promise<OpenPage> {
    await this.window.waitFor({ timeout });
    return this;
  }
}
