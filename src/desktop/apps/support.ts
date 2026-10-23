import { AdapterError } from '@automation/referenced-automation-utils';
import type { DesktopLocator } from '../locator';
import { describeScreen } from '../screenHints';
import type { DesktopSession } from '../session';

/**
 * One way to find a control, as a LOCATORS table entry. Every field that is given must match. `role` is the UI Automation control type
 * (Button, Edit, List, ListItem, Tree, TreeItem, Table, DataItem, Tab, TabItem, Text, Document, ...).
 */
export interface Locate {
  automationId?: string;
  role?: string;
  name?: string | RegExp;
  /** With a string `name`: false matches a part of it, case-insensitively. */
  exact?: boolean;
}

/** One entry, or several: the first is the primary, the rest are fallbacks tried (and reported as locator drift) when it does not match. */
export type LocateSpec = Locate | Locate[];

/** Applies a LOCATORS entry inside `scope`. */
export function pick(scope: DesktopLocator, spec: LocateSpec): DesktopLocator {
  const list = Array.isArray(spec) ? spec : [spec];
  const built = list.map((l) => {
    let locator: DesktopLocator;
    if (l.role) locator = scope.getByRole(l.role, { name: l.name, exact: l.exact });
    else if (l.automationId !== undefined) locator = scope.getByAutomationId(l.automationId);
    else if (l.name !== undefined) locator = scope.getByName(l.name, { exact: l.exact });
    else throw new Error('a LOCATORS entry needs a role, an automationId or a name');
    if (l.automationId !== undefined && l.role) locator = locator.locator({ automationId: l.automationId }, `with automation id "${l.automationId}"`);
    return locator;
  });
  const [primary, ...rest] = built;
  if (!primary) throw new Error('empty LOCATORS entry');
  return rest.length > 0 ? primary.orElse(...rest) : primary;
}

/** Polls `read` until it returns a value (not undefined) or the timeout passes; the failure says `what` and what is on the screen. */
export async function waitUntil<T>(session: DesktopSession, what: string, read: () => Promise<T | undefined>, timeoutMs = session.timeoutMs, scope?: DesktopLocator): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new AdapterError('desktop-ui', 'wait', `${what} did not happen within ${timeoutMs}ms\n${await describeScreen(session, scope)}`);
    }
    await session.pause();
  }
}

/**
 * Reads a list that may still be filling (a table loading rows): reads it again and again until it has not changed for `settleMs`, so a
 * half-loaded list is not returned as if it were the whole. Costs `settleMs` per list; the timeout bounds a list that never settles
 * (the last reading is returned).
 */
export async function readStable<T>(session: DesktopSession, read: () => Promise<T[]>, options: { timeoutMs?: number; settleMs?: number } = {}): Promise<T[]> {
  const deadline = Date.now() + (options.timeoutMs ?? session.timeoutMs);
  const settleMs = options.settleMs ?? 200;
  let current = await read();
  let since = Date.now();
  for (;;) {
    await session.pause();
    const next = await read();
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      since = Date.now();
    }
    if (Date.now() - since >= settleMs || Date.now() >= deadline) return current;
  }
}

/** The credentials of a SAS logon. Passed in by the caller (the fixtures read them from the environment); never logged. */
export interface SasCredentials {
  user: string;
  password: string;
}
