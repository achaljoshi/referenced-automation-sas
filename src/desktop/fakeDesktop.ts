import { BRIDGE_PROTOCOL_VERSION } from './bridgeProtocol';
import { FakeCom } from './fakeCom';
import {
  DEFAULT_MAX_QUEUE,
  keysToSendKeys,
  normalizeKeys,
  RECORD_MODES,
  secretKindOfName,
  targetWindowOf,
  type Commit,
  type ControlSpec,
  type PathStep,
  type RawEvent,
  type RecordMode,
  type RecordSnapshot,
  type RecordStartResult,
  type SecretKind,
  type Target,
  type TargetWindow,
  type UserAction,
  type WindowSpec,
} from './recording';
import {
  DesktopTransportError,
  type ComValue,
  type DesktopCommand,
  type DesktopErrorCode,
  type DesktopTransport,
  type ElementInfo,
  type EnvironmentInfo,
  type FindCriteria,
  type JavaDiagnosis,
  type Rect,
  type TreeNode,
  type WindowFilter,
  type WindowInfo,
} from './types';

/**
 * An in-memory Windows desktop: processes, top-level windows and UI Automation element trees, answering the bridge protocol like
 * bridge/sas-desktop-bridge.ps1 does. It is the STAND-IN the whole framework is tested against on any machine (fakeApps.ts builds a
 * fake SAS Management Console and a fake Enterprise Guide on it). It models what the framework depends on: controls that appear and
 * become enabled LATER (so auto-waiting is exercised), a busy application (waitForIdle), handles that go stale when a tree is rebuilt
 * (NOT_FOUND), collapsed tree nodes whose children do not exist yet, patterns (Invoke, Value, Toggle, SelectionItem, ExpandCollapse),
 * a locked desktop (SESSION_LOST), password fields whose value is never reported, and the COM allow-list.
 *
 * It is NOT the real thing: it proves the TypeScript side, not that Windows or SAS behave this way. NOT VERIFIED on a real desktop.
 */

export type ToggleState = 'On' | 'Off' | 'Indeterminate';
export type ExpandState = 'Collapsed' | 'Expanded' | 'LeafNode';

/** What happens when something is done to a fake control. Handlers may change the tree (open a dialog, remove a window). */
export interface FakeHandlers {
  invoke?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  /** A real mouse click (used when the element has no Invoke handler: the SendInput fallback). */
  click?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  doubleClick?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  rightClick?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  setValue?: (el: FakeElement, text: string, desktop: FakeDesktop) => void | Promise<void>;
  select?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  expand?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  collapse?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  toggle?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  close?: (el: FakeElement, desktop: FakeDesktop) => void | Promise<void>;
  /** Keys sent to this element (or to the window that contains the focus). */
  keys?: (el: FakeElement, keys: string, desktop: FakeDesktop) => void | Promise<void>;
}

export interface NodeInit {
  controlType: string;
  name?: string;
  automationId?: string;
  className?: string;
  enabled?: boolean;
  offscreen?: boolean;
  isPassword?: boolean;
  /** Presence gives the control a ValuePattern. */
  value?: string;
  readOnly?: boolean;
  toggle?: ToggleState;
  selectable?: boolean;
  selected?: boolean;
  expand?: ExpandState;
  /** The control does not exist for this many ms after it is created (a slow screen). */
  appearAfterMs?: number;
  /** The control exists but is disabled for this many ms after it is created. */
  enableAfterMs?: number;
  rect?: Rect;
  children?: NodeInit[];
  on?: FakeHandlers;
}

let elementCounter = 0;

export class FakeElement {
  readonly ref: string;
  parent?: FakeElement;
  children: FakeElement[] = [];
  removed = false;
  readonly bornAt: number;
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  enabled: boolean;
  offscreen: boolean;
  isPassword: boolean;
  /** The value of a control with a ValuePattern; for a password field it is kept here and never reported. */
  value?: string;
  readOnly: boolean;
  toggleState?: ToggleState;
  selectable: boolean;
  selected: boolean;
  expandState?: ExpandState;
  appearAfterMs: number;
  enableAfterMs: number;
  rect?: Rect;
  focused = false;
  on: FakeHandlers;
  // top-level windows only
  pid = 0;
  process = '';
  hwnd = 0;
  /** Free-form data an application model keeps on its control (never reported). */
  data: Record<string, unknown> = {};

  constructor(init: NodeInit) {
    this.ref = `e${++elementCounter}`;
    this.bornAt = Date.now();
    this.name = init.name ?? '';
    this.automationId = init.automationId ?? '';
    this.controlType = init.controlType;
    this.className = init.className ?? '';
    this.enabled = init.enabled ?? true;
    this.offscreen = init.offscreen ?? false;
    this.isPassword = init.isPassword ?? false;
    this.value = init.value;
    this.readOnly = init.readOnly ?? false;
    this.toggleState = init.toggle;
    this.selectable = init.selectable ?? false;
    this.selected = init.selected ?? false;
    this.expandState = init.expand;
    this.appearAfterMs = init.appearAfterMs ?? 0;
    this.enableAfterMs = init.enableAfterMs ?? 0;
    this.rect = init.rect ?? { x: 10, y: 10, width: 100, height: 24 };
    this.on = init.on ?? {};
    for (const child of init.children ?? []) this.add(child);
  }

