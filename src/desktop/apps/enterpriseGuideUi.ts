import * as path from 'node:path';
import { AdapterError } from '@automation/referenced-automation-utils';
import { desktopConfig, type DesktopConfig } from '../config';
import { guarded } from '../guard';
import type { DesktopLocator, WindowLocator } from '../locator';
import type { DesktopApp, DesktopSession } from '../session';
import { runLogon } from './logonFlow';
import { pick, waitUntil, type LocateSpec, type SasCredentials } from './support';

/**
 * SAS Enterprise Guide through its own screens (WPF: UI Automation sees its controls). The SECOND way to drive Enterprise Guide: the
 * automation object model (enterpriseGuide.ts) runs projects without a window and is the first choice. This layer exists for tests about
 * Enterprise Guide's own screens.
 *
 * NOT VERIFIED against a real Enterprise Guide: every entry in EG_UI_LOCATORS is a best guess (the Open dialog's ids are the standard
 * Windows common-dialog ones). Run `npx sas-desktop-inspect inspect --app eg` on a machine that has it and fix the entries.
 */

// =============================================================================================================== LOCATORS
export const EG_UI_LOCATORS = {
  windows: {
    /** The window the launch waits for. */
    launch: /SAS Enterprise Guide/i,
    /** The main window: "SAS Enterprise Guide", or "<project> - SAS Enterprise Guide" once a project is open. Not the error box. */
    main: /^(.+ - )?SAS Enterprise Guide$/i,
    /** Pick a server profile. */
    profile: /Select Profile/i,
    /** User ID and password. */
    logon: /SAS Logon|Log ?On/i,
    /** A message box (a rejected logon shows one). */
    error: /SAS Enterprise Guide - (Error|Warning)/i,
    /** The standard Windows Open dialog (Ctrl+O). */
    open: /^Open$/i,
  },
  /** Opens the connection dialogs. */
  connectButton: [{ role: 'Button', name: 'Connect' }, { automationId: 'ConnectButton' }] as LocateSpec,
  /** Shown once connected ("Connected to <profile>"): the sign the logon is done. */
  connectionStatus: { role: 'Text', name: /^Connected to/i } as LocateSpec,
  profileDialog: {
    item: (profile: string): LocateSpec => ({ role: 'ListItem', name: profile }),
    ok: { role: 'Button', name: 'OK' } as LocateSpec,
  },
  logonDialog: {
    user: { role: 'Edit', name: /User ?(ID|name)/i } as LocateSpec,
    password: { role: 'Edit', name: /^Password/i } as LocateSpec,
    ok: { role: 'Button', name: 'OK' } as LocateSpec,
    cancel: { role: 'Button', name: 'Cancel' } as LocateSpec,
  },
  errorDialog: { ok: { role: 'Button', name: 'OK' } as LocateSpec },
  failureText: /invalid|incorrect|not valid|failed|denied|locked|expired|unable to log/i,
  /** The file name box and the Open button of the standard Windows Open dialog (ids 1148 and 1), and the message it shows for a missing file. */
  openDialog: {
    fileName: [{ automationId: '1148' }, { role: 'Edit', name: /File name/i }] as LocateSpec,
    open: [{ automationId: '1' }, { role: 'Button', name: 'Open' }] as LocateSpec,
    cancel: [{ automationId: '2' }, { role: 'Button', name: 'Cancel' }] as LocateSpec,
    notFound: { role: 'Text', name: /could not be found|not found|does not exist/i } as LocateSpec,
  },
  /** The keyboard shortcut that opens the Open dialog. */
  openShortcut: '^o',
  /** The program nodes of the open project's process flow: ListItem, by the program's name. */
  program: (name: string): LocateSpec => ({ role: 'ListItem', name }),
  /** Run and Stop. A program is running while Stop is enabled. */
  runButton: { role: 'Button', name: 'Run' } as LocateSpec,
  stopButton: { role: 'Button', name: 'Stop' } as LocateSpec,
  /** The views that show a program's log and results. */
  logView: [{ automationId: 'LogView' }, { role: 'Document', name: 'Log' }] as LocateSpec,
  resultsView: [{ automationId: 'ResultsView' }, { role: 'Document', name: 'Results' }] as LocateSpec,
} as const;

export interface EgUiLaunchOptions {
  config?: DesktopConfig;
  /** The program (SAS_EG_PATH). */
  path?: string;
  windowTimeoutMs?: number;
}

export interface EgProgramRun {
  program: string;
  log: string;
  results: string;
  errors: number;
  warnings: number;
}

export class SasEnterpriseGuideUi {
  private constructor(
    readonly session: DesktopSession,
    readonly app: DesktopApp,
    private readonly config: DesktopConfig,
  ) {}

  static async launch(session: DesktopSession, options: EgUiLaunchOptions = {}): Promise<SasEnterpriseGuideUi> {
    const config = options.config ?? desktopConfig();
    const exe = options.path ?? config.egPath;
    if (!exe) throw new AdapterError('sas-eg-ui', 'launch', 'SAS_EG_PATH is not set: it is the full path of SEGuide.exe (for example C:\\Program Files\\SASHome\\SASEnterpriseGuide\\8\\SEGuide.exe)');
    const app = await session.launch({ path: exe, windowTitle: EG_UI_LOCATORS.windows.launch, windowTimeoutMs: options.windowTimeoutMs });
    return new SasEnterpriseGuideUi(session, app, config);
  }

