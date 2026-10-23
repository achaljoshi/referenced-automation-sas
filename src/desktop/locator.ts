import { AdapterError } from '@automation/referenced-automation-utils';
import { OP_KIND } from './bridgeProtocol';
import { AmbiguousLocatorError, DesktopElementNotFoundError } from './errors';
import { describeElement, describeScreen, type ScreenTerm } from './screenHints';
import { looksSecret } from './secrets';
import type { DesktopApp, DesktopSession } from './session';
import { DesktopTransportError, type ElementInfo, type FindCriteria, type WindowInfo } from './types';

export type LocatorSelector =
  | { kind: 'window'; app?: DesktopApp; pid?: number; title: RegExp | string; index?: number | 'last' }
  | { kind: 'find'; parent: DesktopLocator; criteria: FindCriteria; index?: number | 'last' }
  | { kind: 'fallback'; primary: DesktopLocator; alternates: DesktopLocator[] };

/** How many matches a strict locator asks for: one more than it can use, so "more than one" is detected, and a few to show. */
const STRICT_LIMIT = 11;
/** `.last()` has to see them all. */
const LAST_LIMIT = 500;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function describeCriteria(c: FindCriteria): string {
  const parts: string[] = [];
  parts.push(c.controlType ? c.controlType.replace(/^ControlType\./i, '').toLowerCase() : 'control');
  if (c.name !== undefined) parts.push(`named "${c.name}"`);
  if (c.nameContains !== undefined) parts.push(`name containing "${c.nameContains}"`);
  if (c.nameRegex) parts.push(`name matching /${c.nameRegex.pattern}/${c.nameRegex.ignoreCase ? 'i' : ''}`);
  if (c.automationId !== undefined) parts.push(`with automation id "${c.automationId}"`);
  if (c.className !== undefined) parts.push(`of class "${c.className}"`);
  if (c.text !== undefined) parts.push(`with text "${c.text}"`);
  if (c.scope === 'children') parts.push('(direct child)');
  return parts.join(' ');
}

export function titleMatcher(title: RegExp | string): { source: string; test: (text: string) => boolean; text: string } {
  if (typeof title === 'string') {
    return { source: `^${escapeRegExp(title)}$`, test: (text) => text === title, text: `"${title}"` };
  }
  // the bridge matches case-insensitively; a pattern without the i flag is checked again here with its own flags
  const local = new RegExp(title.source, title.flags.replace(/[gy]/g, ''));
  return { source: title.source, test: (text) => local.test(text), text: String(title) };
}

/**
 * A way to find a control, used like a Playwright Locator: nothing is looked up until you act, every action waits for the control to
 * exist and be enabled and for the application's input to go idle, before AND after (no sleeps in tests), and a failure says what IS
 * on the screen.
 *
 *   const logon = app.window(/Log On/);
 *   await logon.getByName('User ID:').fill('sasdemo');
 *   await logon.getByName('Password:').fill(password, { secret: true });
 *   await logon.getByRole('Button', { name: 'OK' }).click();
 *   await desktopExpect(app.window(/SAS Management Console/)).toExist();
 *
 * Locators are STRICT like Playwright's: when more than one control matches, an action fails and lists them - narrow it, chain it
 * from a container (`window.getByRole('Tree').getByName('Users')`), or say `.first()` / `.nth(i)` on purpose.
 */
export class DesktopLocator {
  constructor(
    readonly session: DesktopSession,
    readonly selector: LocatorSelector,
    readonly description: string,
  ) {}

  toString(): string {
    return this.description;
  }

  // ------------------------------------------------------------ what it is rooted in

  /** The window this locator starts from (a `window` selector at the top of the chain), if any. */
  get rootWindow(): DesktopLocator | undefined {
    const s = this.selector;
    if (s.kind === 'window') return this;
    if (s.kind === 'find') return s.parent.rootWindow;
    return s.primary.rootWindow;
  }

