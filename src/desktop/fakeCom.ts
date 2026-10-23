import { progIdMatches } from './comAllowList';
import { DesktopTransportError, type ComValue, type DesktopErrorCode } from './types';

/** Thrown by a fake COM method to model an HRESULT failure: ERROR for an ordinary one, SESSION_LOST for a server that died. */
export class FakeComError extends Error {
  constructor(
    message: string,
    readonly code: DesktopErrorCode = 'ERROR',
  ) {
    super(message);
    this.name = 'FakeComError';
  }
}

function fail(message: string, code: DesktopErrorCode = 'ERROR'): never {
  throw new DesktopTransportError(message, code);
}

/**
 * The COM side of the stand-in bridge: ProgID registry, allow-list, object handles and marshalling, the way the PowerShell bridge's
 * com.* operations behave. COM objects are plain JavaScript objects: properties are read, written and methods called by name,
 * case-insensitively (COM member names are case-insensitive); a method may return a promise (a slow `Run`).
 */
export class FakeCom {
  private readonly registry = new Map<string, { progId: string; factory: () => object }>();
  private readonly handles = new Map<string, object>();
  private next = 1;
  /** Every com.create that was ALLOWED through (progId), for assertions. */
  readonly created: string[] = [];
  /** Every com.create that was refused by the allow-list. */
  readonly refused: string[] = [];

  constructor(readonly patterns: string[]) {}

  /** Registers a COM class (what registering a DLL does). */
  register(progId: string, factory: () => object): void {
    this.registry.set(progId.toLowerCase(), { progId, factory });
  }

  get openHandles(): number {
    return this.handles.size;
  }

  create(progId: string): { handle: string } {
    if (!progIdMatches(this.patterns, progId)) {
      this.refused.push(progId);
      fail(`the COM class "${progId}" is not on the allow-list (${this.patterns.join(', ')}). Configure SAS_COM_PROGIDS to allow it.`, 'DENIED');
    }
    const entry = this.registry.get(progId.toLowerCase());
    if (!entry) fail(`the COM class "${progId}" is not registered for this PowerShell. Check the version in the name, and for an older (32-bit) Enterprise Guide start the 32-bit PowerShell (SAS_DESKTOP_POWERSHELL).`, 'NOT_FOUND');
    this.created.push(progId);
    return { handle: this.store(entry.factory()) };
  }

  list(prefix?: string): string[] {
    if (prefix !== undefined && prefix !== '' && !/^[A-Za-z0-9_.]+$/.test(prefix)) fail('the prefix may only contain letters, digits, _ and .');
    return [...this.registry.values()]
      .map((entry) => entry.progId)
      .filter((name) => (prefix ? name.toLowerCase().startsWith(prefix.toLowerCase()) : true) && progIdMatches(this.patterns, name))
      .sort();
  }

  private store(obj: object): string {
    if (this.handles.size >= 2000) fail('too many open COM objects (2000): release the ones you no longer need with com.release');
    const handle = `o${this.next++}`;
    this.handles.set(handle, obj);
    return handle;
  }

  private object(handle: string): object {
    const obj = this.handles.get(handle);
    if (!obj) fail(`unknown COM object handle "${handle}" (released, or never created by this bridge)`, 'NOT_FOUND');
    return obj;
  }

  private member(obj: object, name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`invalid member name "${name}" in the path`);
    const wanted = name.toLowerCase();
    for (let cursor: object | null = obj; cursor && cursor !== Object.prototype; cursor = Object.getPrototypeOf(cursor)) {
      for (const own of Object.getOwnPropertyNames(cursor)) {
        if (own.toLowerCase() === wanted && own !== 'constructor') return own;
      }
    }
    return fail(`Unknown name: ${name}`);
  }

  private read(obj: object, name: string): unknown {
    const key = this.member(obj, name);
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'function') fail(`${key} is a method: use com.call`);
    return value;
  }

  private walk(handle: string, path: string | undefined, includeLast: boolean): unknown {
    let target: unknown = this.object(handle);
    if (!path) return target;
    const segments = path.split('.');
    const count = includeLast ? segments.length : segments.length - 1;
    for (let i = 0; i < count; i++) {
      if (target === null || typeof target !== 'object') fail(`"${segments[i - 1]}" returned nothing: the rest of the path cannot be followed`);
      target = this.read(target as object, segments[i] as string);
      if (target === null || target === undefined) fail(`"${segments[i]}" returned nothing: the rest of the path cannot be followed`);
    }
    return target;
  }

  private out(value: unknown): ComValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((v) => this.out(v));
    if (typeof value === 'object') return { __com: this.store(value as object) };
    return String(value);
  }

  private into(value: unknown): unknown {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && '__com' in (value as object)) return this.object((value as { __com: string }).__com);
    if (Array.isArray(value)) return value.map((v) => this.into(v));
    return value;
  }

  get(handle: string, path?: string): ComValue {
    return this.out(this.walk(handle, path, true));
  }

  set(handle: string, path: string, value: ComValue): null {
    if (!path) fail('com.set needs a property path');
    const target = this.walk(handle, path, false);
    if (target === null || typeof target !== 'object') fail('the path does not lead to an object');
    const last = path.split('.').at(-1) as string;
    const key = this.member(target as object, last);
    (target as Record<string, unknown>)[key] = this.into(value);
    return null;
  }

  async call(handle: string, method: string, args: ComValue[]): Promise<ComValue> {
    if (!method) fail('com.call needs a method name');
    const target = this.walk(handle, method, false);
    if (target === null || typeof target !== 'object') fail('the path does not lead to an object');
    const last = method.split('.').at(-1) as string;
    const key = this.member(target as object, last);
    const fn = (target as Record<string, unknown>)[key];
    if (typeof fn !== 'function') {
      // like InvokeMember with GetProperty: a parameterless "call" of a property reads it
      return this.out(fn);
    }
    try {
      return this.out(await (fn as (...a: unknown[]) => unknown).apply(target, args.map((a) => this.into(a))));
    } catch (error) {
      if (error instanceof DesktopTransportError) throw error;
      if (error instanceof FakeComError) return fail(error.message, error.code);
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  release(handle: string): null {
    this.handles.delete(handle);
    return null;
  }
}
