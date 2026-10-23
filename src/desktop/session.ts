import * as fs from 'node:fs';
import * as path from 'node:path';
import { adapterStep, AdapterError, getLogger, type Adapter } from '@automation/referenced-automation-utils';
import { DEFAULT_EVIDENCE_DIR, type EvidenceMode } from './config';
import { guarded, permissiveGuard, type GuardedOperation, type OperationGuard } from './guard';
import { DesktopLocator, titleMatcher, WindowLocator, type LocatorSelector } from './locator';
import { describeCommand } from './secrets';
import {
  DesktopTransportError,
  type AttachResult,
  type DesktopCommand,
  type DesktopTransport,
  type ElementInfo,
  type LaunchResult,
  type PingResult,
  type ScreenshotResult,
  type WindowFilter,
  type WindowInfo,
} from './types';

const log = getLogger('desktop-ui');
const JOURNAL_LIMIT = 300;

export interface DesktopSessionOptions {
  /** How long any single step may wait for its control / for the application to go idle. Default 30 s (SAS_DESKTOP_TIMEOUT_MS). */
  timeoutMs?: number;
  /** How often to look while waiting. Default 100 ms. */
  pollMs?: number;
  /** How many times a step is repeated when its control vanished mid-transition (a NOT_FOUND from the bridge). Default 5. */
  retryRounds?: number;
  /** Where evidence screenshots are written. Default test-results/sas-desktop-evidence (SAS_DESKTOP_EVIDENCE_DIR). */
  evidenceDir?: string;
  /** 'steps' also takes a screenshot after every step that may change something (SAS_DESKTOP_EVIDENCE=steps). Evidence you ask for is always taken. Default 'off'. */
  evidence?: EvidenceMode;
  /** What to do when a locator's primary is missing but an `orElse` alternative finds the control: 'report' (use it, record the drift - default) or 'off' (ignore alternatives). */
  fallbacks?: 'report' | 'off';
  /** The policy gate every mutating step goes through. Default: allows everything. */
  guard?: OperationGuard;
  /** The `driver` name the guard is told. Default 'desktop-ui'. */
  driver?: string;
}

/** One line of the step journal: what the session did, how long it took, whether it worked. */
export interface JournalEntry {
  at: number;
  label: string;
  target: string;
  ms: number;
  ok: boolean;
  error?: string;
}

/** A control found by a fallback because its usual locator no longer matched. */
export interface LocatorDrift {
  expected: string;
  usedFallback: string;
  /** What was actually found (control type, name, id): what to put in the LOCATORS table. */
  found: string;
}

export interface ActOptions {
  kind: GuardedOperation['kind'];
  /** Wait for the control to be enabled before acting (default true). */
  requireEnabled?: boolean;
  /** The step types a secret: nothing about its value is logged. */
  secret?: boolean;
  /** Extra log details (never a secret). */
  details?: Record<string, unknown>;
  /** Wait for the application's input to go idle after the step (default true). Off for a step that starts long work and is judged by its outcome (a logon). */
  idleAfter?: boolean;
}

export interface LaunchOptions {
  path: string;
  args?: string[];
  cwd?: string;
  /** Wait for a window whose title matches (a launcher like sasmc.exe starts another process: the title is how it is found). */
  windowTitle?: RegExp | string;
  /** How long to wait for that window. Default 60 s. */
  windowTimeoutMs?: number;
}

export interface AttachOptions {
  processName?: string;
  windowTitle?: RegExp | string;
  pid?: number;
}

interface DialogHandler {
  name: string;
  title: ReturnType<typeof titleMatcher>;
  handle: (dialog: WindowLocator, app: DesktopApp) => Promise<void>;
  remaining: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isNotFound = (error: unknown): boolean => error instanceof DesktopTransportError && error.code === 'NOT_FOUND';

/**
 * One connection to the desktop bridge and everything that waits, retries, guards and logs on top of it.
 *
 * What it adds over the raw bridge protocol:
 *  - Before and after every action it waits for the application's input to go idle (waitForIdle), and for the control to exist and
 *    be enabled - no sleeps in tests.
 *  - A step whose control vanished mid-transition (the bridge answers NOT_FOUND for a stale handle) is resolved again and repeated, for a
 *    bounded number of rounds.
 *  - Every mutating step first asks the OperationGuard, and tells it how the step ended.
 *  - Every step is logged like any other adapter's; typed secrets are masked.
 *  - A failure says what IS on the screen (window title, controls, closest names).
 */
export class DesktopSession implements Adapter {
  readonly name = 'desktop-ui';
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly retryRounds: number;
  readonly fallbacks: 'report' | 'off';
  readonly guard: OperationGuard;
  private readonly driver: string;
  private readonly evidenceMode: EvidenceMode;
  private readonly evidenceDir: string;
  private readonly journal_: JournalEntry[] = [];
  private readonly drift: LocatorDrift[] = [];
  private evidenceCount = 0;
  readonly evidenceFiles: Array<{ label: string; file: string }> = [];

