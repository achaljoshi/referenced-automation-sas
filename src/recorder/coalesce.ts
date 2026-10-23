import { normalizeKeys, secretKindOfTarget, titleFromPattern, type Commit, type PathStep, type RawEvent, type SecretKind, type Target } from '../desktop/recording';
import { isPlainTypingKey, type RecordedEvent } from './format';

/**
 * Tidies what the bridge reported while recording (RawEvent, one per thing the user did, as UI Automation and the hooks saw it) into the events a
 * recording keeps. What it does, in order:
 *
 *  - SECRETS FIRST: a `typed` event for a secret field (flagged by the bridge, or whose control's name says so) loses its value; a key press that
 *    would type a character is dropped (typed text comes from the field, never from key presses); nothing else survives that could carry a secret.
 *  - consecutive `typed` events on one control become one `text` entry at its commit (Enter, Tab or leaving the field);
 *  - two clicks on one control in quick succession are a `doubleClick`;
 *  - a click followed by what it caused on that control becomes one step: an invoke is the click itself, a toggle is a `toggle`, a selection is a
 *    `select`, an expansion an `expand` / `collapse`; the same events with no click before them (done with the keyboard) stand alone;
 *  - a burst of selections in one list or tree is one `select` (several items only when they were added to the selection);
 *  - clicks through a menu are one `menu` path;
 *  - a click that only focused a field the user then typed into is dropped;
 *  - a dialog that opened, had one button pressed and closed becomes a `dialogHandled` (the converter registers a handler for it).
 */

export interface CoalesceOptions {
  /** Two clicks on one control within this many ms are a double click. Default 500. */
  doubleClickMs?: number;
  /** An effect (invoke, selection, toggle, expansion) within this many ms of a click on the same control belongs to it. Default 800. */
  effectMs?: number;
  /** Selections within this many ms of each other in one container are one burst. Default 400. */
  selectionMs?: number;
  /** Menu item clicks within this many ms of each other are one path. Default 4000. */
  menuMs?: number;
}

export interface CoalesceStats {
  rawEvents: number;
  /** Text entries whose value was not kept because the field is a secret. */
  secretEntries: number;
  /** Key presses that would have typed a character (dropped). */
  printableKeysDropped: number;
  /** Events that were not well formed (dropped). */
  invalidDropped: number;
}

export interface CoalesceResult {
  events: RecordedEvent[];
  stats: CoalesceStats;
  /** Things worth telling the person who recorded: events that were dropped as malformed. */
  warnings: string[];
}

type Item = RawEvent | RecordedEvent;
const DEFAULTS: Required<CoalesceOptions> = { doubleClickMs: 500, effectMs: 800, selectionMs: 400, menuMs: 4000 };
const WINDOW_EVENTS = new Set(['windowOpened', 'windowClosed', 'windowActivated']);
const EFFECTS = new Set(['invoke', 'selected', 'toggled', 'expanded', 'collapsed']);
const NON_CONTENT_KEYS = new Set(['Enter', 'Tab', 'Escape']);

const stepKey = (s: PathStep) => `${s.controlType ?? ''}:${s.name ?? ''}:${s.automationId ?? ''}:${s.className ?? ''}:${s.index ?? ''}`;
/** Identifies a control inside a window: the window's title pattern and the path down to it. */
export const controlKey = (target: Target): string => `${target.window.titlePattern}|${target.path.map(stepKey).join('/')}`;
const leaf = (target: Target): PathStep | undefined => target.path[target.path.length - 1];
const isTarget = (value: unknown): value is Target => typeof value === 'object' && value !== null && typeof (value as Target).window?.titlePattern === 'string' && Array.isArray((value as Target).path);
const windowTitleOf = (target: Target): string => target.window.title ?? titleFromPattern(target.window.titlePattern) ?? target.window.titlePattern;
const sameWindow = (a: Target['window'], b: Target['window']) => a.titlePattern === b.titlePattern;

