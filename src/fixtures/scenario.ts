import { AdapterError } from '@automation/referenced-automation-utils';
import type { Credentials } from '../core';
import type { DesktopApp, EgProgramRun, EgProgramStatus, SasEnterpriseGuide, SasEnterpriseGuideUi, SasManagementConsole, WindowLocator } from '../desktop';

/**
 * What one Gherkin scenario carries between steps: which programs the Given steps opened, which route Enterprise Guide is driven by
 * (COM first, screens second), which window the generic control steps act in, the outcome of the last logon attempt and what the last
 * runs reported. A fresh one for every test (the `desktopScenario` fixture). Remembered TEXT lives in the `vars` fixture instead, so
 * `{{placeholders}}` work in every step of every library.
 */
export class DesktopScenario {
  smc?: SasManagementConsole;
  eg?: SasEnterpriseGuideUi;
  com?: SasEnterpriseGuide;
  /** The program the generic control steps act on: the one the last Given step opened. */
  active?: 'smc' | 'eg';
  /** Which Enterprise Guide driver the project steps use: set by the Given step that opened it. */
  route?: 'com' | 'ui';
  /** The title of the window the generic steps act in; undefined = the program's main window. */
  windowTitle?: string;
  /** Program statuses from the last COM run. */
  readonly statuses = new Map<string, EgProgramStatus>();
  /** Program runs from the screens route. */
  readonly runs = new Map<string, EgProgramRun>();
  /** What the last `I try to log on` step ended with (undefined = no attempt yet). `error` is undefined when the logon worked. */
  logon?: { error?: unknown };
  /** The made-up wrong login the last `I try to log on ... with a wrong password` step used (its password is held privately by `Credentials`). */
  wrongCredentials?: Credentials;

  requireSmc(): SasManagementConsole {
    if (!this.smc) throw new AdapterError('sas-steps', 'smc', 'SAS Management Console is not open in this scenario: start with `Given SAS Management Console is open and I am logged on`');
    return this.smc;
  }

  requireEgUi(): SasEnterpriseGuideUi {
    if (!this.eg) throw new AdapterError('sas-steps', 'eg', 'Enterprise Guide is not open in this scenario: start with `Given SAS Enterprise Guide is open and I am logged on`');
    return this.eg;
  }

  requireEgCom(): SasEnterpriseGuide {
    if (!this.com) throw new AdapterError('sas-steps', 'eg-com', 'Enterprise Guide is not available by COM in this scenario: start with `Given SAS Enterprise Guide is available through its automation interface`');
    return this.com;
  }

  /** The application the generic steps act on. */
  activeApp(): DesktopApp {
    if (this.active === 'smc') return this.requireSmc().app;
    if (this.active === 'eg') return this.requireEgUi().app;
    throw new AdapterError('sas-steps', 'window', 'no program is open in this scenario: start with a Given step such as `Given SAS Management Console is open`');
  }

  /** The window the generic steps act in: the one chosen with `I switch to the window ...`, else the program's main window. */
  currentWindow(): WindowLocator {
    if (this.windowTitle !== undefined) return this.activeApp().window(this.windowTitle);
    if (this.active === 'smc') return this.requireSmc().mainWindow;
    return this.requireEgUi().mainWindow;
  }
}
