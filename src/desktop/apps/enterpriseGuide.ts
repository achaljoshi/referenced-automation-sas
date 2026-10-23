import * as path from 'node:path';
import { AdapterError, getLogger } from '@automation/referenced-automation-utils';
import { ComClient, ComObject } from '../com';
import { desktopConfig, type DesktopConfig } from '../config';
import { guarded, type GuardedOperation } from '../guard';
import type { DesktopSession } from '../session';

const log = getLogger('sas-eg');

/**
 * SAS Enterprise Guide through its automation object model (COM) - the FIRST way to drive Enterprise Guide: open a project, run it or one
 * process flow, read what every program logged, export results, save, quit. No window is clicked; a profile that needs a password
 * prompt is the one thing that cannot be done this way (see SasEnterpriseGuideUi for Enterprise Guide's own screens).
 *
 * NOT VERIFIED against the real Enterprise Guide object model. The member names below come from SAS's scheduling script and community
 * examples and were written without access to an installation; the stand-in (fakeApps.ts) implements exactly these members. If the real
 * model differs, EG_COM is the one place to fix. Older Enterprise Guide versions are 32-bit COM servers: use the 32-bit PowerShell
 * (SAS_DESKTOP_POWERSHELL) or the class is "not registered".
 */

// ================================================================================================================ EG_COM
/** The members of the Enterprise Guide object model the driver uses. One place to fix when the real model differs. */
export const EG_COM = {
  /** Application.SetActiveProfile(profileName): which server profile projects run against. */
  setActiveProfile: 'SetActiveProfile',
  /** Application.Open(path, options) -> Project. The second argument is passed as an empty string, as the scheduling script does. */
  open: 'Open',
  /** Application.Quit(). */
  quit: 'Quit',
  /** Application.Version (read for diagnostics only). */
  version: 'Version',
  /** Project.Name. */
  projectName: 'Name',
  /** Project.Run(): runs every item. */
  projectRun: 'Run',
  /** Project.Save(). */
  projectSave: 'Save',
  /** Project.Close(). */
  projectClose: 'Close',
  /** Project.ContainerCollection: the process flows. */
  flows: 'ContainerCollection',
  /** Project.CodeCollection: the programs (SAS code items). */
  programs: 'CodeCollection',
  /** Name of a collection item. */
  itemName: 'Name',
  /** Process flow / program Run(). */
  itemRun: 'Run',
  /** Collection.Count and Collection.Item(index). */
  count: 'Count',
  item: 'Item',
  /** The index of the first item in a collection (0 in the .NET object model; 1 if the real one turns out to count from one). */
  itemBase: 0,
  /** Program.Log (an object) and Log.Text / Log.SaveAs(file). */
  log: 'Log',
  logText: 'Text',
  logSaveAs: 'SaveAs',
  /** Program.Results: a collection of result items, each with Name and SaveAs(file). */
  results: 'Results',
  resultName: 'Name',
  resultSaveAs: 'SaveAs',
  /** Program.LastRunStatus: 'NotRun' | 'Succeeded' | 'Warning' | 'Error'. May not exist: the driver then counts ERROR/WARNING lines of the log. */
  lastRunStatus: 'LastRunStatus',
} as const;

export const EG_PROGID_PREFIX = 'SASEGObjectModel.Application.';

/** Versions to try, newest first, when the registry listing is not available. Candidates only: set SAS_EG_PROGID when you know yours. */
export const EG_VERSION_CANDIDATES = ['8.5', '8.4', '8.3', '8.2', '8.1', '7.15', '7.13', '7.12', '7.11', '7.1', '6.1', '5.1', '4.3', '4.2', '4.1'] as const;