  /** Adds (and returns) a child built from `init`. */
  add(init: NodeInit | FakeElement): FakeElement {
    const child = init instanceof FakeElement ? init : new FakeElement(init);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /** Removes this control (and everything below it) from the tree: its handle goes stale. */
  remove(): void {
    this.removed = true;
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
  }

  get topLevel(): FakeElement {
    return this.parent ? this.parent.topLevel : this;
  }

  /** In the tree right now: not removed, its delay has passed, and every ancestor is present and expanded. */
  get present(): boolean {
    if (this.removed) return false;
    if (Date.now() < this.bornAt + this.appearAfterMs) return false;
    if (this.parent) return this.parent.present && this.parent.expandState !== 'Collapsed';
    return true;
  }

  get enabledNow(): boolean {
    return this.enabled && Date.now() >= this.bornAt + this.enableAfterMs;
  }

  /** The visible descendants in document order (children of a collapsed node do not exist). */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      if (el.expandState === 'Collapsed') return;
      for (const child of el.children) {
        if (child.present) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  /** The first descendant (present or not) matching, for building handlers: `window.find(e => e.name === 'OK')`. */
  find(predicate: (el: FakeElement) => boolean): FakeElement | undefined {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const deeper = child.find(predicate);
      if (deeper) return deeper;
    }
    return undefined;
  }

  /** The windows (dialogs) owned by something below this control, deepest first. */
  windowsBelow(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        walk(child);
        if (child.controlType === 'Window') out.push(child);
      }
    };
    walk(this);
    return out;
  }

  patterns(): string[] {
    const p: string[] = [];
    if (this.on.invoke) p.push('Invoke');
    if (this.value !== undefined) p.push('Value');
    if (this.toggleState !== undefined) p.push('Toggle');
    if (this.selectable) p.push('SelectionItem');
    if (this.expandState !== undefined && this.expandState !== 'LeafNode') p.push('ExpandCollapse');
    if (this.controlType === 'Window') p.push('Window');
    return p;
  }
}

export interface FakeProcess {
  pid: number;
  name: string;
  alive: boolean;
  /** The application does not answer input until this time (waitForIdle waits for it). */
  busyUntil: number;
}

export interface FakeProgram {
  /** Process name without .exe. */
  process: string;
  /** Builds the application's windows when it is launched (add them with desktop.addWindow). */
  onLaunch: (desktop: FakeDesktop, process: FakeProcess) => void;
  /** The launched process may differ from the one that owns the window (a launcher): then this is the window's process. */
  windowProcess?: string;
}