  /** The application this locator belongs to, when it was built from `app.window(...)`. */
  get app(): DesktopApp | undefined {
    const root = this.rootWindow?.selector;
    return root?.kind === 'window' ? root.app : undefined;
  }

  /** The process id this locator is aimed at, when known before anything is resolved. */
  get pid(): number | undefined {
    const root = this.rootWindow?.selector;
    return root?.kind === 'window' ? (root.pid ?? root.app?.pid) : undefined;
  }

  // ------------------------------------------------------------ narrowing

  locator(criteria: FindCriteria, description?: string): DesktopLocator {
    return new DesktopLocator(this.session, { kind: 'find', parent: this, criteria }, `${this.description} > ${description ?? describeCriteria(criteria)}`);
  }

  /** By accessible name: exact by default; `exact: false` matches a part of it, case-insensitively; a RegExp matches the pattern. */
  getByName(name: string | RegExp, options: { exact?: boolean; controlType?: string } = {}): DesktopLocator {
    const criteria: FindCriteria = {};
    if (name instanceof RegExp) criteria.nameRegex = { pattern: name.source, ignoreCase: name.flags.includes('i') };
    else if (options.exact === false) criteria.nameContains = name;
    else criteria.name = name;
    if (options.controlType) criteria.controlType = options.controlType;
    return this.locator(criteria);
  }

  getByAutomationId(automationId: string, options: { controlType?: string } = {}): DesktopLocator {
    return this.locator({ automationId, ...(options.controlType ? { controlType: options.controlType } : {}) });
  }

  /** By UI Automation control type (Button, Edit, Tree, TreeItem, ComboBox, CheckBox, ...), optionally with its name. */
  getByRole(controlType: string, options: { name?: string | RegExp; exact?: boolean } = {}): DesktopLocator {
    const criteria: FindCriteria = { controlType };
    if (options.name instanceof RegExp) criteria.nameRegex = { pattern: options.name.source, ignoreCase: options.name.flags.includes('i') };
    else if (options.name !== undefined) {
      if (options.exact === false) criteria.nameContains = options.name;
      else criteria.name = options.name;
    }
    return this.locator(criteria);
  }

  /** Controls whose value (or, without one, name) contains `text`, case-insensitively. */
  getByText(text: string, options: { controlType?: string } = {}): DesktopLocator {
    return this.locator({ text, ...(options.controlType ? { controlType: options.controlType } : {}) });
  }

  getByClassName(className: string): DesktopLocator {
    return this.locator({ className });
  }

  first(): DesktopLocator {
    return this.withIndex(0);
  }

  last(): DesktopLocator {
    return this.withIndex('last');
  }

  nth(index: number): DesktopLocator {
    return this.withIndex(index);
  }

  private withIndex(index: number | 'last'): DesktopLocator {
    if (this.selector.kind === 'fallback') return this;
    const Kind = this instanceof WindowLocator ? WindowLocator : DesktopLocator;
    return new Kind(this.session, { ...this.selector, index }, `${this.description} [${index}]`);
  }

  /**
   * Fall back to other ways of finding the same control if this one is not on the screen - an automation id changed after an upgrade
   * but the name is still there:
   *
   *   dialog.getByAutomationId('btnOk').orElse(dialog.getByRole('Button', { name: 'OK' }))
   *
   * This is NOT silent self-healing. The primary gets a grace period first (a slow screen is not a changed locator). When a fallback is
   * used the test continues, a LOCATOR DRIFT warning is logged and the drift is recorded in `session.driftItems` with the
   * control that was found - the locator to fix in the LOCATORS table.
   */
  orElse(...alternates: DesktopLocator[]): DesktopLocator {
    return new DesktopLocator(
      this.session,
      { kind: 'fallback', primary: this, alternates },
      `${this.description} (or ${alternates.map(String).join(' / ')})`,
    );
  }

  // ------------------------------------------------------------ resolution