function sanitize(raw: RawEvent[], stats: CoalesceStats, warnings: string[]): Item[] {
  const out: Item[] = [];
  raw.forEach((event, index) => {
    const bad = (why: string) => {
      stats.invalidDropped++;
      warnings.push(`raw event ${index + 1} dropped: ${why}`);
    };
    if (typeof event !== 'object' || event === null || typeof (event as { type?: unknown }).type !== 'string' || typeof (event as { t?: unknown }).t !== 'number') return bad('not an event');
    const e = event as RawEvent & Record<string, unknown>;
    switch (e.type) {
      case 'typed': {
        if (!isTarget(e.target)) return bad('typed text without a target');
        const kind: SecretKind | undefined = e.secret === true || e.secretKind !== undefined ? (e.secretKind ?? secretKindOfTarget(e.target) ?? 'password') : secretKindOfTarget(e.target);
        if (kind) {
          // whatever value the bridge may have attached is NOT carried on: only the fact survives
          out.push({ type: 'typed', t: e.t, target: e.target, secret: true, secretKind: kind, ...(e.committedBy ? { committedBy: e.committedBy } : {}) });
        } else if (typeof e.value !== 'string') return bad('typed text without a value');
        else out.push({ type: 'typed', t: e.t, target: e.target, value: e.value, ...(e.committedBy ? { committedBy: e.committedBy } : {}) });
        return;
      }
      case 'key': {
        const keys = typeof e.keys === 'string' ? normalizeKeys(e.keys) : undefined;
        if (keys === undefined) return bad('not a key chord');
        if (isPlainTypingKey(keys)) {
          stats.printableKeysDropped++; // a character: typed text is taken from the field, never from key presses
          return;
        }
        if (e.target && isTarget(e.target) && secretKindOfTarget(e.target) && !NON_CONTENT_KEYS.has(keys)) {
          stats.printableKeysDropped++;
          return;
        }
        out.push({ ...e, keys } as RawEvent);
        return;
      }
      case 'windowOpened':
      case 'windowClosed':
      case 'windowActivated':
        if (typeof e.title !== 'string') return bad('a window event without a title');
        out.push(e as RawEvent);
        return;
      case 'click':
      case 'doubleClick':
      case 'rightClick':
      case 'invoke':
      case 'selected':
      case 'toggled':
      case 'expanded':
      case 'collapsed':
        if (!isTarget(e.target)) return bad(`${e.type} without a target`);
        out.push(e as RawEvent);
        return;
      default:
        return bad(`unknown event type "${String((e as { type: unknown }).type)}"`);
    }
  });
  return out;
}

/** A window that is activated right after it opened, or that is already the active one, adds nothing. */
function dedupeWindows(items: Item[]): Item[] {
  const out: Item[] = [];
  let active: string | undefined;
  for (const item of items) {
    if (item.type === 'windowActivated') {
      if (active === item.title) continue;
      active = item.title;
    } else if (item.type === 'windowOpened') active = item.title;
    else if (item.type === 'windowClosed' && active === item.title) active = undefined;
    out.push(item);
  }
  return out;
}

type Typed = Extract<RawEvent, { type: 'typed' }>;

/** Consecutive `typed` events on one control are one entry; Enter / Tab right after it say how it was committed. */
function mergeTyping(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    if (item.type !== 'typed') {
      out.push(item);
      continue;
    }
    let merged: Typed = item;
    let committedBy: Commit | undefined = item.committedBy;
    while (i + 1 < items.length) {
      const next = items[i + 1] as Item;
      if (next.type !== 'typed' || controlKey(next.target) !== controlKey(merged.target)) break;
      merged = { ...next, ...(next.secret || merged.secret ? { secret: true as const, secretKind: next.secretKind ?? merged.secretKind } : {}) };
      if (merged.secret) delete merged.value;
      committedBy = next.committedBy ?? committedBy;
      i++;
    }
    if (committedBy === undefined) {
      const next = items[i + 1];
      if (next && next.type === 'key' && sameWindow(next.window, merged.target.window) && (next.keys === 'Enter' || next.keys === 'Tab')) {
        committedBy = next.keys === 'Enter' ? 'enter' : 'tab';
        i++; // the key belongs to the field it committed
      }
    }
    const common = { t: merged.t, target: merged.target, committedBy: committedBy ?? 'blur' } as const;
    out.push(merged.secret ? { type: 'text', ...common, secret: true, secretKind: merged.secretKind ?? 'password' } : { type: 'text', ...common, value: merged.value ?? '' });
  }
  return out;
}

interface ClickItem {
  type: 'click' | 'doubleClick';
  t: number;
  target: Target;
}
const isClickLike = (item: Item): item is Item & ClickItem => item.type === 'click' || item.type === 'doubleClick';
const targetOf = (item: Item): Target | undefined => ('target' in item ? (item.target as Target | undefined) : undefined);

