import type { DesktopLocator } from './locator';
import type { DesktopSession } from './session';
import type { ElementInfo, TreeNode, WindowInfo } from './types';

/**
 * "What is on the screen?" for a failure message: when a control an assertion or a locator was looking for is not there, the useful
 * question is what IS there - the window title, the controls with their names and automation ids, the ones that look most like what
 * was asked for ("Okay" -> "OK"), and any dialog in front. Built from the session's own `windows` and `tree` operations, so it works
 * on every transport and on the stand-in.
 *
 * Bounded: at most MAX_LISTED controls are listed (the closest matches are searched in all of them), text is shortened, the walk has
 * a time budget and the whole block has a size limit - a failing test must not become a slow test or a huge message.
 * Never reveals a password: only names, control types and ids are listed - never any value an input field holds - and a
 * password field is marked as such. Never throws: it is called while another failure is being reported.
 */
export const MAX_LISTED = 25;
const MAX_NEAREST = 5;
const MAX_TEXT_CHARS = 40;
const MAX_BLOCK_CHARS = 3_000;
const WALK_BUDGET_MS = 4_000;
const WALK_MAX_NODES = 300;
const MAX_WINDOWS = 3;

/** A thing a failed locator looked for: a name / text a user reads, or an automation id. */
export type ScreenTerm = string | { id: string };

/** Levenshtein distance, stopping early once it is certain to exceed `limit`. */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/** How close `candidate` is to `wanted`: 0 = one contains the other (case-insensitive), else the edit distance if it is small enough to be a typo; undefined = unrelated. */
export function closeness(wanted: string, candidate: string): number | undefined {
  const w = wanted.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (w === '' || c === '') return undefined;
  if (c.includes(w) || w.includes(c)) return 0;
  const limit = Math.max(2, Math.ceil(w.length / 3));
  const distance = editDistance(w, c, limit);
  return distance <= limit ? distance : undefined;
}

function shorten(text: string, max = MAX_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

const quoted = (text: string) => `"${shorten(text)}"`;

/** What an element is, in one line, for lists in messages: `Button "OK" #okButton`. */
export function describeElement(el: Pick<ElementInfo, 'controlType' | 'name' | 'automationId' | 'className'>): string {
  return `${el.controlType}${el.name ? ` "${el.name}"` : ''}${el.automationId ? ` #${el.automationId}` : ''}${el.className ? ` (${el.className})` : ''}`;
}

/** Control types whose name is only structure, not something a user reads. */
const STRUCTURAL = new Set(['Pane', 'Group', 'Custom', 'Image', 'Separator', 'Thumb', 'ScrollBar', 'TitleBar']);

function entryText(node: ElementInfo): string {
  return `${node.controlType}${node.name ? ` ${quoted(node.name)}` : ''}${node.automationId ? ` #${node.automationId}` : ''}${node.isPassword ? ' (password field)' : ''}`;
}

function nearest(term: ScreenTerm, nodes: ElementInfo[]): string[] {
  return nodes
    .map((node) => ({
      node,
      score: typeof term === 'string' ? closeness(term, node.name) : closeness(term.id, node.automationId),
    }))
    .filter((x): x is { node: ElementInfo; score: number } => x.score !== undefined)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_NEAREST)
    .map((x) => entryText(x.node));
}

const termText = (term: ScreenTerm) => (typeof term === 'string' ? term : term.id);

/**
 * "On the screen now (window "...", pid N): controls (k of n): ..." plus the closest matches for what `locator` looks for, and the
 * other windows (a dialog in front) of the same application.
 */
export async function describeScreen(session: DesktopSession, locator?: DesktopLocator): Promise<string> {
  try {
    const deadline = Date.now() + WALK_BUDGET_MS;
    const pid = locator?.pid;
    const windows = await session.listWindows(pid);
    let main: WindowInfo | undefined;
    try {
      main = (await locator?.rootWindow?.peek()) as WindowInfo | undefined;
    } catch {
      main = undefined;
    }
    main ??= windows[0];
    if (!main) return `On the screen now: ${pid !== undefined ? `no window of process ${pid}` : 'no top-level window'} is open.`;

    const terms = (locator?.searchTerms() ?? []).filter((t) => termText(t).trim() !== '');
    const lines: string[] = [];
    const ordered = [main, ...windows.filter((w) => w.ref !== main?.ref)].slice(0, MAX_WINDOWS);
    for (const [index, window] of ordered.entries()) {
      const nodes = await session
        .send({ op: 'tree', ref: window.ref, depth: 6, maxNodes: WALK_MAX_NODES })
        .then((n) => n as TreeNode[])
        .catch(() => [] as TreeNode[]);
      const readable = nodes.filter((n) => (n.name.trim() !== '' || n.automationId !== '') && !STRUCTURAL.has(n.controlType));
      const listed = readable.slice(0, MAX_LISTED);
      const head = index === 0 ? `On the screen now (window ${quoted(window.name || '(untitled)')}, pid ${window.pid ?? '?'})` : `Another window is open (${quoted(window.name || '(untitled)')}) - the control may be behind it, or the flow took a different path`;
      lines.push(
        `${head}: controls ${
          readable.length === 0
            ? '(none found - for a Java application check the Java Access Bridge: sas-desktop-inspect doctor)'
            : `(${listed.length}${readable.length > listed.length ? ` of ${readable.length}` : ''}): ${listed.map(entryText).join(', ')}${readable.length > listed.length ? ', ...' : ''}`
        }`,
      );
      if (Date.now() > deadline) break;
      for (const term of terms) {
        const close = nearest(term, readable);
        if (close.length > 0) lines.push(`Closest to ${quoted(termText(term))}${index > 0 ? ' in that window' : ''}: ${close.join(', ')}`);
        else if (index === 0) lines.push(`Nothing on the screen looks like ${quoted(termText(term))}.`);
      }
    }
    const block = lines.join('\n');
    return block.length > MAX_BLOCK_CHARS ? `${block.slice(0, MAX_BLOCK_CHARS - 4)} ...` : block;
  } catch (error) {
    return `On the screen now: (could not be read: ${error instanceof Error ? error.message : String(error)})`;
  }
}