  static async attach(session: DesktopSession, options: { config?: DesktopConfig } = {}): Promise<SasEnterpriseGuideUi> {
    const app = await session.attach({ windowTitle: EG_UI_LOCATORS.windows.launch });
    return new SasEnterpriseGuideUi(session, app, options.config ?? desktopConfig());
  }

  get mainWindow(): WindowLocator {
    return this.app.window(EG_UI_LOCATORS.windows.main);
  }

  /** Connects to a server profile through the logon dialog. A rejected password raises LogonRejected and is NEVER retried. */
  async connect(credentials: SasCredentials, options: { profile?: string; timeoutMs?: number } = {}): Promise<void> {
    const L = EG_UI_LOCATORS;
    const app = this.app;
    await runLogon({
      app,
      appName: 'eg',
      driver: 'sas-eg-ui',
      credentials,
      profile: options.profile ?? this.config.egProfile,
      timeoutMs: options.timeoutMs ?? this.session.timeoutMs,
      profileDialog: app.window(L.windows.profile),
      logonDialog: app.window(L.windows.logon),
      errorDialog: app.window(L.windows.error),
      profileItem: (dialog, profile) => pick(dialog, L.profileDialog.item(profile)),
      profileOk: (dialog) => pick(dialog, L.profileDialog.ok),
      userField: (dialog) => pick(dialog, L.logonDialog.user),
      passwordField: (dialog) => pick(dialog, L.logonDialog.password),
      logonOk: (dialog) => pick(dialog, L.logonDialog.ok),
      logonCancel: (dialog) => pick(dialog, L.logonDialog.cancel),
      errorOk: (dialog) => pick(dialog, L.errorDialog.ok),
      failureText: L.failureText,
      isDone: async () => pick(this.mainWindow, L.connectionStatus).exists().catch(() => false),
      trigger: async () => {
        await pick(this.mainWindow, L.connectButton).click();
      },
    });
  }

  /** Opens a project file through the Open dialog (Ctrl+O) and waits until the main window carries the project's name. */
  async openProject(projectFile: string): Promise<void> {
    const L = EG_UI_LOCATORS;
    await guarded(this.session.guard, { driver: 'sas-eg-ui', operation: 'openProject', kind: 'read', target: projectFile, local: true }, async () => {
      await this.mainWindow.press(L.openShortcut);
      const dialog = this.app.window(L.windows.open);
      await pick(dialog, L.openDialog.fileName).fill(projectFile);
      await pick(dialog, L.openDialog.open).click();
      const base = path.win32.basename(projectFile).replace(/\.egp$/i, '');
      await waitUntil(
        this.session,
        `Enterprise Guide to open ${projectFile}`,
        async () => {
          if ((await this.mainWindow.peek().catch(() => undefined))?.name.toLowerCase().startsWith(base.toLowerCase())) return true;
          const message = await pick(dialog, L.openDialog.notFound).candidates(1).catch(() => []);
          if (message[0]) {
            await pick(dialog, L.openDialog.cancel).click().catch(() => undefined);
            throw new AdapterError('sas-eg-ui', 'openProject', `Enterprise Guide could not open ${projectFile}: "${message[0].name}"`);
          }
          return undefined;
        },
        this.session.timeoutMs,
        dialog,
      );
    });
  }

  private async busy(): Promise<boolean> {
    return (await pick(this.mainWindow, EG_UI_LOCATORS.stopButton).snapshot())?.enabled === true;
  }

  /**
   * Runs a program node of the open project and waits until it has finished: first until it is seen running (Stop enabled; a bounded grace,
   * because a very short program may finish before it can be seen), then until it is not. Returns its log and results text.
   */
  async runProgram(name: string, options: { timeoutMs?: number; startGraceMs?: number } = {}): Promise<EgProgramRun> {
    const L = EG_UI_LOCATORS;
    const timeoutMs = options.timeoutMs ?? this.session.timeoutMs;
    return guarded(this.session.guard, { driver: 'sas-eg-ui', operation: 'runProgram', kind: 'update', target: name, local: true }, async () => {
      await pick(this.mainWindow, L.program(name)).select();
      await pick(this.mainWindow, L.runButton).click();
      const grace = Date.now() + (options.startGraceMs ?? 2_000);
      while (Date.now() < grace && !(await this.busy())) await this.session.pause();
      const deadline = Date.now() + timeoutMs;
      while (await this.busy()) {
        if (Date.now() >= deadline) throw new AdapterError('sas-eg-ui', 'runProgram', `"${name}" was still running after ${timeoutMs}ms`);
        await this.session.pause();
      }
      const log = await this.readLog();
      return { program: name, log, results: await this.readResults(), errors: (log.match(/^ERROR/gm) ?? []).length, warnings: (log.match(/^WARNING/gm) ?? []).length };
    });
  }

  private view(spec: LocateSpec): DesktopLocator {
    return pick(this.mainWindow, spec);
  }

  /** The text of the log view. */
  async readLog(): Promise<string> {
    return this.view(EG_UI_LOCATORS.logView).text();
  }

  /** The text of the results view. */
  async readResults(): Promise<string> {
    return this.view(EG_UI_LOCATORS.resultsView).text();
  }

  async close(options: { force?: boolean } = {}): Promise<void> {
    await this.app.close(options);
  }

  async dispose(): Promise<void> {
    await this.app.dispose();
  }
}