  constructor(
    private readonly transport: DesktopTransport,
    options: DesktopSessionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 100;
    this.retryRounds = options.retryRounds ?? 5;
    this.fallbacks = options.fallbacks ?? 'report';
    this.guard = options.guard ?? permissiveGuard;
    this.driver = options.driver ?? 'desktop-ui';
    this.evidenceMode = options.evidence ?? 'off';
    this.evidenceDir = options.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  }

  // ------------------------------------------------------------------------------------------------- raw access

  /** One request to the bridge (no waiting, no retry, no guard). Logged at debug level with secrets masked. */
  async send(command: DesktopCommand): Promise<unknown> {
    log.debug(`[desktop-ui] ${describeCommand(command)}`);
    return this.transport.request(command);
  }

  /** One info line in the log, for what a step did that its (value-free) start line could not say. */
  note(message: string): void {
    log.info(`[desktop-ui] ${message}`);
  }

  async pause(): Promise<void> {
    await sleep(this.pollMs);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ping();
      return true;
    } catch {
      return false;
    }
  }

  async ping(): Promise<PingResult> {
    return (await this.send({ op: 'ping' })) as PingResult;
  }

  /** Ends the bridge. Applications that were launched are NOT closed: use `app.dispose()`. */
  async close(): Promise<void> {
    await this.transport.close();
  }

  get journal(): readonly JournalEntry[] {
    return this.journal_;
  }

  get driftItems(): readonly LocatorDrift[] {
    return this.drift;
  }

  reportDrift(expected: string, usedFallback: string, found: string): void {
    this.drift.push({ expected, usedFallback, found });
    log.warn(`[desktop-ui] LOCATOR DRIFT: ${expected} did not match; found via ${usedFallback}: ${found} - update the LOCATORS table`);
  }

  // ------------------------------------------------------------------------------------------------- applications

  /** Starts a program and waits for its window. */
  async launch(options: LaunchOptions): Promise<DesktopApp> {
    return guarded(this.guard, { driver: this.driver, operation: 'launch', kind: 'read', target: options.path }, () =>
      adapterStep(this.name, 'launch', async () => {
        const title = options.windowTitle === undefined ? undefined : titleMatcher(options.windowTitle);
        const result = (await this.send({
          op: 'launch',
          path: options.path,
          args: options.args,
          cwd: options.cwd,
          waitForWindow: { titleRegex: title?.source, timeoutMs: options.windowTimeoutMs ?? 60_000 },
        })) as LaunchResult;
        return new DesktopApp(this, result.pid, result.process, true);
      }, { details: { path: options.path } }),
    );
  }

  /** Attaches to an application that is already running (it is never closed by `dispose()`). */
  async attach(options: AttachOptions): Promise<DesktopApp> {
    return guarded(this.guard, { driver: this.driver, operation: 'attach', kind: 'read', target: options.processName ?? String(options.windowTitle ?? options.pid) }, () =>
      adapterStep(this.name, 'attach', async () => {
        const title = options.windowTitle === undefined ? undefined : titleMatcher(options.windowTitle);
        const result = (await this.send({ op: 'attach', processName: options.processName, titleRegex: title?.source, pid: options.pid })) as AttachResult;
        return new DesktopApp(this, result.pid, result.process, false);
      }, { details: { processName: options.processName, pid: options.pid } }),
    );
  }

  /** A top-level window of any process, by title (a string is the exact title; a RegExp is a pattern). Prefer `app.window(...)`. */
  window(title: RegExp | string): WindowLocator {
    return new WindowLocator(this, { kind: 'window', title }, `window ${titleMatcher(title).text}`);
  }

  /** The top-level windows (and the windows they own - dialogs) of a process, or of every process. */
  async listWindows(pid?: number): Promise<WindowInfo[]> {
    const top = (await this.send({ op: 'windows', ...(pid !== undefined ? { pid } : {}) })) as WindowInfo[];
    const owned: WindowInfo[] = [];
    for (const w of top) {
      const nested = await this.nestedWindows(w);
      owned.push(...nested);
    }
    return [...top, ...owned];
  }

