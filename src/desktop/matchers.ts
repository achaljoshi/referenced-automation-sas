import { expect as baseExpect, type ExpectMatcherState } from '@playwright/test';
import type { DesktopLocator, WindowLocator } from './locator';
import type { ElementInfo } from './types';

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

/** Options every desktop assertion accepts. */
export interface DesktopAssertionOptions {
  /** How long to keep re-checking before the assertion fails. Default 5000 ms. */
  timeout?: number;
}

interface Reading {
  /** Does the condition hold right now? */
  ok: boolean;
  /** What was found, for the failure message. */
  actual: string;
  /** The control itself was not on the screen: the failure message then says what is. */
  missing?: boolean;
}

/**
 * Re-checks `read` until the assertion can pass (or, for `.not`, until the opposite holds), the way Playwright's own web-first
 * assertions do - desktop screens change after the application has worked, so a one-shot read right after an action is a race.
 * Returns the last reading.
 */
async function until(isNot: boolean, timeout: number | undefined, read: () => Promise<Reading>): Promise<Reading> {
  const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT_MS);
  let last = await read();
  while (last.ok === isNot && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    last = await read();
  }
  return last;
}

function matches(actual: string, expected: string | RegExp, mode: 'equal' | 'contain'): boolean {
  if (typeof expected !== 'string') return expected.test(actual);
  return mode === 'equal' ? actual.trim() === expected.trim() : actual.toLowerCase().includes(expected.toLowerCase());
}

/** The text a control shows: its value (never a password's), else its name. */
export function textOf(info: ElementInfo): string {
  if (info.isPassword) return '';
  return info.value !== undefined ? info.value : info.name;
}

/**
 * The result of an assertion on a locator. When it failed because the control is not on the screen, the message says what is
 * (window title, controls with their names and ids, the closest matches, other windows) - "expected on the screen, received
 * not on the screen" alone leaves a person to open the application and look. A password is never shown: a password field's text is
 * always reported as hidden.
 */
async function resultFor(state: ExpectMatcherState, name: string, reading: Reading, expected: unknown, locator: DesktopLocator) {
  const screen = !reading.ok && !state.isNot && reading.missing ? await locator.whatIsOnScreen() : '';
  return {
    name,
    pass: reading.ok,
    expected,
    actual: reading.actual,
    message: () =>
      `${state.utils.matcherHint(name, String(locator), '', { isNot: state.isNot })}\n\n` +
      `Expected${state.isNot ? ' not' : ''}: ${state.utils.printExpected(expected)}\n` +
      `Received: ${state.utils.printReceived(reading.actual)}` +
      (screen ? `\n\n${screen}` : ''),
  };
}

const NOT_THERE = '(control not on the screen)';

async function textReading(locator: DesktopLocator, expected: string | RegExp, mode: 'equal' | 'contain'): Promise<Reading> {
  const snap = await locator.snapshot();
  if (!snap) return { ok: false, actual: NOT_THERE, missing: true };
  const shown = snap.isPassword ? '(password field - not shown)' : textOf(snap);
  return { ok: snap.isPassword ? false : matches(shown, expected, mode), actual: shown };
}

/**
 * `expect` with desktop assertions that wait and retry:
 *
 *   await desktopExpect(app.window(/Log On/)).toExist();
 *   await desktopExpect(logon.getByRole('Button', { name: 'OK' })).toBeEnabled();
 *   await desktopExpect(project.getByName('Log')).toContainText('NOTE: ');
 *   await desktopExpect(app.window(/Enterprise Guide/)).toHaveTitle(/My project/);
 *
 * Everything from Playwright's `expect` (`expect.soft`, `.not`, `toBe`, ...) works as usual.
 */
export const desktopExpect = baseExpect.extend({
  async toExist(this: ExpectMatcherState, locator: DesktopLocator, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const found = (await locator.count()) > 0;
      return { ok: found, actual: found ? 'on the screen' : 'not on the screen', missing: !found };
    });
    return resultFor(this, 'toExist', reading, 'on the screen', locator);
  },

  async toBeEnabled(this: ExpectMatcherState, locator: DesktopLocator, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      if (!snap) return { ok: false, actual: NOT_THERE, missing: true };
      return { ok: snap.enabled, actual: snap.enabled ? 'enabled' : 'disabled' };
    });
    return resultFor(this, 'toBeEnabled', reading, 'enabled', locator);
  },

  async toHaveText(this: ExpectMatcherState, locator: DesktopLocator, expected: string | RegExp, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, () => textReading(locator, expected, 'equal'));
    return resultFor(this, 'toHaveText', reading, expected, locator);
  },

  async toContainText(this: ExpectMatcherState, locator: DesktopLocator, expected: string | RegExp, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, () => textReading(locator, expected, 'contain'));
    return resultFor(this, 'toContainText', reading, expected, locator);
  },

  async toBeSelected(this: ExpectMatcherState, locator: DesktopLocator, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      if (!snap) return { ok: false, actual: NOT_THERE, missing: true };
      return { ok: snap.selected === true, actual: snap.selected === undefined ? 'not selectable' : snap.selected ? 'selected' : 'not selected' };
    });
    return resultFor(this, 'toBeSelected', reading, 'selected', locator);
  },

  async toBeChecked(this: ExpectMatcherState, locator: DesktopLocator, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      if (!snap) return { ok: false, actual: NOT_THERE, missing: true };
      return { ok: snap.toggleState === 'On', actual: snap.toggleState === undefined ? 'not checkable' : snap.toggleState === 'On' ? 'checked' : 'not checked' };
    });
    return resultFor(this, 'toBeChecked', reading, 'checked', locator);
  },

  /** A window's title matches (a string is a case-insensitive "contains"; a RegExp is tested as it is). */
  async toHaveTitle(this: ExpectMatcherState, window: WindowLocator, expected: string | RegExp, options: DesktopAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await window.peek();
      if (!snap) return { ok: false, actual: '(window not on the screen)', missing: true };
      return { ok: matches(snap.name, expected, 'contain'), actual: snap.name || '(no title)' };
    });
    return resultFor(this, 'toHaveTitle', reading, expected, window);
  },
});
