import { FakeCom, FakeComError } from './fakeCom';
import { FakeDesktop, type FakeDesktopOptions, type FakeElement, type FakeHandlers, type FakeProcess, type NodeInit } from './fakeDesktop';
import { DesktopSession, type DesktopSessionOptions } from './session';

/**
 * A fake SAS Management Console (a Java Swing application) and a fake SAS Enterprise Guide (a WPF application) on the in-memory
 * desktop, plus the Enterprise Guide automation object model as a fake COM class. They are built from what the framework's
 * LOCATORS tables look for, NOT from the real applications: they prove the framework's flows, not that SAS looks like this.
 * NOT VERIFIED against the real applications.
 *
 * The control names, automation ids and flows here are written out independently of the app layers' LOCATORS (apps/*.ts), so a typo in
 * either one shows up as a failing test instead of two identical mistakes.
 */

export interface FakeAccount {
  user: string;
  password: string;
}

export type DialogMode = 'owned' | 'toplevel';
/** How the application says a logon was rejected: a message inside the same dialog, or a separate message box. */
export type RejectionStyle = 'inline' | 'messagebox';

interface FakeLogonOptions {
  profiles?: string[];
  accounts?: FakeAccount[];
  /** After this many rejected logons the account is locked (every later logon fails with "locked", even a correct one). 0 = never. */
  lockoutAfter?: number;
  /** A valid logon takes this long to complete (the application is busy). */
  logonDelayMs?: number;
  dialogMode?: DialogMode;
  rejection?: RejectionStyle;
  /** The windows appear this long after the launch / the click that opens them (a slow machine). */
  appearDelayMs?: number;
}

export interface FakeSmcOptions extends FakeLogonOptions {
  path?: string;
  users?: string[];
  groups?: string[];
  libraries?: string[];
  servers?: Array<{ name: string; type: string; status: string }>;
  /** Without the Java Access Bridge a Swing window shows UI Automation nothing but its title bar. Default true. */
  javaAccessBridge?: boolean;
}

export interface FakeSmc {
  readonly options: Required<Omit<FakeSmcOptions, 'path'>> & { path: string };
  /** Every logon attempt, in order. The password is never kept. */
  readonly attempts: Array<{ user: string; accepted: boolean }>;
  failures: number;
  locked: boolean;
  process?: FakeProcess;
  profile?: string;
  user?: string;
  main?: FakeElement;
  /** The plug-in shown in the content pane right now. */
  plugin?: string;
}

export interface FakeProgramSpec {
  name: string;
  /** The log the program produces when it runs. */
  log: string;
  results: string[];
  /** Running it takes this long. */
  runMs?: number;
}

export interface FakeProject {
  flows: Array<{ name: string; programs: string[] }>;
  programs: FakeProgramSpec[];
}

export interface FakeEgOptions extends FakeLogonOptions {
  path?: string;
  /** Project files that exist, by path. */
  projects?: Record<string, FakeProject>;
  /** The COM class versions that are registered (ProgID SASEGObjectModel.Application.<version>). Default ['8.3']. */
  comVersions?: string[];
  /** Whether the object model exposes a run status per program (LastRunStatus). Default true; false makes the driver fall back to the log. */
  exposeRunStatus?: boolean;
}

export interface FakeEg {
  readonly options: Required<Omit<FakeEgOptions, 'path'>> & { path: string };
  readonly attempts: Array<{ user: string; accepted: boolean }>;
  failures: number;
  locked: boolean;
  process?: FakeProcess;
  profile?: string;
  user?: string;
  main?: FakeElement;
  /** The project open in the UI. */
  openProjectPath?: string;
  /** What ran, in order: 'project:<path>', 'flow:<name>', 'program:<name>'. */
  readonly ran: string[];
  /** The COM side. */
  readonly com: {
    activeProfile?: string;
    openedPaths: string[];
    saved: string[];
    quitCalls: number;
    /** Files written by SaveAs (log and results exports), by path. */
    files: Map<string, string>;
  };
}