/** Two clicks on one control in quick succession (with only their own effects between) are a double click. */
function mergeDoubleClicks(items: Item[], ms: number): Item[] {
  const out: Item[] = [];
  const skipped = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (skipped.has(i)) continue;
    const item = items[i] as Item;
    if (item.type !== 'click') {
      out.push(item);
      continue;
    }
    const key = controlKey(item.target);
    let partner = -1;
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j] as Item;
      if (next.t - item.t > ms) break;
      if (next.type === 'click' && controlKey(next.target) === key) {
        partner = j;
        break;
      }
      const nextTarget = targetOf(next);
      if (!EFFECTS.has(next.type) || !nextTarget || controlKey(nextTarget) !== key) break;
    }
    if (partner < 0) {
      out.push(item);
      continue;
    }
    skipped.add(partner);
    out.push({ ...item, type: 'doubleClick' });
  }
  return out;
}

/** A click and what it caused on the same control become one step. Effects without a click (keyboard) stand alone. */
function groupClicks(items: Item[], effectMs: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    // Enter on a focused button: UI Automation reports the invoke as well - the invoke is the step
    if (item.type === 'key' && item.keys === 'Enter') {
      const next = items[i + 1];
      if (next && next.type === 'invoke' && next.t - item.t <= effectMs) continue;
    }
    if (!isClickLike(item)) {
      if (item.type === 'invoke') {
        const next = items[i + 1];
        // the invoke arrived before the click it belongs to: the click is the step
        if (next && isClickLike(next) && controlKey(next.target) === controlKey(item.target) && next.t - item.t <= effectMs) continue;
        out.push({ type: 'click', t: item.t, target: item.target });
      } else if (item.type === 'toggled') out.push({ type: 'toggle', t: item.t, target: item.target, state: item.state });
      else if (item.type === 'expanded') out.push({ type: 'expand', t: item.t, target: item.target });
      else if (item.type === 'collapsed') out.push({ type: 'collapse', t: item.t, target: item.target });
      else out.push(item);
      continue;
    }
    const key = controlKey(item.target);
    const effects: Item[] = [];
    const windows: Item[] = [];
    let j = i + 1;
    for (; j < items.length; j++) {
      const next = items[j] as Item;
      if (next.t - item.t > effectMs) break;
      if (WINDOW_EVENTS.has(next.type)) {
        windows.push(next);
        continue;
      }
      const nextTarget = targetOf(next);
      if (EFFECTS.has(next.type) && nextTarget && controlKey(nextTarget) === key) effects.push(next);
      else break;
    }
    // windows that opened between the click and its effects are kept in order, after the step they were caused by
    const produced: Item[] = [];
    const toggled = [...effects].reverse().find((e) => e.type === 'toggled') as Extract<RawEvent, { type: 'toggled' }> | undefined;
    const selected = effects.filter((e) => e.type === 'selected');
    const expanded = [...effects].reverse().find((e) => e.type === 'expanded' || e.type === 'collapsed');
    if (toggled) produced.push({ type: 'toggle', t: item.t, target: item.target, state: toggled.state });
    else if (selected.length > 0) {
      produced.push(...selected);
      if (expanded) produced.push({ type: expanded.type === 'expanded' ? 'expand' : 'collapse', t: expanded.t, target: item.target });
    } else if (expanded) produced.push({ type: expanded.type === 'expanded' ? 'expand' : 'collapse', t: item.t, target: item.target });
    else produced.push(item);
    out.push(...produced, ...windows);
    i = j - 1;
  }
  return out;
}

/** A click that only put the cursor into a field the user then typed into is not a step: filling the field does not need it. */
function dropFocusClicks(items: Item[]): Item[] {
  return items.filter((item, index) => {
    if (item.type !== 'click') return true;
    const next = items[index + 1];
    return !(next && next.type === 'text' && controlKey(next.target) === controlKey(item.target));
  });
}

const without = (target: Target): Target => ({ ...target, path: target.path.slice(0, -1) });

/** `selected` events become `select` events: bursts in one container are one entry. */
function mergeSelections(items: Item[], ms: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    if (item.type !== 'selected') {
      out.push(item);
      continue;
    }
    const container = item.container ?? (item.target.path.length > 1 ? without(item.target) : undefined);
    if (!container) {
      out.push({ type: 'click', t: item.t, target: item.target }); // no container to select in: the click is all that is known
      continue;
    }
    const key = controlKey(container);
    let names: string[] = [];
    let last: Extract<RawEvent, { type: 'selected' }> = item;
    const take = (e: Extract<RawEvent, { type: 'selected' }>) => {
      const name = leaf(e.target)?.name;
      if (!e.added) names = [];
      if (name && !names.includes(name)) names.push(name);
      last = e;
    };
    take(item);
    while (i + 1 < items.length) {
      const next = items[i + 1] as Item;
      if (next.type !== 'selected' || next.t - last.t > ms) break;
      const nextContainer = next.container ?? (next.target.path.length > 1 ? without(next.target) : undefined);
      if (!nextContainer || controlKey(nextContainer) !== key) break;
      take(next);
      i++;
    }
    if (names.length === 0) out.push({ type: 'click', t: last.t, target: last.target });
    else out.push({ type: 'select', t: last.t, target: container, items: names });
  }
  return out;
}