  /** The matches right now, without waiting and without strictness (`limit` of them). */
  async candidates(limit = STRICT_LIMIT): Promise<ElementInfo[]> {
    const s = this.selector;
    if (s.kind === 'window') return this.session.findWindows(s, limit);
    if (s.kind === 'fallback') {
      const own = await s.primary.candidates(limit);
      if (own.length > 0 || this.session.fallbacks === 'off') return own;
      for (const alternate of s.alternates) {
        const found = await alternate.candidates(limit);
        if (found.length > 0) {
          this.session.reportDrift(String(s.primary), String(alternate), describeElement(found[0] as ElementInfo));
          return found;
        }
      }
      return [];
    }
    const parent = await s.parent.peek();
    if (!parent) return [];
    const criteria = s.index === undefined || s.index === 'last' ? s.criteria : { ...s.criteria, nth: s.index };
    const limitAsked = s.index === 'last' ? LAST_LIMIT : s.index !== undefined ? 1 : limit;
    try {
      const found = (await this.session.send({ op: 'find', root: parent.ref, criteria, limit: limitAsked })) as ElementInfo[];
      return s.index === 'last' ? found.slice(-1) : found;
    } catch (error) {
      // the parent went away between looking it up and searching inside it: for now, nothing matches
      if (error instanceof DesktopTransportError && error.code === 'NOT_FOUND') return [];
      throw error;
    }
  }

  /** The one control this locator points at right now; undefined if none; AmbiguousLocatorError if several. Never waits. */
  async peek(): Promise<ElementInfo | undefined> {
    const found = await this.candidates();
    const s = this.selector;
    const indexed = s.kind !== 'fallback' && s.index !== undefined;
    if (found.length > 1 && !indexed) throw new AmbiguousLocatorError(this.description, found.map(describeElement), found.length);
    return found[0];
  }