export const FAKE_SMC_PATH = 'C:\\Program Files\\SASHome\\SASManagementConsole\\9.4\\sasmc.exe';
export const FAKE_EG_PATH = 'C:\\Program Files\\SASHome\\SASEnterpriseGuide\\8\\SEGuide.exe';
export const FAKE_PROJECT_PATH = 'C:\\Projects\\Sales.egp';

export const SAMPLE_PROJECT: FakeProject = {
  flows: [{ name: 'Main Flow', programs: ['Program', 'Summary'] }],
  programs: [
    {
      name: 'Program',
      log: ['1    proc print data=sashelp.class;', 'NOTE: There were 19 observations read from the data set SASHELP.CLASS.', 'NOTE: PROCEDURE PRINT used (Total process time):'].join('\n'),
      results: ['Program.html'],
    },
    {
      name: 'Summary',
      log: ['2    proc means data=sashelp.class;', 'NOTE: PROCEDURE MEANS used (Total process time):', 'WARNING: Variable X not found.'].join('\n'),
      results: ['Summary.html', 'Summary.pdf'],
    },
  ],
};

const DEFAULT_ACCOUNTS: FakeAccount[] = [{ user: 'sasdemo', password: 'Orion123' }];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The plug-in names under "Environment Management" in the fake navigation tree. */
export const FAKE_SMC_PLUGINS = ['Data Library Manager', 'Metadata Manager', 'Schedule Manager', 'Server Manager', 'User Manager'] as const;

// ---------------------------------------------------------------------------------------------------------------- helpers

function textNode(name: string, automationId = ''): NodeInit {
  return { controlType: 'Text', name, automationId };
}

function buttonNode(name: string, onInvoke: NonNullable<FakeHandlers['invoke']>, extra: Partial<NodeInit> = {}): NodeInit {
  return { controlType: 'Button', name, on: { invoke: onInvoke }, ...extra };
}

/** Opens a dialog the way the application does: as a window owned by `owner` (a child in UI Automation's tree) or as its own top-level window. */
function openDialog(
  desktop: FakeDesktop,
  process_: FakeProcess,
  owner: FakeElement | undefined,
  mode: DialogMode,
  title: string,
  init: Omit<NodeInit, 'controlType'>,
  appearAfterMs = 0,
): FakeElement {
  if (mode === 'owned' && owner) {
    return desktop.attach(owner, { controlType: 'Window', className: 'SunAwtDialog', ...init, name: title, appearAfterMs });
  }
  return desktop.addWindow(process_, { className: 'SunAwtDialog', ...init, title, appearAfterMs });
}

interface LogonFlowSpec {
  desktop: FakeDesktop;
  process_: FakeProcess;
  owner?: FakeElement;
  mode: DialogMode;
  rejection: RejectionStyle;
  appearAfterMs: number;
  logonDelayMs: number;
  accounts: FakeAccount[];
  lockoutAfter: number;
  profiles: string[];
  titles: { profile: string; logon: string; error: string };
  state: { attempts: Array<{ user: string; accepted: boolean }>; failures: number; locked: boolean; profile?: string; user?: string };
  /** Called once a valid logon completed (after the delay). */
  onLoggedOn: () => void;
}

