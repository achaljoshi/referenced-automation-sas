import { AdapterError } from '@automation/referenced-automation-utils';
import { desktopConfig, type DesktopConfig } from '../config';
import { guarded } from '../guard';
import type { DesktopLocator, WindowLocator } from '../locator';
import type { DesktopApp, DesktopSession } from '../session';
import type { ElementInfo } from '../types';
import { runLogon } from './logonFlow';
import { pick, readStable, waitUntil, type LocateSpec, type SasCredentials } from './support';

/**
 * SAS Management Console (a Java Swing program) through its own screens. This is the LAST resort for Management Console: administrator
 * tasks belong to the batch tools and metadata calls (src/process), which need no window. This layer exists for tests ABOUT the console's
 * screens, and for tasks that have no command-line or API route.
 *
 * Swing controls are visible to Windows UI Automation ONLY when the Java Access Bridge is enabled (`jabswitch -enable`, then restart the
 * program): without it the window is empty to us and every locator below fails; `sas-desktop-inspect doctor` says so.
 *
 * NOT VERIFIED against a real Management Console: every entry in LOCATORS is a best guess from the console's documented layout, written
 * without access to an installation. Run `npx sas-desktop-inspect inspect --app smc` on a machine that has it, and fix the entries.
 */

// =============================================================================================================== LOCATORS
// One place to fix a locator. Window titles are regular expressions (case-insensitive); the rest are Locate entries (see support.ts):
// {role = UI Automation control type, name, automationId}. An array is "primary, then fallbacks".
export const SMC_LOCATORS = {
  windows: {
    /** The window the launch waits for: the profile dialog, the logon dialog or the main window - whichever comes first. */
    launch: /SAS Management Console|Connection Profile|Log ?On/i,
    /** Dialog 1: choose a metadata profile. Title is a guess. */
    profile: /Connection Profile/i,
    /** Dialog 2: user ID and password. Title is a guess. */
    logon: /Log ?On/i,
    /** A message box (a rejected logon can show one). */
    error: /SAS Management Console.*(Error|Warning)|^(Error|Warning)$/i,
    /** The main window: titled with the product name, but not one of the dialogs above. */
    main: /^SAS Management Console\b(?!.*(Connection Profile|Log ?On|Error|Warning))/i,
  },
  profileDialog: {
    /** One profile in the list, by its name. */
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
  /** What a rejected logon says. */
  failureText: /invalid|incorrect|not valid|failed|denied|locked|expired|unable to log/i,
  /** The navigation tree on the left of the main window; its presence means the console is connected and ready. */
  tree: { role: 'Tree' } as LocateSpec,
  /** The node every plug-in sits under. */
  pluginParent: { role: 'TreeItem', name: 'Environment Management' } as LocateSpec,
  /** The tree item of a plug-in: the name the console shows (the framework's name for it on the left). */
  plugins: {
    'User Manager': 'User Manager',
    'Server Manager': 'Server Manager',
    'Metadata Manager': 'Metadata Manager',
    'Library Manager': 'Data Library Manager',
    'Schedule Manager': 'Schedule Manager',
  } as Record<string, string>,
  /** In the User Manager: the tabs that switch the list between users and groups, and the list itself (rows are DataItem). */
  identities: {
    tab: (kind: 'Users' | 'Groups'): LocateSpec => ({ role: 'TabItem', name: kind }),
    table: { role: 'Table' } as LocateSpec,
    row: { controlType: 'DataItem' },
  },
  /** In the Server Manager: a table with one row per server; the row's name is the server, its Text children are the columns [type, status]. */
  servers: {
    table: { role: 'Table' } as LocateSpec,
    row: { controlType: 'DataItem' },
    typeColumn: 0,
    statusColumn: 1,
  },
  /** In the Library Manager: the libraries are the tree items below the plug-in's own item. */
  libraries: { item: { controlType: 'TreeItem', scope: 'children' as const } },
} as const;

export type SmcPlugin = keyof typeof SMC_LOCATORS.plugins;

export interface SmcLaunchOptions {
  config?: DesktopConfig;
  /** The program (SAS_SMC_PATH). */
  path?: string;
  windowTimeoutMs?: number;
}

export interface SmcServerStatus {
  name: string;
  type: string;
  status: string;
}

export class SasManagementConsole {
  private constructor(
    readonly session: DesktopSession,
    readonly app: DesktopApp,
    private readonly config: DesktopConfig,
  ) {}

  /** Starts the console (SAS_SMC_PATH). Logon comes next: `logon(credentials)`. */
  static async launch(session: DesktopSession, options: SmcLaunchOptions = {}): Promise<SasManagementConsole> {
    const config = options.config ?? desktopConfig();
    const path = options.path ?? config.smcPath;
    if (!path) throw new AdapterError('sas-smc', 'launch', 'SAS_SMC_PATH is not set: it is the full path of sasmc.exe (for example C:\\Program Files\\SASHome\\SASManagementConsole\\9.4\\sasmc.exe)');
    const app = await session.launch({ path, windowTitle: SMC_LOCATORS.windows.launch, windowTimeoutMs: options.windowTimeoutMs });
    return new SasManagementConsole(session, app, config);
  }

  /** Attaches to a console that is already running (never closed by `dispose`). */
  static async attach(session: DesktopSession, options: { config?: DesktopConfig } = {}): Promise<SasManagementConsole> {
    const app = await session.attach({ windowTitle: SMC_LOCATORS.windows.launch });
    return new SasManagementConsole(session, app, options.config ?? desktopConfig());
  }

  get mainWindow(): WindowLocator {
    return this.app.window(SMC_LOCATORS.windows.main);
  }

  private get tree(): DesktopLocator {
    return pick(this.mainWindow, SMC_LOCATORS.tree);
  }

  /**
   * Chooses the metadata profile and logs on. A rejected password raises LogonRejected and is NEVER retried: hand the error to the logon
   * guard. With no `profile` the one in SAS_SMC_PROFILE is used.
   */
  async logon(credentials: SasCredentials, options: { profile?: string; timeoutMs?: number } = {}): Promise<void> {
    const L = SMC_LOCATORS;
    const app = this.app;
    await runLogon({
      app,
      appName: 'smc',
      driver: 'sas-smc',
      credentials,
      profile: options.profile ?? this.config.smcProfile,
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
      isDone: async () => this.tree.exists().catch(() => false),
    });
  }

  /** Selects a plug-in in the navigation tree (expanding the node it sits under when needed) and waits until it is selected. */
  async openPlugin(name: SmcPlugin): Promise<DesktopLocator> {
    const label = SMC_LOCATORS.plugins[name];
    if (!label) throw new AdapterError('sas-smc', 'openPlugin', `unknown plug-in "${String(name)}" (known: ${Object.keys(SMC_LOCATORS.plugins).join(', ')})`);
    return guarded(this.session.guard, { driver: 'sas-smc', operation: 'openPlugin', kind: 'read', target: name, local: true }, async () => {
      const item = this.tree.getByRole('TreeItem', { name: label });
      if (!(await item.exists())) await pick(this.tree, SMC_LOCATORS.pluginParent).expand(); // collapsed nodes hide their children
      await item.select();
      await waitUntil(this.session, `the "${label}" plug-in to be selected`, async () => ((await item.snapshot())?.selected ? true : undefined), this.session.timeoutMs, item);
      return item;
    });
  }

  private async rows(table: DesktopLocator, rowCriteria: { controlType: string }): Promise<ElementInfo[]> {
    await table.resolve();
    return readStable(this.session, () => table.locator(rowCriteria).candidates(500));
  }

  /** The names in the User Manager's list for one kind. */
  private async identities(kind: 'Users' | 'Groups'): Promise<string[]> {
    await this.openPlugin('User Manager');
    const tab = pick(this.mainWindow, SMC_LOCATORS.identities.tab(kind));
    if (await tab.exists()) await tab.select();
    const table = pick(this.mainWindow, SMC_LOCATORS.identities.table);
    return (await this.rows(table, SMC_LOCATORS.identities.row)).map((r) => r.name);
  }

  /** Every user the User Manager lists. Best effort: NOT VERIFIED, see SMC_LOCATORS.identities. */
  async listUsers(): Promise<string[]> {
    return this.identities('Users');
  }

  /** The user's name exactly as listed, or undefined (case-insensitive). */
  async findUser(name: string): Promise<string | undefined> {
    return (await this.listUsers()).find((u) => u.toLowerCase() === name.toLowerCase());
  }

  async listGroups(): Promise<string[]> {
    return this.identities('Groups');
  }

  /** The libraries below the Data Library Manager node. */
  async listLibraries(): Promise<string[]> {
    const item = await this.openPlugin('Library Manager');
    await item.expand();
    return readStable(this.session, async () => (await item.locator(SMC_LOCATORS.libraries.item).candidates(500)).map((n) => n.name));
  }

  /** One row per server in the Server Manager with its type and status text. */
  async serverStatus(): Promise<SmcServerStatus[]> {
    await this.openPlugin('Server Manager');
    const table = pick(this.mainWindow, SMC_LOCATORS.servers.table);
    const out: SmcServerStatus[] = [];
    for (const row of await this.rows(table, SMC_LOCATORS.servers.row)) {
      const cells = (await this.session.send({ op: 'children', ref: row.ref })) as ElementInfo[];
      out.push({
        name: row.name,
        type: cells[SMC_LOCATORS.servers.typeColumn]?.name ?? '',
        status: cells[SMC_LOCATORS.servers.statusColumn]?.name ?? '',
      });
    }
    return out;
  }

  /** The Java Access Bridge diagnosis for this application's windows (see `sas-desktop-inspect doctor`). */
  async diagnoseJava() {
    return this.session.send({ op: 'diagnoseJava', pid: this.app.pid });
  }

  async close(options: { force?: boolean } = {}): Promise<void> {
    await this.app.close(options);
  }

  /** Fixture clean-up: closes the console only if this framework started it. */
  async dispose(): Promise<void> {
    await this.app.dispose();
  }
}
