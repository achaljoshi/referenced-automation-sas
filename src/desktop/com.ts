import { adapterStep } from '@automation/referenced-automation-utils';
import { ComClassRefusedError } from './errors';
import { isValidProgId, progIdMatches } from './comAllowList';
import { DEFAULT_COM_PROGIDS } from './config';
import { guarded, type OperationKind } from './guard';
import type { DesktopSession } from './session';
import { DesktopTransportError, type ComRef, type ComValue } from './types';

/** What a COM read or call hands back: primitives, arrays, and COM objects as handles you can keep using. */
export type ComResult = null | string | number | boolean | ComObject | ComResult[];

export interface ComCallOptions {
  /** What the call can do, for the guard. A method is assumed to change something ('update') unless you say it only reads. */
  kind?: OperationKind;
  /** An argument is a secret (a password): it is not logged. */
  secret?: boolean;
}

const isRef = (value: unknown): value is ComRef => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as ComRef).__com === 'string';

/**
 * A COM object living inside the bridge, referred to by handle. Read a property with `get('Projects.Count')`, change one with `set`,
 * call a method with `call('Open', [path, ''])`; a result that is itself a COM object comes back as another ComObject. Paths are
 * dotted member names. Call `release()` when done (the client releases the rest when the bridge ends).
 */
export class ComObject {
  constructor(
    private readonly client: ComClient,
    readonly handle: string,
    /** For messages: the class it came from and the member that returned it. */
    readonly description: string,
  ) {}

  toString(): string {
    return this.description;
  }

  /** Reads a property (a dotted path from this object). */
  async get(path?: string): Promise<ComResult> {
    return this.client.get(this, path);
  }

  async set(path: string, value: ComValue | ComObject, options: ComCallOptions = {}): Promise<void> {
    await this.client.set(this, path, value, options);
  }

  /** Calls a method (the last segment of `method`; the segments before it are properties to walk). */
  async call(method: string, args: Array<ComValue | ComObject> = [], options: ComCallOptions = {}): Promise<ComResult> {
    return this.client.call(this, method, args, options);
  }

  async release(): Promise<void> {
    await this.client.release(this);
  }
}

/**
 * Generic COM access through the bridge, for the Enterprise Guide automation object model and the Integration Technologies client.
 *
 * Only classes on the allow-list can be created - by default `SASEGObjectModel.Application.*` and `SASObjectManager.*` (SAS_COM_PROGIDS).
 * The bridge refuses everything else on its own; this client also checks first so the message is clear. Every create/set/call goes
 * through the OperationGuard (a call is an 'update' unless the caller says it only reads).
 *
 * Older Enterprise Guide versions are 32-bit COM servers: the bridge has to be the 32-bit PowerShell (SAS_DESKTOP_POWERSHELL) to find them.
 * NOT VERIFIED against the real Enterprise Guide object model; the stand-in implements the members the framework uses.
 */
export class ComClient {
  private readonly open = new Set<string>();

  constructor(
    private readonly session: DesktopSession,
    private readonly options: { allowProgIds?: readonly string[]; driver?: string } = {},
  ) {}

  private get driver(): string {
    return this.options.driver ?? 'desktop-com';
  }

  get allowProgIds(): readonly string[] {
    return this.options.allowProgIds ?? DEFAULT_COM_PROGIDS;
  }

  /** Would the allow-list let this class be created? */
  isAllowed(progId: string): boolean {
    return progIdMatches(this.allowProgIds, progId);
  }

  /** Creates a COM object of `progId` inside the bridge (starting its server, e.g. Enterprise Guide, if needed). */
  async create(progId: string): Promise<ComObject> {
    if (!isValidProgId(progId) || !this.isAllowed(progId)) throw new ComClassRefusedError(progId, [...this.allowProgIds]);
    return guarded(this.session.guard, { driver: this.driver, operation: 'com.create', kind: 'read', target: progId }, () =>
      adapterStep('desktop-com', 'create', async () => {
        try {
          const { handle } = (await this.session.send({ op: 'com.create', progId })) as { handle: string };
          this.open.add(handle);
          return new ComObject(this, handle, progId);
        } catch (error) {
          if (error instanceof DesktopTransportError && error.code === 'DENIED') throw new ComClassRefusedError(progId, [...this.allowProgIds]);
          throw error;
        }
      }, { details: { progId } }),
    );
  }

  /** The registered ProgIDs the allow-list lets through (optionally starting with `prefix`): how a version number is discovered. */
  async list(prefix?: string): Promise<string[]> {
    return (await this.session.send({ op: 'com.list', ...(prefix ? { prefix } : {}) })) as string[];
  }

  private wrapOut(value: unknown, description: string): ComResult {
    if (isRef(value)) {
      this.open.add(value.__com);
      return new ComObject(this, value.__com, description);
    }
    if (Array.isArray(value)) return value.map((v, i) => this.wrapOut(v, `${description}[${i}]`));
    return value as ComResult;
  }

  private wrapIn(value: ComValue | ComObject): ComValue {
    if (value instanceof ComObject) return { __com: value.handle };
    if (Array.isArray(value)) return value.map((v) => this.wrapIn(v as ComValue | ComObject));
    return value;
  }

  async get(object: ComObject, path?: string): Promise<ComResult> {
    const where = path ? `${object}.${path}` : String(object);
    return guarded(this.session.guard, { driver: this.driver, operation: 'com.get', kind: 'read', target: where }, () =>
      adapterStep('desktop-com', 'get', async () => this.wrapOut(await this.session.send({ op: 'com.get', handle: object.handle, ...(path ? { path } : {}) }), where), {
        level: 'debug',
        details: { target: where },
      }),
    );
  }

  async set(object: ComObject, path: string, value: ComValue | ComObject, options: ComCallOptions = {}): Promise<void> {
    const where = `${object}.${path}`;
    await guarded(this.session.guard, { driver: this.driver, operation: 'com.set', kind: options.kind ?? 'update', target: where }, () =>
      adapterStep('desktop-com', 'set', async () => {
        await this.session.send({ op: 'com.set', handle: object.handle, path, value: this.wrapIn(value), secret: options.secret });
      }, { details: { target: where, value: options.secret ? undefined : value instanceof ComObject ? String(value) : value } }),
    );
  }

  async call(object: ComObject, method: string, args: Array<ComValue | ComObject> = [], options: ComCallOptions = {}): Promise<ComResult> {
    const where = `${object}.${method}`;
    return guarded(this.session.guard, { driver: this.driver, operation: 'com.call', kind: options.kind ?? 'update', target: where }, () =>
      adapterStep('desktop-com', `call ${method}`, async () =>
        this.wrapOut(
          await this.session.send({ op: 'com.call', handle: object.handle, method, args: args.map((a) => this.wrapIn(a)), secret: options.secret }),
          where,
        ), {
        details: { target: where, args: options.secret ? undefined : args.map((a) => (a instanceof ComObject ? String(a) : a)) },
      }),
    );
  }

  async release(object: ComObject): Promise<void> {
    if (!this.open.delete(object.handle)) return;
    await this.session.send({ op: 'com.release', handle: object.handle }).catch(() => undefined);
  }

  /** Releases every object this client created or was handed (what a test's cleanup does). */
  async releaseAll(): Promise<void> {
    for (const handle of [...this.open]) {
      this.open.delete(handle);
      await this.session.send({ op: 'com.release', handle }).catch(() => undefined);
    }
  }
}