/** Newest first: compares the dotted numbers at the end of two ProgIDs ("...8.3" before "...7.15" before "...7.1"). */
export function compareProgIdVersions(a: string, b: string): number {
  const parts = (id: string) => id.slice(EG_PROGID_PREFIX.length).split('.').map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The ProgID to use: SAS_EG_PROGID when set; otherwise the newest registered `SASEGObjectModel.Application.<version>` (the bridge lists
 * the registry), and when that cannot be listed, the known versions tried newest first.
 */
export async function discoverEgProgId(client: ComClient, configured?: string): Promise<{ progId: string; how: string }> {
  if (configured) return { progId: configured, how: 'SAS_EG_PROGID' };
  let listed: string[] = [];
  try {
    listed = (await client.list(EG_PROGID_PREFIX)).filter((id) => client.isAllowed(id)).sort(compareProgIdVersions);
  } catch (error) {
    log.debug(`[sas-eg] could not list the registered classes (${error instanceof Error ? error.message : String(error)}) - trying the known versions`);
  }
  if (listed[0]) return { progId: listed[0], how: `newest registered class (of ${listed.length})` };
  const tried: string[] = [];
  for (const version of EG_VERSION_CANDIDATES) {
    const progId = `${EG_PROGID_PREFIX}${version}`;
    if (!client.isAllowed(progId)) continue;
    tried.push(progId);
    try {
      const probe = await client.create(progId);
      await probe.release();
      return { progId, how: 'first known version that could be created' };
    } catch (error) {
      if (error instanceof AdapterError && /not registered|NOT_FOUND/i.test(error.message)) continue;
      throw error;
    }
  }
  throw new AdapterError(
    'sas-eg',
    'discover',
    `no Enterprise Guide automation class is registered (tried ${tried.join(', ') || 'nothing: SAS_COM_PROGIDS does not allow SASEGObjectModel.Application.*'}). ` +
      'Is Enterprise Guide installed on this machine? An older (32-bit) Enterprise Guide needs the 32-bit PowerShell: set SAS_DESKTOP_POWERSHELL=C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe. Or set SAS_EG_PROGID to the exact name (npx sas-desktop-inspect doctor lists what is registered).',
  );
}

export type EgRunStatus = 'NotRun' | 'Succeeded' | 'Warning' | 'Error' | 'Unknown';

export interface EgProjectItem {
  kind: 'processFlow' | 'program';
  name: string;
}

export interface EgProgramStatus {
  name: string;
  status: EgRunStatus;
  errors: number;
  warnings: number;
  /** Where the status came from: the object model's own member, or a count of ERROR / WARNING lines in the log. */
  source: 'object-model' | 'log';
}

export interface EgConnectOptions {
  config?: DesktopConfig;
  /** The exact ProgID (SAS_EG_PROGID). Default: discovered. */
  progId?: string;
  /** The server profile to activate (SAS_EG_PROFILE). */
  profile?: string;
  /** Use this COM client (default: one with the allow-list of SAS_COM_PROGIDS). */
  com?: ComClient;
}

const countLines = (text: string, prefix: string): number => text.split(/\r?\n/).filter((line) => line.startsWith(prefix)).length;

/**
 * The Enterprise Guide COM driver. Every method goes through the OperationGuard once, as a whole (a `runProject` is one 'update', not the
 * dozen COM calls inside it), then through the bridge's `com.*` operations.
 *
 *   const eg = await SasEnterpriseGuide.connect(session, { profile: 'Dev SAS Server' });
 *   await eg.openProject('C:\\Projects\\Sales.egp');
 *   const statuses = await eg.runProject();
 *   expect(statuses.every((s) => s.status === 'Succeeded')).toBe(true);
 *   await eg.exportResults({ program: 'Summary', folder: 'C:\\temp\\out' });
 *   await eg.quit();
 */
export class SasEnterpriseGuide {
  private project?: ComObject;
  private projectPath?: string;
  private quit_ = false;

  private constructor(
    private readonly session: DesktopSession,
    private readonly com: ComClient,
    private readonly app: ComObject,
    readonly progId: string,
    readonly profile: string | undefined,
  ) {}

  /** Creates the Enterprise Guide application object (starting Enterprise Guide in the background) and activates the profile. */
  static async connect(session: DesktopSession, options: EgConnectOptions = {}): Promise<SasEnterpriseGuide> {
    const config = options.config ?? desktopConfig();
    const com = options.com ?? new ComClient(session, { allowProgIds: config.comProgIds, driver: 'sas-eg' });
    const profile = options.profile ?? config.egProfile;
    return guarded(session.guard, { driver: 'sas-eg', operation: 'connect', kind: 'read', target: profile ?? 'default profile', local: true }, async () => {
      const found = await discoverEgProgId(com, options.progId ?? config.egProgId);
      log.info(`[sas-eg] using ${found.progId} (${found.how})`);
      const app = await com.create(found.progId);
      if (profile) await app.call(EG_COM.setActiveProfile, [profile], { kind: 'read' });
      return new SasEnterpriseGuide(session, com, app, found.progId, profile);
    });
  }

  private op(operation: string, kind: GuardedOperation['kind'], target?: string): Pick<GuardedOperation, 'driver' | 'operation' | 'kind' | 'target'> {
    return { driver: 'sas-eg', operation, kind, target };
  }

  private requireProject(): ComObject {
    if (!this.project) throw new AdapterError('sas-eg', 'project', 'no project is open: call openProject(path) first');
    return this.project;
  }

  /** The Enterprise Guide version the object model reports. */
  async version(): Promise<string> {
    return String(await this.app.get(EG_COM.version));
  }

  /** Opens a project file. Returns the project's name. Opening reads the project; it does not run anything. */
  async openProject(projectFile: string): Promise<string> {
    return guarded(this.session.guard, this.op('openProject', 'read', projectFile), async () => {
      if (this.project) await this.closeProject();
      const project = (await this.app.call(EG_COM.open, [projectFile, ''], { kind: 'read' })) as ComObject;
      this.project = project;
      this.projectPath = projectFile;
      return String(await project.get(EG_COM.projectName));
    });
  }

  private async items(collection: ComObject): Promise<ComObject[]> {
    const count = Number(await collection.get(EG_COM.count));
    const out: ComObject[] = [];
    for (let i = 0; i < count; i++) out.push((await collection.call(EG_COM.item, [EG_COM.itemBase + i], { kind: 'read' })) as ComObject);
    return out;
  }

  /** What the open project contains: its process flows and its programs. */
  async listItems(): Promise<EgProjectItem[]> {
    const project = this.requireProject();
    return guarded(this.session.guard, this.op('listItems', 'read', this.projectPath), async () => {
      const out: EgProjectItem[] = [];
      for (const flow of await this.items((await project.get(EG_COM.flows)) as ComObject)) out.push({ kind: 'processFlow', name: String(await flow.get(EG_COM.itemName)) });
      for (const program of await this.items((await project.get(EG_COM.programs)) as ComObject)) out.push({ kind: 'program', name: String(await program.get(EG_COM.itemName)) });
      return out;
    });
  }

  private async findNamed(collectionMember: string, name: string, what: string): Promise<ComObject> {
    const project = this.requireProject();
    const found: string[] = [];
    for (const item of await this.items((await project.get(collectionMember)) as ComObject)) {
      const itemName = String(await item.get(EG_COM.itemName));
      if (itemName === name) return item;
      found.push(itemName);
    }
    throw new AdapterError('sas-eg', what, `the project has no ${what} named "${name}" (it has: ${found.map((n) => `"${n}"`).join(', ') || 'none'})`);
  }

  /** Runs every item of the open project and returns the status of each program. SAS code runs on the profile's server: an 'update'. */
  async runProject(): Promise<EgProgramStatus[]> {
    const project = this.requireProject();
    return guarded(this.session.guard, this.op('runProject', 'update', this.projectPath), async () => {
      await project.call(EG_COM.projectRun);
      return this.programStatuses(); // inside the same authorised operation: reading the outcome is part of running
    });
  }

  /** Runs one process flow of the open project. */
  async runProcessFlow(name: string): Promise<void> {
    await guarded(this.session.guard, this.op('runProcessFlow', 'update', `${this.projectPath ?? ''} / ${name}`), async () => {
      const flow = await this.findNamed(EG_COM.flows, name, 'process flow');
      await flow.call(EG_COM.itemRun);
    });
  }

  /** The text a program wrote to the SAS log (empty before it has run). */
  async programLog(name: string): Promise<string> {
    return guarded(this.session.guard, this.op('readLog', 'read', name), async () => {
      const program = await this.findNamed(EG_COM.programs, name, 'program');
      const logObject = (await program.get(EG_COM.log)) as ComObject;
      return String(await logObject.get(EG_COM.logText));
    });
  }

  /**
   * How a program ended: the object model's own status when it has one, else a count of ERROR / WARNING lines in the log. A program that
   * has not run is `NotRun` (object model) or - without a status member - `Unknown` when its log is empty.
   */
  async programStatus(name: string): Promise<EgProgramStatus> {
    const log_ = await this.programLog(name);
    const errors = countLines(log_, 'ERROR');
    const warnings = countLines(log_, 'WARNING');
    let reported: string | undefined;
    try {
      const program = await this.findNamed(EG_COM.programs, name, 'program');
      reported = String(await program.get(EG_COM.lastRunStatus));
    } catch (error) {
      log.debug(`[sas-eg] no ${EG_COM.lastRunStatus} for "${name}" (${error instanceof Error ? error.message.split('\n')[0] : String(error)}) - using the log`);
    }
    if (reported && ['NotRun', 'Succeeded', 'Warning', 'Error'].includes(reported)) {
      return { name, status: reported as EgRunStatus, errors, warnings, source: 'object-model' };
    }
    const status: EgRunStatus = log_.trim() === '' ? 'Unknown' : errors > 0 ? 'Error' : warnings > 0 ? 'Warning' : 'Succeeded';
    return { name, status, errors, warnings, source: 'log' };
  }

  /** The status of every program in the open project. */
  async programStatuses(): Promise<EgProgramStatus[]> {
    const names = (await this.listItems()).filter((i) => i.kind === 'program').map((i) => i.name);
    const out: EgProgramStatus[] = [];
    for (const name of names) out.push(await this.programStatus(name));
    return out;
  }

  /** Saves a program's results (every result item) into `folder`. Returns the file paths written. Creates files: a 'create'. */
  async exportResults(options: { program: string; folder: string }): Promise<string[]> {
    return guarded(this.session.guard, this.op('exportResults', 'create', options.folder), async () => {
      const program = await this.findNamed(EG_COM.programs, options.program, 'program');
      const results = (await program.get(EG_COM.results)) as ComObject;
      const written: string[] = [];
      for (const result of await this.items(results)) {
        const file = path.win32.join(options.folder, String(await result.get(EG_COM.resultName)));
        await result.call(EG_COM.resultSaveAs, [file]);
        written.push(file);
      }
      return written;
    });
  }

  /** Saves a program's log to a file. */
  async exportLog(program: string, file: string): Promise<string> {
    return guarded(this.session.guard, this.op('exportLog', 'create', file), async () => {
      const item = await this.findNamed(EG_COM.programs, program, 'program');
      const logObject = (await item.get(EG_COM.log)) as ComObject;
      await logObject.call(EG_COM.logSaveAs, [file]);
      return file;
    });
  }

  async saveProject(): Promise<void> {
    const project = this.requireProject();
    await guarded(this.session.guard, this.op('saveProject', 'update', this.projectPath), async () => {
      await project.call(EG_COM.projectSave);
    });
  }

  async closeProject(): Promise<void> {
    if (!this.project) return;
    const project = this.project;
    await guarded(this.session.guard, this.op('closeProject', 'read', this.projectPath), async () => {
      await project.call(EG_COM.projectClose, [], { kind: 'read' });
      await project.release();
    });
    this.project = undefined;
    this.projectPath = undefined;
  }

  /** Closes the project, quits Enterprise Guide and releases every COM object. Safe to call twice. */
  async quit(): Promise<void> {
    if (this.quit_) return;
    this.quit_ = true;
    await this.closeProject().catch(() => undefined);
    await guarded(this.session.guard, this.op('quit', 'read'), async () => {
      await this.app.call(EG_COM.quit, [], { kind: 'read' });
    }).catch((error) => log.warn(`[sas-eg] quit: ${error instanceof Error ? error.message : String(error)}`));
    await this.com.releaseAll();
  }
}