/** Profile chooser, then the Log On dialog with User ID and Password fields, a rejected-password message, and optional lockout. */
function startLogonFlow(spec: LogonFlowSpec): void {
  const { desktop, state } = spec;
  let chosen = '';
  const profileDialog = openDialog(
    desktop,
    spec.process_,
    spec.owner,
    spec.mode,
    spec.titles.profile,
    {
      children: [
        textNode('Select a metadata profile'),
        {
          controlType: 'List',
          name: 'Profiles',
          children: spec.profiles.map((profile) => ({
            controlType: 'ListItem',
            name: profile,
            selectable: true,
            on: {
              select: () => {
                chosen = profile;
              },
            },
          })),
        },
        buttonNode('OK', () => {
          if (!chosen) return;
          state.profile = chosen;
          desktop.dispose(profileDialog);
          showLogon();
        }),
        buttonNode('Cancel', () => desktop.dispose(profileDialog)),
      ],
    },
    spec.appearAfterMs,
  );

  function showLogon(): void {
    let message: FakeElement | undefined;
    const logon: FakeElement = openDialog(
      desktop,
      spec.process_,
      spec.owner,
      spec.mode,
      spec.titles.logon,
      {
        children: [
          textNode(`Connect to ${chosen}`),
          { controlType: 'Edit', name: 'User ID:', automationId: 'userIdField', value: '' },
          { controlType: 'Edit', name: 'Password:', automationId: 'passwordField', value: '', isPassword: true },
          buttonNode('OK', () => attempt()),
          buttonNode('Cancel', () => desktop.dispose(logon)),
        ],
      },
      spec.appearAfterMs,
    );
    const field = (id: string) => logon.find((e) => e.automationId === id);

    const reject = (reason: string) => {
      state.failures++;
      if (spec.lockoutAfter > 0 && state.failures >= spec.lockoutAfter) state.locked = true;
      if (spec.rejection === 'inline') {
        if (message) message.name = reason;
        else message = desktop.attach(logon, textNode(reason, 'logonMessage'));
        const passwordField = field('passwordField');
        if (passwordField) passwordField.value = '';
      } else {
        const box: FakeElement = openDialog(desktop, spec.process_, spec.owner, spec.mode, spec.titles.error, {
          children: [textNode(reason, 'errorMessage'), buttonNode('OK', () => desktop.dispose(box))],
        });
      }
    };

    const attempt = () => {
      const user = field('userIdField')?.value ?? '';
      const password = field('passwordField')?.value ?? '';
      const account = spec.accounts.find((a) => a.user.toLowerCase() === user.toLowerCase() && a.password === password);
      const accepted = Boolean(account) && !state.locked;
      state.attempts.push({ user, accepted });
      if (!accepted) {
        reject(state.locked ? 'The account is locked.' : 'Invalid user ID or password.');
        return;
      }
      state.user = user;
      const finish = () => {
        desktop.dispose(logon);
        spec.onLoggedOn();
      };
      if (spec.logonDelayMs > 0) {
        // the application is busy logging on: the dialog stays until it is done and input is not answered meanwhile
        desktop.busyFor(spec.process_, spec.logonDelayMs);
        setTimeout(finish, spec.logonDelayMs);
      } else finish();
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------- Management Console

export function installFakeManagementConsole(desktop: FakeDesktop, options: FakeSmcOptions = {}): FakeSmc {
  const o = {
    path: options.path ?? FAKE_SMC_PATH,
    profiles: options.profiles ?? ['Dev Metadata Server', 'QA Metadata Server'],
    accounts: options.accounts ?? DEFAULT_ACCOUNTS,
    lockoutAfter: options.lockoutAfter ?? 0,
    logonDelayMs: options.logonDelayMs ?? 0,
    dialogMode: options.dialogMode ?? ('toplevel' as DialogMode),
    rejection: options.rejection ?? ('inline' as RejectionStyle),
    appearDelayMs: options.appearDelayMs ?? 0,
    users: options.users ?? ['Alice Analyst', 'Bob Builder', 'sasdemo'],
    groups: options.groups ?? ['BI Users', 'SAS Administrators'],
    libraries: options.libraries ?? ['Orion', 'Sashelp', 'Stored Processes'],
    servers: options.servers ?? [
      { name: 'SASApp - Workspace Server', type: 'Workspace Server', status: 'Running' },
      { name: 'SASMeta - Metadata Server', type: 'Metadata Server', status: 'Running' },
      { name: 'SASApp - Stored Process Server', type: 'Stored Process Server', status: 'Stopped' },
    ],
    javaAccessBridge: options.javaAccessBridge ?? true,
  };
  const state: FakeSmc = { options: o, attempts: [], failures: 0, locked: false };

  desktop.registerProgram(o.path, {
    process: 'sasmc',
    onLaunch: (d, process_) => {
      state.process = process_;
      if (!o.javaAccessBridge) {
        // a Swing window without the Java Access Bridge: UI Automation sees the native title bar and nothing else
        d.addWindow(process_, { title: 'SAS Management Console', className: 'SunAwtFrame', children: [{ controlType: 'TitleBar', name: 'SAS Management Console' }] });
        return;
      }
      // in 'owned' mode the dialogs belong to an application frame that exists from the start
      const frame = o.dialogMode === 'owned' ? d.addWindow(process_, { title: 'SAS Management Console', className: 'SunAwtFrame', children: [{ controlType: 'TitleBar', name: 'SAS Management Console' }] }) : undefined;
      startLogonFlow({
        desktop: d,
        process_,
        owner: frame,
        mode: o.dialogMode,
        rejection: o.rejection,
        appearAfterMs: o.appearDelayMs,
        logonDelayMs: o.logonDelayMs,
        accounts: o.accounts,
        lockoutAfter: o.lockoutAfter,
        profiles: o.profiles,
        titles: { profile: 'Connection Profile', logon: 'Log On', error: 'SAS Management Console - Error' },
        state,
        onLoggedOn: () => showMain(d, process_, frame, state, o),
      });
    },
  });
  return state;
}

function showMain(desktop: FakeDesktop, process_: FakeProcess, frame: FakeElement | undefined, state: FakeSmc, o: FakeSmc['options']): void {
  const main = frame ?? desktop.addWindow(process_, { title: 'SAS Management Console', className: 'SunAwtFrame' });
  state.main = main;
  const content = desktop.attach(main, { controlType: 'Pane', name: 'Content', automationId: 'contentPane' });
  const clear = () => {
    for (const child of [...content.children]) desktop.dispose(child);
  };
  const renderIdentities = (kind: 'Users' | 'Groups') => {
    for (const row of [...(content.find((e) => e.controlType === 'Table')?.children ?? [])]) desktop.dispose(row);
    const table = content.find((e) => e.controlType === 'Table');
    if (!table) return;
    for (const name of kind === 'Users' ? o.users : o.groups) desktop.attach(table, { controlType: 'DataItem', name });
  };
  const showPlugin = (plugin: string) => {
    state.plugin = plugin;
    clear();
    if (plugin === 'User Manager') {
      desktop.attach(content, {
        controlType: 'Tab',
        name: 'Identity types',
        children: (['Users', 'Groups'] as const).map((kind) => ({
          controlType: 'TabItem',
          name: kind,
          selectable: true,
          selected: kind === 'Users',
          on: { select: () => renderIdentities(kind) },
        })),
      });
      desktop.attach(content, { controlType: 'Table', name: 'Identities' });
      renderIdentities('Users');
    } else if (plugin === 'Server Manager') {
      desktop.attach(content, {
        controlType: 'Table',
        name: 'Servers',
        children: o.servers.map((s) => ({ controlType: 'DataItem', name: s.name, children: [textNode(s.type), textNode(s.status)] })),
      });
    } else {
      desktop.attach(content, textNode(`${plugin} is ready`, 'pluginTitle'));
    }
  };
  const nav = desktop.attach(main, { controlType: 'Tree', name: 'Navigation Tree', automationId: 'navTree' });
  desktop.attach(nav, {
    controlType: 'TreeItem',
    name: 'SAS Management Console',
    selectable: true,
    expand: 'Expanded',
    children: [
      {
        controlType: 'TreeItem',
        name: 'Environment Management',
        selectable: true,
        expand: 'Collapsed',
        children: FAKE_SMC_PLUGINS.map((plugin) => ({
          controlType: 'TreeItem',
          name: plugin,
          selectable: true,
          expand: plugin === 'Data Library Manager' ? ('Collapsed' as const) : ('LeafNode' as const),
          on: { select: () => showPlugin(plugin) },
          children: plugin === 'Data Library Manager' ? o.libraries.map((library) => ({ controlType: 'TreeItem', name: library, selectable: true, expand: 'LeafNode' as const })) : [],
        })),
      },
    ],
  });
  desktop.adopt(main);
}

// ---------------------------------------------------------------------------------------------------------------- Enterprise Guide

function logCounts(log: string): { errors: number; warnings: number } {
  return { errors: (log.match(/^ERROR/gm) ?? []).length, warnings: (log.match(/^WARNING/gm) ?? []).length };
}

export function installFakeEnterpriseGuide(desktop: FakeDesktop, options: FakeEgOptions = {}): FakeEg {
  const o = {
    path: options.path ?? FAKE_EG_PATH,
    profiles: options.profiles ?? ['Dev SAS Server', 'QA SAS Server'],
    accounts: options.accounts ?? DEFAULT_ACCOUNTS,
    lockoutAfter: options.lockoutAfter ?? 0,
    logonDelayMs: options.logonDelayMs ?? 0,
    dialogMode: options.dialogMode ?? ('toplevel' as DialogMode),
    rejection: options.rejection ?? ('messagebox' as RejectionStyle),
    appearDelayMs: options.appearDelayMs ?? 0,
    projects: options.projects ?? { [FAKE_PROJECT_PATH]: SAMPLE_PROJECT },
    comVersions: options.comVersions ?? ['8.3'],
    exposeRunStatus: options.exposeRunStatus ?? true,
  };
  const state: FakeEg = {
    options: o,
    attempts: [],
    failures: 0,
    locked: false,
    ran: [],
    com: { openedPaths: [], saved: [], quitCalls: 0, files: new Map() },
  };

  const runProgram = async (program: FakeProgramSpec) => {
    if (program.runMs) await sleep(program.runMs);
    state.ran.push(`program:${program.name}`);
  };

  desktop.registerProgram(o.path, {
    process: 'SEGuide',
    onLaunch: (d, process_) => {
      state.process = process_;
      const main = d.addWindow(process_, {
        title: 'SAS Enterprise Guide',
        className: 'HwndWrapper[SEGuide.exe;;fake]',
        appearAfterMs: o.appearDelayMs,
        on: {
          keys: (_el, keys) => {
            if (keys === '^o') showOpenDialog(d, process_, main, state, o, runProgram);
          },
        },
      });
      state.main = main;
      d.attach(main, textNode('Welcome', 'welcomePage'));
      d.attach(main, {
        controlType: 'Button',
        name: 'Connect',
        automationId: 'ConnectButton',
        on: {
          invoke: () =>
            startLogonFlow({
              desktop: d,
              process_,
              owner: main,
              mode: o.dialogMode,
              rejection: o.rejection,
              appearAfterMs: o.appearDelayMs,
              logonDelayMs: o.logonDelayMs,
              accounts: o.accounts,
              lockoutAfter: o.lockoutAfter,
              profiles: o.profiles,
              titles: { profile: 'Select Profile', logon: 'SAS Logon', error: 'SAS Enterprise Guide - Error' },
              state,
              onLoggedOn: () => {
                const status = main.find((e) => e.automationId === 'connectionStatus');
                if (status) status.name = `Connected to ${state.profile ?? ''}`;
                else d.attach(main, textNode(`Connected to ${state.profile ?? ''}`, 'connectionStatus'));
              },
            }),
        },
      });
    },
  });

  // ---- COM: the Enterprise Guide automation object model (the members the framework uses; NOT VERIFIED against the real one)
  const com: FakeCom = desktop.com;
  for (const version of o.comVersions) com.register(`SASEGObjectModel.Application.${version}`, () => egApplication(state, version));
  return state;
}

function projectOf(state: FakeEg, path: string): FakeProject | undefined {
  return state.options.projects[path];
}

function showOpenDialog(
  desktop: FakeDesktop,
  process_: FakeProcess,
  owner: FakeElement,
  state: FakeEg,
  o: FakeEg['options'],
  runProgram: (p: FakeProgramSpec) => Promise<void>,
): void {
  const dialog: FakeElement = openDialog(desktop, process_, owner, o.dialogMode, 'Open', {
    className: '#32770',
    children: [
      { controlType: 'Edit', name: 'File name:', automationId: '1148', value: '' },
      buttonNode(
        'Open',
        () => {
          const path = dialog.find((e) => e.automationId === '1148')?.value ?? '';
          const project = projectOf(state, path);
          if (!project) {
            const existing = dialog.find((e) => e.automationId === 'openError');
            if (existing) existing.name = 'The file could not be found.';
            else desktop.attach(dialog, textNode('The file could not be found.', 'openError'));
            return;
          }
          desktop.dispose(dialog);
          showProject(desktop, owner, state, path, project, runProgram);
        },
        { automationId: '1' },
      ),
      buttonNode('Cancel', () => desktop.dispose(dialog), { automationId: '2' }),
    ],
  });
}

function showProject(
  desktop: FakeDesktop,
  main: FakeElement,
  state: FakeEg,
  path: string,
  project: FakeProject,
  runProgram: (p: FakeProgramSpec) => Promise<void>,
): void {
  state.openProjectPath = path;
  const base = path.split('\\').pop() ?? path;
  main.name = `${base.replace(/\.egp$/i, '')} - SAS Enterprise Guide`;
  for (const old of main.children.filter((c) => c.automationId === 'projectArea')) desktop.dispose(old);
  const area = desktop.attach(main, { controlType: 'Pane', name: 'Project', automationId: 'projectArea' });
  const logView = desktop.attach(area, { controlType: 'Document', name: 'Log', automationId: 'LogView', value: '', readOnly: true });
  const resultsView = desktop.attach(area, { controlType: 'Document', name: 'Results', automationId: 'ResultsView', value: '', readOnly: true });
  const status = desktop.attach(area, textNode('Ready', 'statusText'));
  let selected: FakeProgramSpec | undefined;
  const runButton: FakeElement = desktop.attach(area, {
    controlType: 'Button',
    name: 'Run',
    automationId: 'RunButton',
    on: {
      // the click returns at once; the program runs in the background and the Stop button is enabled meanwhile
      invoke: () => {
        if (!selected) return;
        const program = selected;
        const setRunning = (running: boolean) => {
          stopButton.enabled = running;
          runButton.enabled = !running;
          status.name = running ? `Running ${program.name}` : 'Ready';
        };
        setRunning(true);
        void runProgram(program).then(() => {
          logView.value = program.log;
          resultsView.value = program.results.join('\n');
          setRunning(false);
        });
      },
    },
  });
  const stopButton: FakeElement = desktop.attach(area, { controlType: 'Button', name: 'Stop', automationId: 'StopButton', enabled: false });
  desktop.attach(area, {
    controlType: 'Tab',
    name: 'Process Flow',
    children: project.flows.map((flow) => ({
      controlType: 'List',
      name: flow.name,
      children: flow.programs.map((name) => ({
        controlType: 'ListItem',
        name,
        selectable: true,
        on: {
          select: () => {
            selected = project.programs.find((p) => p.name === name);
          },
        },
      })),
    })),
  });
  desktop.adopt(main);
}

/** Builds the fake Enterprise Guide automation object model: Application -> Project -> process flows / programs -> Log / Results. */
function egApplication(state: FakeEg, version: string): object {
  const collection = (items: object[]) => ({
    get Count() {
      return items.length;
    },
    Item: (index: number) => {
      const item = items[index];
      if (!item) throw new FakeComError(`Index ${index} is outside the collection (0..${items.length - 1})`);
      return item;
    },
  });
  const programObject = (program: FakeProgramSpec) => {
    let ran = false;
    const object = {
      get Name() {
        return program.name;
      },
      async Run() {
        if (program.runMs) await sleep(program.runMs);
        ran = true;
        state.ran.push(`program:${program.name}`);
        return true;
      },
      Log: {
        get Text() {
          return ran ? program.log : '';
        },
        SaveAs(file: string) {
          state.com.files.set(file, ran ? program.log : '');
          return true;
        },
      },
      Results: collection(program.results.map((name) => ({ Name: name, SaveAs: (file: string) => (state.com.files.set(file, `results of ${name}`), true) }))),
    };
    if (state.options.exposeRunStatus) {
      Object.defineProperty(object, 'LastRunStatus', {
        enumerable: true,
        get: () => {
          if (!ran) return 'NotRun';
          const counts = logCounts(program.log);
          return counts.errors > 0 ? 'Error' : counts.warnings > 0 ? 'Warning' : 'Succeeded';
        },
      });
    }
    return object;
  };
  return {
    get Version() {
      return version;
    },
    SetActiveProfile(name: string) {
      if (!state.options.profiles.includes(name)) throw new FakeComError(`The profile "${name}" does not exist`);
      state.com.activeProfile = name;
    },
    Open(path: string) {
      const project = projectOf(state, path);
      if (!project) throw new FakeComError(`The project "${path}" could not be opened`);
      state.com.openedPaths.push(path);
      const programs = project.programs.map(programObject);
      return {
        get Name() {
          return path.split('\\').pop();
        },
        async Run() {
          state.ran.push(`project:${path}`);
          for (const p of programs) await p.Run();
          return true;
        },
        Save() {
          state.com.saved.push(path);
          return true;
        },
        SaveAs(newPath: string) {
          state.com.saved.push(newPath);
          return true;
        },
        Close() {
          return true;
        },
        ContainerCollection: collection(
          project.flows.map((flow) => ({
            get Name() {
              return flow.name;
            },
            async Run() {
              state.ran.push(`flow:${flow.name}`);
              for (const name of flow.programs) await programs.find((p) => p.Name === name)?.Run();
              return true;
            },
          })),
        ),
        CodeCollection: collection(programs),
      };
    },
    Quit() {
      state.com.quitCalls++;
    },
  };
}

export { logCounts };

// ---------------------------------------------------------------------------------------------------------------- the whole desktop

export interface FakeSasDesktopOptions extends FakeDesktopOptions {
  smc?: FakeSmcOptions;
  eg?: FakeEgOptions;
}

export interface FakeSasDesktop {
  desktop: FakeDesktop;
  smc: FakeSmc;
  eg: FakeEg;
  /** A session on the stand-in with test-friendly timing (short timeout and poll). */
  session(options?: DesktopSessionOptions): DesktopSession;
  stop(): Promise<void>;
}

/**
 * Starts the stand-in desktop with a fake SAS Management Console and a fake SAS Enterprise Guide installed at their default paths
 * (FAKE_SMC_PATH, FAKE_EG_PATH) and the Enterprise Guide COM class registered. Nothing is running yet: `launch` starts them.
 */
export function startFakeDesktop(options: FakeSasDesktopOptions = {}): FakeSasDesktop {
  const desktop = new FakeDesktop(options);
  const smc = installFakeManagementConsole(desktop, options.smc ?? {});
  const eg = installFakeEnterpriseGuide(desktop, options.eg ?? {});
  return {
    desktop,
    smc,
    eg,
    session: (sessionOptions = {}) => new DesktopSession(desktop, { timeoutMs: 5_000, pollMs: 10, ...sessionOptions }),
    stop: () => desktop.close(),
  };
}