  /** Waits for the control to exist (strictly one). Throws DesktopElementNotFoundError - with what IS on the screen - on timeout. */
  async resolve(timeoutMs: number = this.session.timeoutMs): Promise<ElementInfo> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const grace = Math.min(3_000, Math.floor(timeoutMs / 3));
    for (;;) {
      const found = await this.peekUsingFallbackAfter(startedAt, grace);
      if (found) return found;
      if (Date.now() >= deadline) throw new DesktopElementNotFoundError(this.description, Date.now() - startedAt, await this.whatIsOnScreen());
      await this.session.pause();
    }
  }

  /** The primary only until `grace` has passed since `startedAt`, then the alternates too (and the drift is reported). */
  private async peekUsingFallbackAfter(startedAt: number, grace: number): Promise<ElementInfo | undefined> {
    const s = this.selector;
    if (s.kind !== 'fallback') return this.peek();
    const primary = await s.primary.peek();
    if (primary) return primary;
    if (this.session.fallbacks === 'off' || Date.now() - startedAt < grace) return undefined;
    for (const alternate of s.alternates) {
      let found: ElementInfo | undefined;
      try {
        found = await alternate.peek();
      } catch {
        continue; // an ambiguous alternate is not a usable fallback
      }
      if (found) {
        this.session.reportDrift(String(s.primary), String(alternate), describeElement(found));
        return found;
      }
    }
    return undefined;
  }

  /** What this locator looks for, as words to compare with the screen. */
  searchTerms(): ScreenTerm[] {
    const s = this.selector;
    if (s.kind === 'window') return [typeof s.title === 'string' ? s.title : s.title.source];
    if (s.kind === 'fallback') return [...s.primary.searchTerms(), ...s.alternates.flatMap((a) => a.searchTerms())];
    const c = s.criteria;
    return [c.name, c.nameContains, c.text, c.nameRegex?.pattern, c.automationId !== undefined ? { id: c.automationId } : undefined].filter(
      (t): t is ScreenTerm => t !== undefined && t !== '',
    );
  }

  /** "On the screen now ..." with the closest matches: for failure messages. Bounded, passwords never shown, never throws. */
  async whatIsOnScreen(): Promise<string> {
    return describeScreen(this.session, this);
  }

  // ------------------------------------------------------------ reading

  /** The control's full state in one round trip. Waits for it to exist. */
  async info(): Promise<ElementInfo> {
    const el = await this.resolve();
    return (await this.session.send({ op: 'info', ref: el.ref })) as ElementInfo;
  }

  /** The control's state right now, or undefined when it is not on the screen. Never waits: this is what the retrying assertions poll. */
  async snapshot(): Promise<ElementInfo | undefined> {
    const el = await this.peek();
    if (!el) return undefined;
    try {
      return (await this.session.send({ op: 'info', ref: el.ref })) as ElementInfo;
    } catch (error) {
      if (error instanceof DesktopTransportError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  /** The text of the control: its value, else its name. Never for a password field (empty). */
  async text(): Promise<string> {
    const el = await this.resolve();
    return String(await this.session.send({ op: 'getText', ref: el.ref }));
  }

  async isEnabled(): Promise<boolean> {
    return (await this.info()).enabled;
  }

  async isChecked(): Promise<boolean> {
    return (await this.info()).toggleState === 'On';
  }

  async isSelected(): Promise<boolean> {
    return (await this.info()).selected === true;
  }

  /** On the screen right now? Does not wait. */
  async exists(): Promise<boolean> {
    return (await this.candidates()).length > 0;
  }

  /** How many controls match right now. Does not wait. */
  async count(): Promise<number> {
    return (await this.candidates(LAST_LIMIT)).length;
  }

  async waitFor(options: { state?: 'attached' | 'detached'; timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? this.session.timeoutMs;
    const wantPresent = (options.state ?? 'attached') === 'attached';
    const deadline = Date.now() + timeout;
    while (((await this.count()) > 0) !== wantPresent) {
      if (Date.now() >= deadline) {
        throw new AdapterError('desktop-ui', 'waitFor', `${this.description} was ${wantPresent ? 'not on the screen' : 'still on the screen'} after ${timeout}ms`);
      }
      await this.session.pause();
    }
  }

  // ------------------------------------------------------------ acting (every one waits, guards and logs)

  /** Clicks (Invoke pattern, else a real mouse click). `idleAfter: false` does not wait for the application to go idle afterwards (a click that starts long work you judge by its outcome). */
  async click(options: { idleAfter?: boolean } = {}): Promise<void> {
    await this.session.act(this, 'click', { kind: OP_KIND.click ?? 'update', idleAfter: options.idleAfter }, (el) => this.session.send({ op: 'click', ref: el.ref }));
  }

  async doubleClick(): Promise<void> {
    await this.session.act(this, 'doubleClick', { kind: OP_KIND.doubleClick ?? 'update' }, (el) => this.session.send({ op: 'doubleClick', ref: el.ref }));
  }

  async rightClick(): Promise<void> {
    await this.session.act(this, 'rightClick', { kind: OP_KIND.rightClick ?? 'read' }, (el) => this.session.send({ op: 'rightClick', ref: el.ref }));
  }

  /**
   * Types `text` into the control (replacing what is there). A password field - recognised by the control itself (IsPassword), by
   * `secret: true`, or by a name like "Password:" - is never logged, never read back and never shown in an error.
   * `verify: true` reads the value back and fails when the control kept something else (never for a secret).
   */
  async fill(text: string, options: { secret?: boolean; verify?: boolean } = {}): Promise<void> {
    const named = this.searchTerms().map((t) => (typeof t === 'string' ? t : t.id));
    const secretByName = options.secret === true || looksSecret(...named);
    await this.session.act(this, 'fill', { kind: OP_KIND.setText ?? 'update', secret: secretByName }, async (el) => {
      const secret = secretByName || el.isPassword;
      // The step's start line is written before the control is known, so it carries no value; what was typed is noted here, once the control
      // is known not to be a password field.
      if (!secret) this.session.note(`typed "${text}" into ${this}`);
      await this.session.send({ op: 'setText', ref: el.ref, text, secret });
      if (options.verify && !secret) {
        const kept = String(await this.session.send({ op: 'getText', ref: el.ref }));
        if (kept !== text) throw new AdapterError('desktop-ui', 'fill', `${this.description} did not keep the value: it holds "${kept}" after typing "${text}"`);
      }
    });
  }

  async clear(): Promise<void> {
    await this.fill('');
  }

  /** Selects a list / tree / tab item (SelectionItemPattern, else a click). */
  async select(options: { add?: boolean } = {}): Promise<void> {
    await this.session.act(this, 'select', { kind: OP_KIND.select ?? 'read' }, (el) => this.session.send({ op: 'select', ref: el.ref, add: options.add }));
  }

  async expand(): Promise<void> {
    await this.session.act(this, 'expand', { kind: OP_KIND.expand ?? 'read' }, async (el) => {
      const state = (await this.session.send({ op: 'info', ref: el.ref })) as ElementInfo;
      if (state.expandState !== 'Expanded') await this.session.send({ op: 'expand', ref: el.ref });
    });
  }

  async collapse(): Promise<void> {
    await this.session.act(this, 'collapse', { kind: OP_KIND.collapse ?? 'read' }, async (el) => {
      const state = (await this.session.send({ op: 'info', ref: el.ref })) as ElementInfo;
      if (state.expandState === 'Expanded') await this.session.send({ op: 'collapse', ref: el.ref });
    });
  }

  /** Ticks or unticks, doing nothing if it is already so (so it is safe to repeat). */
  async setChecked(checked: boolean): Promise<void> {
    await this.session.act(this, checked ? 'check' : 'uncheck', { kind: OP_KIND.toggle ?? 'update' }, async (el) => {
      const state = (await this.session.send({ op: 'info', ref: el.ref })) as ElementInfo;
      if ((state.toggleState === 'On') !== checked) await this.session.send({ op: 'toggle', ref: el.ref, state: checked });
    });
  }

  async check(): Promise<void> {
    await this.setChecked(true);
  }

  async uncheck(): Promise<void> {
    await this.setChecked(false);
  }

  async focus(): Promise<void> {
    await this.session.act(this, 'focus', { kind: OP_KIND.focus ?? 'read', requireEnabled: false }, (el) => this.session.send({ op: 'focus', ref: el.ref }));
  }

  async scrollIntoView(): Promise<void> {
    await this.session.act(this, 'scrollIntoView', { kind: OP_KIND.scrollIntoView ?? 'read', requireEnabled: false }, (el) =>
      this.session.send({ op: 'scrollIntoView', ref: el.ref }),
    );
  }

  /** Sends keys (SendKeys syntax: `{ENTER}`, `{TAB}`, `^a`, `%f`) to the control after focusing it. */
  async press(keys: string, options: { secret?: boolean } = {}): Promise<void> {
    await this.session.act(this, 'press', { kind: OP_KIND.sendKeys ?? 'update', secret: options.secret }, async (el) => {
      const secret = options.secret === true || el.isPassword;
      if (!secret) this.session.note(`pressed ${keys} on ${this}`);
      await this.session.send({ op: 'sendKeys', ref: el.ref, keys, secret });
    });
  }

  /** A screenshot of the control (password fields painted black by the bridge). Returns the file path; attached to the report inside a test. */
  async screenshot(label = 'control'): Promise<string> {
    return this.session.evidence(label, this);
  }
}

/** A top-level window (or a window owned by one: a dialog). Adds what only a window has. */
export class WindowLocator extends DesktopLocator {
  /** The window's title right now (waits for it to exist). */
  async title(): Promise<string> {
    return (await this.resolve()).name;
  }

  /** Closes the window (WindowPattern.Close). */
  async close(): Promise<void> {
    await this.session.act(this, 'closeWindow', { kind: OP_KIND.close ?? 'update', requireEnabled: false }, (el) => this.session.send({ op: 'close', ref: el.ref }));
  }

  /** Waits until the window is gone. */
  async waitForClose(timeout?: number): Promise<void> {
    await this.waitFor({ state: 'detached', timeout });
  }

  async windowInfo(): Promise<WindowInfo> {
    return (await this.resolve()) as WindowInfo;
  }
}