export interface FakeDesktopOptions {
  /** Added to every answer (a slow bridge). */
  latencyMs?: number;
  /** The Java Access Bridge facts `environment` / `diagnoseJava` report. Default true. */
  accessBridge?: boolean;
  /** COM class allow-list patterns. Default the bridge's own default. */
  allowProgIds?: string[];
  environment?: Partial<EnvironmentInfo>;
}

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fail(message: string, code: DesktopErrorCode = 'ERROR'): never {
  throw new DesktopTransportError(message, code);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type WithoutT<T> = T extends unknown ? Omit<T, 't'> : never;

/** What the stand-in's recorder keeps while `record.start` is active (the stand-in of the PowerShell recorder's queue and counters). */
interface FakeRecording {
  pids: Set<number>;
  queue: RawEvent[];
  maxQueue: number;
  dropped: number;
  secretKeysDiscarded: number;
  foreignKeysIgnored: number;
  mode: RecordMode;
  startedAtMs: number;
  secretPatterns: RegExp[];
  stopKey?: string;
  stopRequested: boolean;
  /** Virtual time (simulateUserActions with virtualTime): every event advances it; makes recordings deterministic. */
  virtual?: { now: number; stepMs: number };
}

export interface SimulateOptions {
  /** Use a virtual clock (events are `stepMs` apart, `pause` actions advance it, nothing sleeps): recordings come out the same every time. */
  virtualTime?: boolean;
  /** Distance between two events on the virtual clock. Default 120 ms. */
  stepMs?: number;
}

const CONTAINER_TYPES = new Set(['List', 'Tree', 'Tab', 'ComboBox', 'Table', 'DataGrid']);

export class FakeDesktop implements DesktopTransport {
  readonly processes: FakeProcess[] = [];
  readonly windows: FakeElement[] = [];
  readonly com: FakeCom;
  /** Every command received, in order (typed text of secret fields is kept - this is test equipment). */
  readonly calls: DesktopCommand[] = [];
  readonly ownedPids = new Set<number>();
  private readonly programs = new Map<string, FakeProgram>();
  private readonly byRef = new Map<string, FakeElement>();
  private nextPid = 4100;
  private nextHwnd = 0x10000;
  private closed = false;
  locked = false;
  latencyMs: number;
  /** The next N element-targeted requests answer NOT_FOUND once and re-issue the element's handle (a tree rebuild). */
  private staleBudget = 0;
  private staleOps?: ReadonlySet<string>;
  private currentOp = '';
  private readonly accessBridge: boolean;
  private readonly envOverride: Partial<EnvironmentInfo>;
  /** How many screenshots were taken (evidence on/off tests). */
  screenshots = 0;
  private rec?: FakeRecording;

  constructor(options: FakeDesktopOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.accessBridge = options.accessBridge ?? true;
    this.envOverride = options.environment ?? {};
    this.com = new FakeCom(options.allowProgIds ?? ['SASEGObjectModel.Application.*', 'SASObjectManager.*']);
  }

  // ------------------------------------------------------------------------------------------------- building

  /** Registers a program `launch` can start (by its path). */
  registerProgram(path: string, program: FakeProgram): void {
    this.programs.set(path.toLowerCase(), program);
  }

  addProcess(name: string): FakeProcess {
    const process_ = { pid: this.nextPid++, name, alive: true, busyUntil: 0 };
    this.processes.push(process_);
    return process_;
  }

  /** Adds a top-level window (a Window control) owned by `process_`. */
  addWindow(process_: FakeProcess, init: Omit<NodeInit, 'controlType'> & { title: string }): FakeElement {
    const { title, ...rest } = init;
    const window = new FakeElement({ controlType: 'Window', className: 'Window', ...rest, name: title });
    window.pid = process_.pid;
    window.process = process_.name;
    window.hwnd = this.nextHwnd++;
    this.windows.push(window);
    this.index(window);
    this.emitWindow('windowOpened', window);
    return window;
  }

  /** Creates a control (and its children) that is not attached yet; attach it with `parent.add(el)` and index it with `desktop.adopt(el)`. */
  create(init: NodeInit): FakeElement {
    const el = new FakeElement(init);
    this.index(el);
    return el;
  }

  /** Makes a control (built by `parent.add(init)`) addressable by handle. Handlers do this through `attach`. */
  adopt(el: FakeElement): FakeElement {
    this.index(el);
    return el;
  }

  /** Adds `init` below `parent` and indexes it and its children. */
  attach(parent: FakeElement, init: NodeInit): FakeElement {
    const el = parent.add(init);
    this.index(el);
    if (el.controlType === 'Window') this.emitWindow('windowOpened', el);
    return el;
  }

  private index(el: FakeElement): void {
    this.byRef.set(el.ref, el);
    for (const child of el.children) this.index(child);
  }

  /** Removes a window or control (a dialog closing). Its handles go stale. */
  dispose(el: FakeElement): void {
    for (const gone of [...el.windowsBelow(), ...(el.controlType === 'Window' ? [el] : [])]) this.emitWindow('windowClosed', gone);
    el.remove();
    const at = this.windows.indexOf(el);
    if (at >= 0) this.windows.splice(at, 1);
    const drop = (e: FakeElement) => {
      e.removed = true;
      this.byRef.delete(e.ref);
      e.children.forEach(drop);
    };
    drop(el);
  }

  /** Marks the application as unresponsive for `ms` (waitForIdle waits). */
  busyFor(process_: FakeProcess, ms: number): void {
    process_.busyUntil = Math.max(process_.busyUntil, Date.now() + ms);
  }

  /**
   * The next `count` requests of the given operations (default: the acting and reading ones, not `find` / `children` / `tree`) answer
   * NOT_FOUND once (the application rebuilt its tree), after which the control has a new handle.
   */
  injectStale(count: number, ops: DesktopCommand['op'][] = ['click', 'doubleClick', 'rightClick', 'setText', 'select', 'expand', 'collapse', 'toggle', 'info', 'getText', 'focus', 'sendKeys']): void {
    this.staleBudget = count;
    this.staleOps = new Set(ops);
  }

  /** The workstation is locked / the session disconnected: UI operations answer SESSION_LOST. */
  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  windowsOf(pid: number): FakeElement[] {
    return this.windows.filter((w) => w.pid === pid && w.present);
  }

  findWindow(titleRegex: RegExp): FakeElement | undefined {
    return this.windows.find((w) => w.present && titleRegex.test(w.name));
  }

  // ------------------------------------------------------------------------------------------------- the protocol

  async request(command: DesktopCommand): Promise<unknown> {
    if (this.closed) fail('the fake desktop is closed', 'BRIDGE_EXITED');
    this.calls.push(command);
    this.currentOp = command.op;
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return this.dispatch(command);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rec = undefined;
  }

  private guardDesktop(): void {
    if (this.locked) fail('the desktop is locked or the session is disconnected: UI Automation needs an unlocked, connected interactive session', 'SESSION_LOST');
  }

  private element(ref: string | undefined | null, options: { allowStale?: boolean } = {}): FakeElement {
    this.guardDesktop();
    const el = ref ? this.byRef.get(ref) : undefined;
    if (!el || el.removed || !this.isReachable(el)) fail(`the control "${ref ?? ''}" is gone (its window was closed or the tree was rebuilt)`, 'NOT_FOUND');
    if (this.staleBudget > 0 && !options.allowStale && (this.staleOps?.has(this.currentOp) ?? true)) {
      this.staleBudget--;
      this.byRef.delete(el.ref);
      // A rebuilt tree gives the control a new handle: replace the (readonly) ref by re-registering a fresh alias.
      const fresh = `e${++elementCounter}`;
      (el as { ref: string }).ref = fresh;
      this.byRef.set(fresh, el);
      fail(`the control "${ref}" is gone (its window was closed or the tree was rebuilt)`, 'NOT_FOUND');
    }
    return el;
  }

  /** A control whose window is gone or which is below a collapsed node is no longer addressable. */
  private isReachable(el: FakeElement): boolean {
    let cursor: FakeElement | undefined = el;
    while (cursor) {
      if (cursor.removed) return false;
      cursor = cursor.parent;
    }
    return true;
  }

  private process_(pid: number): FakeProcess | undefined {
    return this.processes.find((p) => p.pid === pid);
  }

  private info(el: FakeElement, full: boolean): ElementInfo {
    const base: ElementInfo = {
      ref: el.ref,
      name: el.name,
      automationId: el.automationId,
      controlType: el.controlType,
      className: el.className,
      enabled: el.enabledNow,
      offscreen: el.offscreen,
      isPassword: el.isPassword,
      pid: el.topLevel.pid,
    };
    if (el.rect) base.rect = el.rect;
    if (!full) return base;
    base.focused = el.focused;
    base.patterns = el.patterns();
    if (el.value !== undefined) base.value = el.isPassword ? '' : el.value;
    if (el.toggleState !== undefined) base.toggleState = el.toggleState;
    if (el.selectable) base.selected = el.selected;
    if (el.expandState !== undefined) base.expandState = el.expandState;
    return base;
  }

  private windowInfo(el: FakeElement): WindowInfo {
    return { ...this.info(el, false), process: el.process, hwnd: el.hwnd };
  }

  private windowMatches(el: FakeElement, filter: WindowFilter): boolean {
    if (filter.pid !== undefined && el.pid !== filter.pid) return false;
    if (filter.processName !== undefined && el.process.toLowerCase() !== filter.processName.replace(/\.exe$/i, '').toLowerCase()) return false;
    if (filter.titleRegex !== undefined && !new RegExp(filter.titleRegex, 'i').test(el.name)) return false;
    return true;
  }

  private matches(el: FakeElement, c: FindCriteria): boolean {
    if (c.name !== undefined && el.name !== c.name) return false;
    if (c.nameContains !== undefined && !el.name.toLowerCase().includes(c.nameContains.toLowerCase())) return false;
    if (c.nameRegex && !new RegExp(c.nameRegex.pattern, c.nameRegex.ignoreCase ? 'i' : '').test(el.name)) return false;
    if (c.automationId !== undefined && el.automationId !== c.automationId) return false;
    if (c.controlType !== undefined && el.controlType.toLowerCase() !== c.controlType.replace(/^ControlType\./i, '').toLowerCase()) return false;
    if (c.className !== undefined && el.className !== c.className) return false;
    if (c.visibleOnly && el.offscreen) return false;
    if (c.text !== undefined) {
      const text = el.isPassword ? '' : (el.value ?? el.name);
      if (!text.toLowerCase().includes(c.text.toLowerCase())) return false;
    }
    return true;
  }

  private async dispatch(command: DesktopCommand): Promise<unknown> {
    switch (command.op) {
      case 'ping':
        return { bridge: 'sas-desktop-bridge', version: BRIDGE_PROTOCOL_VERSION, powershell: 'fake', is64BitProcess: true, pid: 0 };
      case 'windows': {
        this.guardDesktop();
        return this.windows.filter((w) => w.present && this.windowMatches(w, command)).map((w) => this.windowInfo(w));
      }
      case 'launch':
        return this.launch(command);
      case 'attach': {
        this.guardDesktop();
        const found = this.windows.filter((w) => w.present && w.name !== '' && this.windowMatches(w, command));
        const best = found.find((w) => !w.offscreen) ?? found[0];
        if (!best) fail('no top-level window matches (is the application running in this desktop session?)', 'NOT_FOUND');
        this.ownedPids.add(best.pid);
        return { pid: best.pid, process: best.process, window: this.windowInfo(best) };
      }
      case 'find': {
        this.guardDesktop();
        const root = command.root ? this.element(command.root) : undefined;
        const candidates = root
          ? command.criteria.scope === 'children'
            ? root.children.filter((c) => c.present)
            : root.descendants()
          : command.criteria.scope === 'children'
            ? this.windows.filter((w) => w.present)
            : this.windows.filter((w) => w.present).flatMap((w) => [w, ...w.descendants()]);
        const limit = command.limit ?? 50;
        const hits = candidates.filter((el) => this.matches(el, command.criteria));
        if (command.criteria.nth !== undefined) {
          const one = hits[command.criteria.nth];
          return one ? [this.info(one, false)] : [];
        }
        return hits.slice(0, limit).map((el) => this.info(el, false));
      }
      case 'children':
        return this.element(command.ref)
          .children.filter((c) => c.present)
          .map((c) => this.info(c, false));
      case 'info':
        return this.info(this.element(command.ref), true);
      case 'getText': {
        const el = this.element(command.ref);
        return el.isPassword ? '' : (el.value ?? el.name);
      }
      case 'invoke':
      case 'click': {
        const el = this.element(command.ref);
        this.requireEnabled(el);
        if (el.on.invoke) {
          await el.on.invoke(el, this);
          return 'done';
        }
        if (command.op === 'invoke') fail('the control does not support the Invoke pattern (use click)');
        if (el.toggleState !== undefined && !el.on.click) await this.flip(el);
        else await el.on.click?.(el, this);
        return 'mouse';
      }
      case 'doubleClick': {
        const el = this.element(command.ref);
        this.requireEnabled(el);
        await el.on.doubleClick?.(el, this);
        return 'mouse';
      }
      case 'rightClick': {
        const el = this.element(command.ref);
        await el.on.rightClick?.(el, this);
        return 'mouse';
      }
      case 'setText': {
        const el = this.element(command.ref);
        this.requireEnabled(el);
        if (el.value === undefined || el.readOnly) {
          if (!el.on.setValue) fail('the control cannot take text (no writable Value pattern)');
        }
        el.value = command.text;
        await el.on.setValue?.(el, command.text, this);
        return 'ValuePattern';
      }
      case 'select': {
        const el = this.element(command.ref);
        this.requireEnabled(el);
        if (el.selectable) {
          if (!command.add) for (const sibling of el.parent?.children ?? []) sibling.selected = false;
          el.selected = true;
          await el.on.select?.(el, this);
          return 'SelectionItemPattern';
        }
        await el.on.click?.(el, this);
        return 'mouse';
      }
      case 'expand': {
        const el = this.element(command.ref);
        if (el.expandState === undefined || el.expandState === 'LeafNode') fail('the control does not support Expand/Collapse');
        el.expandState = 'Expanded';
        await el.on.expand?.(el, this);
        return null;
      }
      case 'collapse': {
        const el = this.element(command.ref);
        if (el.expandState === undefined || el.expandState === 'LeafNode') fail('the control does not support Expand/Collapse');
        el.expandState = 'Collapsed';
        await el.on.collapse?.(el, this);
        return null;
      }
      case 'toggle': {
        const el = this.element(command.ref);
        this.requireEnabled(el);
        if (el.toggleState === undefined) fail('the control does not support the Toggle pattern');
        if (command.state === undefined) await this.flip(el);
        else {
          const target: ToggleState = command.state ? 'On' : 'Off';
          for (let i = 0; i < 3 && el.toggleState !== target; i++) await this.flip(el);
        }
        return el.toggleState;
      }
      case 'scrollIntoView':
        this.element(command.ref);
        return null;
      case 'focus': {
        const el = this.element(command.ref);
        this.setFocus(el);
        return null;
      }
      case 'sendKeys': {
        this.guardDesktop();
        const el = command.ref ? this.element(command.ref) : this.focusedElement();
        if (el && command.ref) this.setFocus(el);
        const target = el ?? this.windows[0];
        if (!target) fail('there is no window to send keys to', 'NOT_FOUND');
        await (el?.on.keys ?? target.topLevel.on.keys)?.(el ?? target, command.keys, this);
        return null;
      }
      case 'waitForIdle': {
        this.guardDesktop();
        if (command.pid === undefined) return { idle: true };
        const p = this.process_(command.pid);
        if (!p || !p.alive) fail(`there is no process with id ${command.pid}`, 'SESSION_LOST');
        const deadline = Date.now() + (command.timeoutMs ?? 5000);
        while (Date.now() < p.busyUntil && Date.now() < deadline) await sleep(5);
        return { idle: Date.now() >= p.busyUntil };
      }
      case 'screenshot': {
        this.guardDesktop();
        if (command.ref) this.element(command.ref);
        this.screenshots++;
        return { pngBase64: PNG_1X1, width: 1, height: 1 };
      }
      case 'tree': {
        this.guardDesktop();
        const maxDepth = command.depth ?? 4;
        const maxNodes = command.maxNodes ?? 400;
        const out: TreeNode[] = [];
        const walk = (el: FakeElement, depth: number) => {
          for (const child of el.expandState === 'Collapsed' ? [] : el.children) {
            if (out.length >= maxNodes) return;
            if (!child.present) continue;
            out.push({ ...this.info(child, false), depth });
            if (depth + 1 < maxDepth) walk(child, depth + 1);
          }
        };
        if (command.ref) walk(this.element(command.ref), 0);
        else {
          for (const w of this.windows.filter((x) => x.present && (command.pid === undefined || x.pid === command.pid))) {
            if (out.length >= maxNodes) break;
            out.push({ ...this.info(w, false), depth: 0 });
            if (maxDepth > 1) walk(w, 1);
          }
        }
        return out;
      }
      case 'close': {
        const el = this.element(command.ref);
        if (el.controlType !== 'Window') fail('the element is not a window (no Window pattern)');
        if (el.on.close) await el.on.close(el, this);
        else this.dispose(el);
        // closing the last window of a program ends the program
        const owner = this.process_(el.topLevel.pid);
        if (owner && this.windowsOf(owner.pid).length === 0 && !this.windows.some((w) => w.pid === owner.pid)) owner.alive = false;
        return null;
      }
      case 'kill': {
        const targets = this.processes.filter(
          (p) => p.alive && (command.pid !== undefined ? p.pid === command.pid : command.processName !== undefined && p.name.toLowerCase() === command.processName.replace(/\.exe$/i, '').toLowerCase()),
        );
        if (command.pid === undefined && command.processName === undefined) fail('kill needs a pid or a processName');
        let killed = 0;
        for (const p of targets) {
          if (!this.ownedPids.has(p.pid)) fail(`refusing to stop process ${p.pid}: this bridge did not launch it or attach to it`, 'DENIED');
          p.alive = false;
          for (const w of this.windows.filter((x) => x.pid === p.pid)) this.dispose(w);
          killed++;
        }
        return { killed };
      }
      case 'diagnoseJava':
        return this.diagnoseJava(command.pid);
      case 'environment':
        return this.environment();
      case 'com.create':
        return this.com.create(command.progId);
      case 'com.get':
        return this.com.get(command.handle, command.path);
      case 'com.set':
        return this.com.set(command.handle, command.path, command.value as ComValue);
      case 'com.call':
        return this.com.call(command.handle, command.method, (command.args ?? []) as ComValue[]);
      case 'com.release':
        return this.com.release(command.handle);
      case 'com.list':
        return this.com.list(command.prefix);
      case 'record.start':
        return this.recordStart(command);
      case 'record.events':
        return this.recordSnapshot(command.drain !== false, false);
      case 'record.stop':
        return this.recordSnapshot(true, true);
      case 'quit':
        return null;
      default:
        return fail(`unknown operation "${(command as { op: string }).op}"`);
    }
  }

  private requireEnabled(el: FakeElement): void {
    if (!el.enabledNow) fail('the control is not enabled');
  }

  private async flip(el: FakeElement): Promise<void> {
    el.toggleState = el.toggleState === 'On' ? 'Off' : 'On';
    await el.on.toggle?.(el, this);
  }

  private setFocus(el: FakeElement): void {
    for (const w of this.windows) this.clearFocus(w);
    el.focused = true;
  }

  private clearFocus(el: FakeElement): void {
    el.focused = false;
    el.children.forEach((c) => this.clearFocus(c));
  }

  private focusedElement(): FakeElement | undefined {
    for (const w of [...this.windows].reverse()) {
      const hit = w.focused ? w : w.find((e) => e.focused);
      if (hit) return hit;
    }
    return undefined;
  }

  private async launch(command: Extract<DesktopCommand, { op: 'launch' }>): Promise<unknown> {
    this.guardDesktop();
    const program = this.programs.get(command.path.toLowerCase());
    if (!program) fail(`the program to launch does not exist: ${command.path}`);
    const before = new Set(this.windows);
    const started = this.addProcess(program.process);
    this.ownedPids.add(started.pid);
    program.onLaunch(this, started);
    if (!command.waitForWindow) return { pid: started.pid, process: started.name };
    const { titleRegex, timeoutMs = 60_000 } = command.waitForWindow;
    const rx = titleRegex ? new RegExp(titleRegex, 'i') : undefined;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.windows.find((w) => !before.has(w) && w.present && (rx ? rx.test(w.name) : w.pid === started.pid));
      if (hit) {
        this.ownedPids.add(hit.pid);
        return { pid: hit.pid, process: hit.process, window: this.windowInfo(hit) };
      }
      if (Date.now() >= deadline) fail(`the program started but no window appeared within ${timeoutMs} ms${titleRegex ? ` (title matching ${titleRegex})` : ''}`, 'NOT_FOUND');
      await sleep(5);
    }
  }

  // ------------------------------------------------------------------------------------------------- recording (the stand-in's recorder)

  /** True between `record.start` and `record.stop`. */
  get recording(): boolean {
    return this.rec !== undefined;
  }

  private now(): number {
    const rec = this.rec as FakeRecording;
    if (!rec.virtual) return Date.now() - rec.startedAtMs;
    const t = rec.virtual.now;
    rec.virtual.now += rec.virtual.stepMs;
    return t;
  }

  /** Queues an event stamped with the clock; a full queue drops it and counts it. */
  private emit(event: WithoutT<RawEvent>, at?: number): void {
    const rec = this.rec;
    if (!rec) return;
    if (rec.queue.length >= rec.maxQueue) {
      rec.dropped++;
      return;
    }
    rec.queue.push({ ...event, t: at ?? this.now() } as RawEvent);
  }

  private inScope(el: FakeElement): boolean {
    return this.rec?.pids.has(el.topLevel.pid) === true;
  }

  private emitWindow(type: 'windowOpened' | 'windowClosed' | 'windowActivated', window: FakeElement, at?: number): void {
    if (!this.rec || !this.inScope(window)) return;
    this.emit(
      {
        type,
        title: window.name,
        ...(window.className ? { className: window.className } : {}),
        process: window.topLevel.process,
        ...(window.parent ? { owned: true } : {}),
      },
      at,
    );
  }

  private windowOf(el: FakeElement): FakeElement {
    let cursor: FakeElement = el;
    while (cursor.controlType !== 'Window' && cursor.parent) cursor = cursor.parent;
    return cursor;
  }

  private targetWindowOf_(window: FakeElement): TargetWindow {
    return targetWindowOf(window.name, window.className);
  }

  /** The locator candidate chain of a control, as the real recorder builds it from UI Automation. */
  private targetOf(el: FakeElement): Target {
    const window = this.windowOf(el);
    const chain: FakeElement[] = [];
    for (let cursor: FakeElement | undefined = el; cursor && cursor !== window; cursor = cursor.parent) chain.unshift(cursor);
    const inWindow = window.descendants();
    const path: PathStep[] = chain.map((c) => {
      const step: PathStep = {};
      if (c.controlType) step.controlType = c.controlType;
      if (c.name) step.name = c.name;
      if (c.automationId) step.automationId = c.automationId;
      if (c.className) step.className = c.className;
      if (!c.name && !c.automationId) {
        const same = inWindow.filter((o) => o.controlType === c.controlType && o.className === c.className);
        step.index = Math.max(0, same.indexOf(c));
      }
      return step;
    });
    const target: Target = { window: this.targetWindowOf_(window), path };
    if (el !== window) {
      const unique: NonNullable<Target['unique']> = {};
      if (el.automationId) unique.automationId = inWindow.filter((o) => o.automationId === el.automationId).length === 1;
      if (el.name) unique.nameAndType = inWindow.filter((o) => o.name === el.name && o.controlType === el.controlType).length === 1;
      if (Object.keys(unique).length > 0) target.unique = unique;
    }
    if (el.rect && window.rect) {
      const bounds = { x: el.rect.x - window.rect.x, y: el.rect.y - window.rect.y, width: el.rect.width, height: el.rect.height };
      target.bounds = bounds;
      target.fallbackPoint = { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) };
    }
    return target;
  }

  private isSecretControl(el: FakeElement): SecretKind | undefined {
    const rec = this.rec as FakeRecording;
    const byName = secretKindOfName(el.name, el.automationId);
    if (byName) return byName;
    if (rec.secretPatterns.some((rx) => rx.test(el.name) || rx.test(el.automationId))) return 'secret';
    return el.isPassword ? 'password' : undefined;
  }

  private recordStart(command: Extract<DesktopCommand, { op: 'record.start' }>): RecordStartResult {
    this.guardDesktop();
    if (this.rec) fail('already recording: stop the running recording first (record.stop)');
    if (command.pid === undefined && command.processName === undefined && command.titleRegex === undefined) {
      fail('record.start needs a target - a pid, a processName or a titleRegex: the recorder never records without a chosen program');
    }
    const mode = command.mode ?? 'full';
    if (!(RECORD_MODES as readonly string[]).includes(mode)) fail(`record.start: mode must be one of ${RECORD_MODES.join(', ')} (found "${String(mode)}")`);
    const maxQueue = command.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isInteger(maxQueue) || maxQueue < 1) fail('record.start: maxQueue must be a positive whole number');
    const secretPatterns = (command.secretPatterns ?? []).map((pattern) => {
      try {
        return new RegExp(pattern, 'i');
      } catch {
        return fail(`record.start: secretPatterns entry "${pattern}" is not a valid regular expression`);
      }
    });
    let stopKey: string | undefined;
    if (command.stopKey !== undefined) {
      stopKey = normalizeKeys(command.stopKey);
      if (stopKey === undefined) fail(`record.start: stopKey "${command.stopKey}" is not a key chord such as Ctrl+Alt+Q`);
    }
    const targets = this.windows.filter((w) => w.present && w.name !== '' && this.windowMatches(w, command));
    const first = targets[0];
    if (!first) fail('record.start: no window of the chosen program is open - start the program first, then the recorder', 'NOT_FOUND');
    const pids = [...new Set(targets.map((w) => w.pid))];
    const startedAtMs = Date.now();
    this.rec = { pids: new Set(pids), queue: [], maxQueue, dropped: 0, secretKeysDiscarded: 0, foreignKeysIgnored: 0, mode, startedAtMs, secretPatterns, stopKey, stopRequested: false };
    let windows = 0;
    for (const w of this.windows.filter((x) => pids.includes(x.pid) && x.present)) {
      this.emitWindow('windowOpened', w, 0); // already open when the recording starts: time 0
      windows++;
      for (const nested of w.descendants().filter((d) => d.controlType === 'Window')) {
        this.emitWindow('windowOpened', nested, 0);
        windows++;
      }
    }
    return { pid: first.pid, pids, process: first.process, windows, mode, startedAt: new Date(startedAtMs).toISOString(), maxQueue };
  }

  private recordSnapshot(drain: boolean, stopping: boolean): RecordSnapshot {
    const rec = this.rec;
    if (!rec) {
      if (stopping) return { events: [], dropped: 0, secretKeysDiscarded: 0, foreignKeysIgnored: 0, recording: false, targetAlive: false, stopRequested: false, queued: 0, durationMs: 0 };
      fail('not recording: start the recorder first (record.start)');
    }
    this.guardDesktop();
    const events = drain ? rec.queue.splice(0, rec.queue.length) : [...rec.queue];
    const snapshot: RecordSnapshot = {
      events,
      dropped: rec.dropped,
      secretKeysDiscarded: rec.secretKeysDiscarded,
      foreignKeysIgnored: rec.foreignKeysIgnored,
      recording: !stopping,
      targetAlive: this.windows.some((w) => w.present && rec.pids.has(w.pid)),
      stopRequested: rec.stopRequested,
      queued: rec.queue.length,
      ...(stopping ? { durationMs: rec.virtual ? rec.virtual.now : Date.now() - rec.startedAtMs } : {}),
    };
    if (stopping) this.rec = undefined;
    return snapshot;
  }

  // ---- a person at the keyboard and mouse

  /**
   * Performs what a person would do - on the fake programs, through the same handlers the framework's own steps reach - AND reports the raw
   * events the real recorder would report, so the recorder's whole TypeScript side (coalescing, the file, the converter) is tested without
   * Windows. Needs `record.start` first. Windows of programs that are not being recorded are acted on silently (the recorder never sees them),
   * and a password typed anywhere reaches the fake program but leaves nothing but `secret: true` in the events. NOT the real recorder.
   */
  async simulateUserActions(actions: UserAction[], options: SimulateOptions = {}): Promise<void> {
    const rec = this.rec;
    if (!rec) fail('not recording: start the recorder first (record.start), then simulate what the user does');
    if (options.virtualTime) rec.virtual = rec.virtual ?? { now: 0, stepMs: options.stepMs ?? 120 };
    for (const action of actions) await this.userAction(action);
  }

  private windowForSpec(spec: WindowSpec): FakeElement {
    const rx = typeof spec === 'string' ? new RegExp(spec, 'i') : spec;
    const all = this.windows.filter((w) => w.present).flatMap((w) => [w, ...w.descendants().filter((d) => d.controlType === 'Window')]);
    const hits = all.filter((w) => rx.test(w.name));
    const window = hits[hits.length - 1];
    if (!window) fail(`simulateUserActions: no window with a title matching ${String(spec)} (open: ${all.map((w) => `"${w.name}"`).join(', ') || 'none'})`, 'NOT_FOUND');
    return window;
  }

  private controlForSpec(spec: ControlSpec): { el: FakeElement; window: FakeElement } {
    const window = this.windowForSpec(spec.window);
    const criteria: FindCriteria = typeof spec.find === 'string' ? { name: spec.find } : spec.find;
    const hits = window.descendants().filter((el) => el.controlType !== 'Window' || criteria.controlType !== undefined).filter((el) => this.matches(el, criteria));
    if (hits.length > 1 && spec.nth === undefined) fail(`simulateUserActions: ${JSON.stringify(criteria)} matches ${hits.length} controls in "${window.name}" - say which with nth`);
    const el = hits[spec.nth ?? 0];
    if (!el) fail(`simulateUserActions: no control ${JSON.stringify(criteria)} in window "${window.name}"`, 'NOT_FOUND');
    return { el, window };
  }

  private async userAction(action: UserAction): Promise<void> {
    const rec = this.rec as FakeRecording;
    switch (action.do) {
      case 'pause': {
        if (rec.virtual) rec.virtual.now += action.ms;
        else await sleep(action.ms);
        return;
      }
      case 'key': {
        const window = this.windowForSpec(action.window);
        const keys = normalizeKeys(action.keys);
        if (keys === undefined) fail(`simulateUserActions: "${action.keys}" is not a key chord`);
        const sendKeys = keysToSendKeys(keys);
        if (sendKeys === undefined) fail(`simulateUserActions: "${keys}" cannot be sent with SendKeys`);
        if (rec.stopKey === keys) rec.stopRequested = true; // the stop chord is seen in any window (and recorded in none)
        else if (this.inScope(window)) this.emit({ type: 'key', keys, window: this.targetWindowOf_(window) });
        else rec.foreignKeysIgnored++;
        await this.dispatch({ op: 'sendKeys', ref: window.ref, keys: sendKeys });
        return;
      }
      case 'click':
      case 'doubleClick':
      case 'rightClick': {
        const { el } = this.controlForSpec(action);
        const scope = this.inScope(el);
        const target = scope ? this.targetOf(el) : undefined;
        if (target) this.emit({ type: action.do, target });
        if (action.do === 'click' && el.selectable) {
          await this.dispatch({ op: 'select', ref: el.ref });
          if (target) this.emit({ type: 'selected', target, container: this.containerTargetOf(el) });
          return;
        }
        const before = el.toggleState;
        // UI Automation raises the invoke right after the click, before what the control does (a dialog opening) shows up
        if (target && action.do === 'click' && el.on.invoke && el.enabledNow) this.emit({ type: 'invoke', target });
        await this.dispatch({ op: action.do, ref: el.ref });
        if (target && action.do === 'click' && el.toggleState !== undefined && el.toggleState !== before) this.emit({ type: 'toggled', target, state: el.toggleState === 'On' });
        return;
      }
      case 'type': {
        const { el, window } = this.controlForSpec(action);
        const scope = this.inScope(el);
        const secret = this.isSecretControl(el);
        const target = scope ? this.targetOf(el) : undefined;
        if (target) this.emit({ type: 'click', target });
        await this.dispatch({ op: 'focus', ref: el.ref });
        if (secret) {
          rec.secretKeysDiscarded += action.text.length;
          if (target) this.emit({ type: 'typed', target, secret: true, secretKind: secret });
        } else if (target) {
          for (let i = 1; i <= action.text.length; i++) this.emit({ type: 'typed', target, value: action.text.slice(0, i) });
        }
        await this.dispatch({ op: 'setText', ref: el.ref, text: action.text, secret: secret !== undefined });
        const commit: Commit = action.commit ?? 'blur';
        if (commit !== 'blur') {
          const keys = commit === 'enter' ? 'Enter' : 'Tab';
          if (scope) this.emit({ type: 'key', keys, window: this.targetWindowOf_(window) });
          await this.dispatch({ op: 'sendKeys', ref: el.ref, keys: commit === 'enter' ? '{ENTER}' : '{TAB}' });
        }
        return;
      }
      case 'select': {
        const { el } = this.controlForSpec(action);
        const target = this.inScope(el) ? this.targetOf(el) : undefined;
        if (target) this.emit({ type: 'click', target });
        await this.dispatch({ op: 'select', ref: el.ref });
        if (target) this.emit({ type: 'selected', target, container: this.containerTargetOf(el) });
        return;
      }
      case 'toggle': {
        const { el } = this.controlForSpec(action);
        if (el.toggleState === undefined) fail('simulateUserActions: the control cannot be toggled');
        if (action.state !== undefined && (el.toggleState === 'On') === action.state) return; // already so: a person would not click
        const target = this.inScope(el) ? this.targetOf(el) : undefined;
        if (target) this.emit({ type: 'click', target });
        await this.dispatch({ op: 'toggle', ref: el.ref });
        if (target) this.emit({ type: 'toggled', target, state: el.toggleState === 'On' });
        return;
      }
      case 'expand':
      case 'collapse': {
        const { el } = this.controlForSpec(action);
        const target = this.inScope(el) ? this.targetOf(el) : undefined;
        if (target) this.emit({ type: 'click', target });
        await this.dispatch({ op: action.do, ref: el.ref });
        if (target) this.emit({ type: action.do === 'expand' ? 'expanded' : 'collapsed', target });
        return;
      }
    }
  }

  /** The list / tree / tab strip / table a selectable item belongs to (SelectionItemPattern.SelectionContainer), else its parent. */
  private containerTargetOf(item: FakeElement): Target | undefined {
    let cursor = item.parent;
    while (cursor && !CONTAINER_TYPES.has(cursor.controlType) && cursor.controlType !== 'Window') cursor = cursor.parent;
    const container = cursor ?? item.parent;
    return container && container.controlType !== 'Window' ? this.targetOf(container) : undefined;
  }

  private diagnoseJava(pid?: number): JavaDiagnosis {
    const windows = this.windows
      .filter((w) => w.present && (pid === undefined || w.pid === pid) && (w.className.startsWith('SunAwt') || ['java', 'javaw', 'sasmc'].includes(w.process.toLowerCase())))
      .map((w) => {
        const count = this.contentCount(w);
        return {
          title: w.name,
          pid: w.pid,
          process: w.process,
          className: w.className,
          isJava: true,
          elementCount: count,
          suspectedBridgeMissing: count < 3,
        };
      });
    return { windows, accessBridgeDll: this.accessBridge, accessibilityProperties: this.accessBridge };
  }

  private contentCount(window: FakeElement): number {
    let count = 0;
    const walk = (el: FakeElement) => {
      for (const child of el.expandState === 'Collapsed' ? [] : el.children) {
        if (!child.present || child.controlType === 'TitleBar') continue;
        count++;
        walk(child);
      }
    };
    walk(window);
    return count;
  }

  private environment(): EnvironmentInfo {
    return {
      powershell: '5.1.fake',
      is64BitProcess: true,
      is64BitOS: true,
      os: 'Windows (stand-in)',
      userInteractive: true,
      sessionName: 'Console',
      desktopAccessible: !this.locked,
      uiaAvailable: true,
      topLevelWindows: this.windows.filter((w) => w.present).length,
      elevated: false,
      accessBridgeDll: this.accessBridge,
      accessibilityProperties: this.accessBridge,
      jabswitch: this.accessBridge ? ['C:\\Program Files\\SASHome\\SASPrivateJavaRuntimeEnvironment\\9.4\\jre\\bin\\jabswitch.exe'] : [],
      allowedProgIds: this.com.patterns,
      ...this.envOverride,
    };
  }
}