  /** Windows UI Automation shows a dialog as a child of the window that owns it: look below a top-level window too. */
  private async nestedWindows(owner: WindowInfo): Promise<WindowInfo[]> {
    try {
      const found = (await this.send({ op: 'find', root: owner.ref, criteria: { controlType: 'Window' }, limit: 20 })) as ElementInfo[];
      return found.map((el) => ({ ...el, process: owner.process, hwnd: 0, pid: el.pid ?? owner.pid }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Resolves a `window` selector: top-level windows first; only when none matches, the windows owned by the application's top-level windows. */
  async findWindows(selector: Extract<LocatorSelector, { kind: 'window' }>, limit: number): Promise<WindowInfo[]> {
    const title = titleMatcher(selector.title);
    const pid = selector.pid ?? selector.app?.pid;
    const filter: WindowFilter = { titleRegex: title.source, ...(pid !== undefined ? { pid } : {}) };
    const top = ((await this.send({ op: 'windows', ...filter })) as WindowInfo[]).filter((w) => title.test(w.name));
    let found = top;
    if (found.length === 0) {
      const owners = (await this.send({ op: 'windows', ...(pid !== undefined ? { pid } : {}) })) as WindowInfo[];
      for (const owner of owners) {
        const nested = (await this.nestedWindows(owner)).filter((w) => title.test(w.name));
        found = found.concat(nested);
      }
    }
    if (selector.index === 'last') return found.slice(-1);
    if (selector.index !== undefined) return found.slice(selector.index, selector.index + 1);
    return found.slice(0, limit);
  }

  // ------------------------------------------------------------------------------------------------- waiting and acting

  /**
   * Waits for the application's input to go idle (not hung, message loop answering). Returns at once when the pid is unknown or the
   * bridge cannot tell. Throws when the application does not become idle in time.
   */
  async waitIdle(pid: number | undefined, timeoutMs = this.timeoutMs): Promise<void> {
    if (pid === undefined) return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let idle = true;
      try {
        const reply = (await this.send({ op: 'waitForIdle', pid, timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) })) as { idle?: boolean } | null;
        idle = reply?.idle !== false;
      } catch (error) {
        if (error instanceof DesktopTransportError && ['SESSION_LOST', 'TIMEOUT', 'BRIDGE_EXITED'].includes(error.code)) throw error;
        return; // the bridge cannot tell (no such window, no message loop): carry on and let the control wait decide
      }
      if (idle) return;
      if (Date.now() >= deadline) {
        throw new AdapterError('desktop-ui', 'waitForIdle', `the application (process ${pid}) did not become idle within ${timeoutMs}ms - it may be hung or showing a modal dialog`);
      }
      await sleep(Math.min(this.pollMs, 25));
    }
  }

  /**
   * One guarded, logged, journaled step on a control: waits for the application to be idle and for the control to exist and be enabled,
   * runs `run`, repeats it (up to `retryRounds` times) when the control vanished mid-transition, and waits for the application to be
   * idle again. Dialog handlers registered on the application run first.
   */
  async act<T>(locator: DesktopLocator, label: string, options: ActOptions, run: (el: ElementInfo) => Promise<T>): Promise<T> {
    return guarded(this.guard, { driver: this.driver, operation: label, kind: options.kind, target: locator.toString(), local: true }, () =>
      this.step(
        label,
        locator.toString(),
        { target: locator.toString(), ...(options.details ?? {}) },
        async () => {
          await locator.app?.dismissDialogs(locator);
          await this.waitIdle(locator.pid);
          const deadline = Date.now() + this.timeoutMs;
          for (let round = 0; ; round++) {
            let el = await locator.resolve(Math.max(1, deadline - Date.now()));
            if (options.requireEnabled !== false) el = await this.waitEnabled(locator, el, deadline);
            try {
              const result = await run(el);
              if (options.idleAfter !== false) await this.waitIdle(el.pid ?? locator.pid);
              if (this.evidenceMode === 'steps' && options.kind !== 'read') await this.evidence(label, undefined, { quiet: true });
              return result;
            } catch (error) {
              if (!isNotFound(error)) throw error;
              if (round + 1 >= this.retryRounds || Date.now() >= deadline) {
                throw new AdapterError(
                  'desktop-ui',
                  label,
                  `${locator} kept disappearing while it was being used (${round + 1} attempts): the application keeps rebuilding that part of its window`,
                  { cause: error },
                );
              }
              await this.pause();
              await this.waitIdle(locator.pid).catch(() => undefined);
            }
          }
        },
        options.secret === true,
      ),
    );
  }

  private async waitEnabled(locator: DesktopLocator, found: ElementInfo, deadline: number): Promise<ElementInfo> {
    let el = found;
    const startedAt = Date.now();
    while (!el.enabled) {
      if (Date.now() >= deadline) {
        throw new AdapterError('desktop-ui', 'enabled', `${locator} is on the screen but stayed disabled for ${Date.now() - startedAt}ms`);
      }
      await this.pause();
      el = await locator.resolve(Math.max(1, deadline - Date.now()));
    }
    return el;
  }

  /** One logged, timed, journaled step. */
  async step<T>(label: string, target: string, details: Record<string, unknown>, action: () => Promise<T>, secret = false): Promise<T> {
    const startedAt = Date.now();
    const safe = secret ? { ...details, value: undefined, keys: undefined } : details;
    try {
      const result = await adapterStep(this.name, label, action, { level: label === 'fill' || label === 'click' ? 'info' : 'debug', details: safe });
      this.record({ at: startedAt, label, target, ms: Date.now() - startedAt, ok: true });
      return result;
    } catch (error) {
      this.record({ at: startedAt, label, target, ms: Date.now() - startedAt, ok: false, error: error instanceof Error ? error.message.split('\n')[0] : String(error) });
      throw error;
    }
  }

  private record(entry: JournalEntry): void {
    this.journal_.push(entry);
    if (this.journal_.length > JOURNAL_LIMIT) this.journal_.shift();
  }

  // ------------------------------------------------------------------------------------------------- evidence

  /**
   * A screenshot (of `locator`, else of the whole screen) written under the evidence folder and, inside a Playwright test, attached to
   * the report. The bridge paints password fields black first. The label is the only text in the file name and in the attachment.
   * Returns the file path. Taking evidence you ask for works whatever SAS_DESKTOP_EVIDENCE says; that setting only adds automatic ones.
   */
  async evidence(label: string, locator?: DesktopLocator, options: { quiet?: boolean } = {}): Promise<string> {
    const ref = locator ? (await locator.resolve()).ref : undefined;
    const shot = (await this.send({ op: 'screenshot', ...(ref ? { ref } : {}) })) as ScreenshotResult;
    fs.mkdirSync(this.evidenceDir, { recursive: true });
    const slug = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'evidence';
    const file = path.resolve(this.evidenceDir, `${String(++this.evidenceCount).padStart(3, '0')}-${slug}.png`);
    fs.writeFileSync(file, Buffer.from(shot.pngBase64, 'base64'));
    this.evidenceFiles.push({ label, file });
    try {
      const { test } = await import('@playwright/test');
      await test.info().attach(`desktop-${slug}`, { path: file, contentType: 'image/png' });
    } catch {
      // not inside a test (CLI, a worker fixture): the file is still there
    }
    if (!options.quiet) log.info(`[desktop-ui] evidence "${label}" -> ${file}`);
    return file;
  }
}

/**
 * One running application: a launched program or an attached one. It scopes locators to the application's process, runs dialog
 * handlers, and closes the application.
 */
export class DesktopApp {
  private readonly handlers: DialogHandler[] = [];
  private handling = false;

  constructor(
    readonly session: DesktopSession,
    readonly pid: number,
    readonly process: string,
    /** True when this framework started the program (only those are closed by `dispose()`). */
    readonly launched: boolean,
  ) {}

  /** A window of this application by title (a string is the exact title; a RegExp is a pattern). Dialogs are windows too. */
  window(title: RegExp | string): WindowLocator {
    return new WindowLocator(this.session, { kind: 'window', app: this, pid: this.pid, title }, `window ${titleMatcher(title).text}`);
  }

  /** Every window of this application right now (top-level and dialogs). */
  async windows(): Promise<WindowInfo[]> {
    return this.session.listWindows(this.pid);
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    await this.session.waitIdle(this.pid, timeoutMs);
  }

  /** A screenshot of the whole screen (or of `locator`) as evidence. */
  async evidence(label: string, locator?: DesktopLocator): Promise<string> {
    return this.session.evidence(label, locator);
  }

  // ------------------------------------------------------------------------------------------------- dialogs

  /**
   * Says once what to do about a dialog that may appear in front of any step - "save changes?" prompts, tip-of-the-day, license
   * notices - instead of `if (dialog exists)` in every test. Handlers run before a step whenever a window with a matching title is
   * open; a step aimed AT such a window (its locator starts from it) is never intercepted. `times` limits how often it fires.
   *
   *   app.onDialog(/Tip of the Day/, (dialog) => dialog.getByRole('Button', { name: 'Close' }).click());
   *
   * @returns a function that removes the handler again.
   */
  onDialog(
    title: RegExp | string,
    handle: (dialog: WindowLocator, app: DesktopApp) => Promise<void>,
    options: { name?: string; times?: number } = {},
  ): () => void {
    const handler: DialogHandler = {
      name: options.name ?? String(title),
      title: titleMatcher(title),
      handle,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
    };
    this.handlers.push(handler);
    return () => {
      const at = this.handlers.indexOf(handler);
      if (at !== -1) this.handlers.splice(at, 1);
    };
  }

  clearDialogHandlers(): void {
    this.handlers.length = 0;
  }

  /** Runs the matching handler for each dialog in front (up to 5 in a row). Returns how many were handled. */
  async dismissDialogs(target?: DesktopLocator): Promise<number> {
    if (this.handlers.length === 0 || this.handling) return 0;
    this.handling = true;
    let handled = 0;
    try {
      for (let round = 0; round < 5; round++) {
        const windows = await this.windows();
        const rootTitle = target?.rootWindow?.selector.kind === 'window' ? target.rootWindow.selector.title : undefined;
        const aimedAt = rootTitle === undefined ? undefined : titleMatcher(rootTitle);
        let ran = false;
        for (const window of windows) {
          const handler = this.handlers.find((h) => h.remaining > 0 && h.title.test(window.name));
          if (!handler) continue;
          if (aimedAt?.test(window.name)) continue; // the step is about this very window
          handler.remaining--;
          log.info(`[desktop-ui] dialog handler "${handler.name}" for window "${window.name}"`);
          await handler.handle(this.window(new RegExp(`^${window.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)), this);
          handled++;
          ran = true;
          break;
        }
        if (!ran) break;
      }
    } finally {
      this.handling = false;
    }
    return handled;
  }

  // ------------------------------------------------------------------------------------------------- ending

  /**
   * Closes the application's windows (the main window first) and waits until none is left. With `force: true` an application that is
   * still there after `timeoutMs` (a hung program, an unanswered "save?" prompt) is stopped by killing its process.
   */
  async close(options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    await this.dismissDialogs();
    let windows = (await this.session.send({ op: 'windows', pid: this.pid })) as WindowInfo[];
    for (const window of windows) {
      await guarded(this.session.guard, { driver: 'desktop-ui', operation: 'closeWindow', kind: 'update', target: window.name }, async () => {
        try {
          await this.session.send({ op: 'close', ref: window.ref });
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      });
    }
    for (;;) {
      await this.dismissDialogs();
      windows = (await this.session.send({ op: 'windows', pid: this.pid })) as WindowInfo[];
      if (windows.length === 0) return;
      if (Date.now() >= deadline) break;
      await this.session.pause();
    }
    if (options.force) {
      await this.kill();
      return;
    }
    throw new AdapterError('desktop-ui', 'close', `the application (process ${this.pid}) still has ${windows.length} window(s) open after ${timeoutMs}ms: ${windows.map((w) => `"${w.name}"`).join(', ')}. Handle the dialog with app.onDialog(...), or close({ force: true }).`);
  }

  /** Stops the application's process (the bridge refuses a process it did not launch or attach to). */
  async kill(): Promise<void> {
    await guarded(this.session.guard, { driver: 'desktop-ui', operation: 'kill', kind: 'destructive', target: `${this.process} (${this.pid})` }, async () => {
      await this.session.send({ op: 'kill', pid: this.pid });
    });
  }

  /** For fixtures: closes the application if this framework started it (never one that was merely attached to), forcing it after the timeout. */
  async dispose(): Promise<void> {
    if (!this.launched) return;
    await this.close({ force: true }).catch((error: unknown) => {
      log.warn(`[desktop-ui] could not close ${this.process} (${this.pid}): ${error instanceof Error ? error.message : String(error)}`);
    });
    // close() returns as soon as no window is left. A program of ours that has no window but is still running (for example after a
    // cancelled logon) would stay behind, so stop it. It is a program this framework started - only those are ever stopped here, and
    // the bridge refuses any other - so it counts as a read for the safety policy: a read-only run can still clean up after itself.
    await guarded(this.session.guard, { driver: 'desktop-ui', operation: 'disposeLaunched', kind: 'read', target: `${this.process} (${this.pid})` }, async () => {
      try {
        await this.session.send({ op: 'kill', pid: this.pid });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }).catch((error: unknown) => {
      log.warn(`[desktop-ui] could not stop ${this.process} (${this.pid}): ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