const isMenuClick = (item: Item): item is Item & ClickItem => item.type === 'click' && leaf(item.target)?.controlType === 'MenuItem' && !!leaf(item.target)?.name;

/** Clicks through a menu are one path: File, then Open. */
function mergeMenus(items: Item[], ms: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    if (!isMenuClick(item)) {
      out.push(item);
      continue;
    }
    const path = [leaf(item.target)?.name as string];
    let last = item;
    let lastIndex = i;
    let j = i + 1;
    for (; j < items.length; j++) {
      const next = items[j] as Item;
      if (WINDOW_EVENTS.has(next.type)) continue; // a menu opening as a window of its own
      if (isMenuClick(next) && next.t - last.t <= ms && sameWindow(next.target.window, item.target.window)) {
        path.push(leaf(next.target)?.name as string);
        last = next;
        lastIndex = j;
        continue;
      }
      break;
    }
    out.push({ type: 'menu', t: item.t, window: item.target.window, path });
    out.push(...items.slice(lastIndex + 1, j)); // the window events after the last item belong after the step
    i = j - 1;
  }
  return out;
}

interface WindowItem {
  type: 'windowOpened' | 'windowClosed' | 'windowActivated';
  t: number;
  title: string;
  className?: string;
  owned?: boolean;
}
const isDialog = (e: WindowItem) => e.owned === true || /#32770|dialog|messagebox/i.test(e.className ?? '');

/** A dialog that opened, had one button pressed and closed is a `dialogHandled`. */
function mergeDialogs(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    if (item.type !== 'windowOpened' || !isDialog(item as WindowItem)) {
      out.push(item);
      continue;
    }
    let closed = -1;
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j] as Item;
      if (next.type === 'windowClosed' && next.title === item.title) {
        closed = j;
        break;
      }
    }
    const between = closed < 0 ? [] : items.slice(i + 1, closed);
    const clicks = between.filter((e) => e.type === 'click') as Array<Item & ClickItem>;
    const others = between.filter((e) => e.type !== 'click' && e.type !== 'windowActivated');
    const click = clicks[0];
    const button = click ? leaf(click.target) : undefined;
    if (closed >= 0 && clicks.length === 1 && others.length === 0 && click && button?.name && button.controlType === 'Button' && windowTitleOf(click.target) === item.title) {
      out.push({ type: 'dialogHandled', t: item.t, title: item.title, button: button.name });
      i = closed;
    } else out.push(item);
  }
  return out;
}

function finish(items: Item[]): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  let last = 0;
  for (const item of items) {
    const t = Math.max(last, Math.round(item.t));
    last = t;
    switch (item.type) {
      case 'typed':
      case 'invoke':
      case 'selected':
      case 'toggled':
      case 'expanded':
      case 'collapsed':
        throw new Error(`internal error: a raw "${item.type}" event was not tidied`);
      case 'key': {
        const { type, keys, window, target } = item;
        events.push({ type, t, keys, window, ...(target ? { target } : {}) });
        break;
      }
      case 'windowOpened':
      case 'windowClosed':
      case 'windowActivated':
        events.push({ type: item.type, t, title: item.title, ...(item.className ? { className: item.className } : {}), ...(item.process ? { process: item.process } : {}), ...(item.owned ? { owned: true } : {}) });
        break;
      default:
        events.push({ ...(item as RecordedEvent), t });
    }
  }
  return events;
}

/** Raw bridge events in, recording events out. Pure: the same input always gives the same output. */
export function coalesce(raw: RawEvent[], options: CoalesceOptions = {}): CoalesceResult {
  const o = { ...DEFAULTS, ...options };
  const stats: CoalesceStats = { rawEvents: raw.length, secretEntries: 0, printableKeysDropped: 0, invalidDropped: 0 };
  const warnings: string[] = [];
  let items = sanitize(raw, stats, warnings);
  items = dedupeWindows(items);
  items = mergeTyping(items);
  items = mergeDoubleClicks(items, o.doubleClickMs);
  items = groupClicks(items, o.effectMs);
  items = dropFocusClicks(items);
  items = mergeSelections(items, o.selectionMs);
  items = mergeMenus(items, o.menuMs);
  items = mergeDialogs(items);
  const events = finish(items);
  stats.secretEntries = events.filter((e) => e.type === 'text' && e.secret === true).length;
  return { events, stats, warnings };
}
