import type { FindCriteria } from './types';

/**
 * The vocabulary shared by the recorder in the bridge (bridge/sas-desktop-bridge.ps1), the stand-in recorder of the fake desktop
 * (fakeDesktop.ts) and the TypeScript recorder / converter (src/recorder): what `record.start`, `record.events` and `record.stop` carry.
 *
 * Kept inside src/desktop on purpose: the stand-in bridge program is built from this folder alone, so nothing here may import from
 * another one. Nothing in this file names an environment variable.
 *
 * NOT VERIFIED on a real Windows host with the real SAS programs: the PowerShell recorder has never run; the stand-in is what the
 * TypeScript side is tested against.
 */

// ---------------------------------------------------------------------------------------------------------------------- targets

/** The window a control is in. `titlePattern` is an anchored, escaped regular expression of the title at the time (case-insensitive when used). */
export interface TargetWindow {
  titlePattern: string;
  /** The literal title the pattern was made from. */
  title?: string;
  className?: string;
}

/**
 * One element on the way from the window down to the recorded control. Every property is what UI Automation reported at the time; any
 * of them may be missing (a Swing control has no automation id and often no name).
 */
export interface PathStep {
  controlType?: string;
  name?: string;
  automationId?: string;
  className?: string;
  /**
   * Zero-based position among the elements of the window that have the same control type and class name, in document order: the number
   * `.nth()` takes. Only given for a step that has neither an automation id nor a name (it is the last resort for finding it again).
   */
  index?: number;
}

/**
 * A LOCATOR CANDIDATE CHAIN: everything known about where a control is, so the converter can pick the most stable way to find it again.
 * Coordinates are relative to the top-left corner of the window.
 */
export interface Target {
  window: TargetWindow;
  /** From the window down to the control: the LAST step is the control itself. May be empty (a click on the window itself). */
  path: PathStep[];
  bounds?: { x: number; y: number; width: number; height: number };
  /** Where the pointer was. A target that has nothing but this cannot be turned into a locator. */
  fallbackPoint?: { x: number; y: number };
  /** How many controls in the window match the control's automation id / its name and control type (when the recorder could count). `false` = more than one. */
  unique?: { automationId?: boolean; nameAndType?: boolean };
}

// ---------------------------------------------------------------------------------------------------------------------- raw events

export type SecretKind = 'password' | 'pin' | 'otp' | 'token' | 'secret' | 'key';
export type Commit = 'enter' | 'tab' | 'blur';

interface Timed {
  /** Milliseconds since the recording started. */
  t: number;
}

export interface WindowEventFields {
  title: string;
  className?: string;
  process?: string;
  /** The window is owned by another window of the program (a dialog), as UI Automation shows it. */
  owned?: boolean;
}

/**
 * What the bridge reports while recording: the user's input already tied to the control it was aimed at (UI Automation resolved the
 * element under the pointer / with the focus), BEFORE it is tidied into a recording (src/recorder/coalesce.ts). `typed` carries the
 * value the field held once typing stopped (read from the control, never reconstructed from key presses) - or, for a secret field, only
 * the fact that something was typed. Plain key presses carry no characters: only shortcuts and a few named keys are reported.
 */
export type RawEvent =
  | (Timed & { type: 'windowOpened' | 'windowActivated' | 'windowClosed' } & WindowEventFields)
  | (Timed & { type: 'click' | 'doubleClick' | 'rightClick'; target: Target })
  | (Timed & { type: 'invoke'; target: Target })
  | (Timed & { type: 'typed'; target: Target; value?: string; secret?: true; secretKind?: SecretKind; committedBy?: Commit })
  | (Timed & { type: 'key'; keys: string; window: TargetWindow; target?: Target })
  | (Timed & { type: 'selected'; target: Target; container?: Target; /** Added to the selection (Ctrl+click) rather than replacing it. */ added?: true })
  | (Timed & { type: 'toggled'; target: Target; state: boolean })
  | (Timed & { type: 'expanded' | 'collapsed'; target: Target });

export type RawEventType = RawEvent['type'];

/** The raw event(s) that can have the type T (also those that share a definition with other types: click / doubleClick / rightClick). */
export type RawOf<T extends RawEventType> = RawEvent extends infer E ? (E extends { type: infer U } ? (T extends U ? E : never) : never) : never;

export const RAW_EVENT_TYPES = [
  'windowOpened',
  'windowActivated',
  'windowClosed',
  'click',
  'doubleClick',
  'rightClick',
  'invoke',
  'typed',
  'key',
  'selected',
  'toggled',
  'expanded',
  'collapsed',
] as const satisfies readonly RawEventType[];

// ---------------------------------------------------------------------------------------------------------------------- the three operations

export type RecordMode = 'full' | 'uia';
export const RECORD_MODES = ['full', 'uia'] as const satisfies readonly RecordMode[];
export const DEFAULT_MAX_QUEUE = 5000;

/** What `record.start` answers. */
export interface RecordStartResult {
  /** The process id of the first target window. */
  pid: number;
  /** Every process id being recorded. */
  pids: number[];
  process: string;
  /** How many target windows were open when recording started. */
  windows: number;
  mode: RecordMode;
  startedAt: string;
  maxQueue: number;
}

/** What `record.events` and `record.stop` answer. */
export interface RecordSnapshot {
  events: RawEvent[];
  /** Events that did not fit the bounded queue (and were thrown away). */
  dropped: number;
  /** Key presses thrown away because a secret field had the focus. Only a count: nothing else is kept about them. */
  secretKeysDiscarded: number;
  /** Key presses that went to another program's window: ignored (a count only). */
  foreignKeysIgnored: number;
  recording: boolean;
  /** At least one window of the recorded program still exists. */
  targetAlive: boolean;
  /** The user pressed the stop chord given to `record.start`. */
  stopRequested: boolean;
  /** Events left in the queue after this answer. */
  queued: number;
  /** Only on `record.stop`. */
  durationMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------------- helpers

/** The anchored, escaped regular expression of a window title. Only regular expression metacharacters are escaped (letters, spaces and "-" are not). */
export function titlePatternOf(title: string): string {
  return `^${title.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}$`;
}

/** The literal title behind a pattern made by `titlePatternOf`; undefined when the pattern is anything else (a character class, a group ...). */
export function titleFromPattern(pattern: string): string | undefined {
  const inner = pattern.replace(/^\^/, '').replace(/(?<!\\)\$$/, '');
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch === '\\') {
      const next = inner[i + 1];
      if (next === undefined) return undefined;
      if (!/[\\^$.|?*+()[\]{}]/.test(next)) return undefined; // \d, \s, \w ... are not a literal
      out += next;
      i++;
    } else if (/[\\^$.|?*+()[\]{}]/.test(ch)) return undefined;
    else out += ch;
  }
  return out;
}

/** The window of a title, as a target window. */
export function targetWindowOf(title: string, className?: string): TargetWindow {
  return { titlePattern: titlePatternOf(title), title, ...(className ? { className } : {}) };
}

// ---- secrets: the words that make a control's name or automation id a secret's. The PowerShell recorder carries the same list (a test compares).

/** The words that make a name a secret's, by the kind of secret. Words come from splitting a name at case changes and non-alphanumeric characters. */
export const SECRET_WORDS_BY_KIND: Readonly<Record<SecretKind, readonly string[]>> = {
  password: ['pwd', 'pw', 'pass', 'passwd', 'password', 'passcode', 'passphrase', 'kennwort', 'credential', 'credentials'],
  pin: ['pin'],
  otp: ['otp'],
  token: ['token'],
  secret: ['secret'],
  key: ['apikey', 'key'],
};

/** The word -> kind table (the inverse of SECRET_WORDS_BY_KIND). */
export const SECRET_WORDS: Readonly<Record<string, SecretKind>> = Object.fromEntries(
  (Object.entries(SECRET_WORDS_BY_KIND) as Array<[SecretKind, readonly string[]]>).flatMap(([kind, words]) => words.map((word) => [word, kind] as const)),
);

export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** The kind of secret a name suggests ("Password:", "txtUserPin", "API key"), judged by whole words so a "spinner" is not a PIN; undefined when it does not. */
export function secretKindOfName(...names: Array<string | undefined>): SecretKind | undefined {
  for (const name of names) {
    if (!name) continue;
    for (const word of wordsOf(name)) {
      const kind = SECRET_WORDS[word];
      if (kind) return kind;
    }
  }
  return undefined;
}

export const looksSecretName = (...names: Array<string | undefined>): boolean => secretKindOfName(...names) !== undefined;

/** The control a target points at is a secret field by its own name or automation id. */
export function secretKindOfTarget(target: Target | undefined): SecretKind | undefined {
  const leaf = target?.path[target.path.length - 1];
  return secretKindOfName(leaf?.name, leaf?.automationId);
}

// ---- keys

const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  backspace: 'Backspace',
};
const SENDKEYS_NAMED: Record<string, string> = {
  Enter: '{ENTER}',
  Escape: '{ESC}',
  Tab: '{TAB}',
  Delete: '{DELETE}',
  Insert: '{INSERT}',
  Home: '{HOME}',
  End: '{END}',
  PageUp: '{PGUP}',
  PageDown: '{PGDN}',
  Up: '{UP}',
  Down: '{DOWN}',
  Left: '{LEFT}',
  Right: '{RIGHT}',
  Space: ' ',
  Backspace: '{BACKSPACE}',
};
const MODIFIERS: Record<string, string> = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', windows: 'Win' };

/** `ctrl+s` -> `Ctrl+S`: the notation recordings use (modifiers in the order Ctrl, Alt, Shift, Win; named keys capitalised). undefined for something that is not a key chord. */
export function normalizeKeys(keys: string): string | undefined {
  const parts = keys.split('+').map((p) => p.trim());
  // a literal "+" key is written "Ctrl++"
  const key = parts[parts.length - 1] === '' && parts.length > 1 ? '+' : (parts.pop() as string);
  const mods = new Set<string>();
  for (const part of parts.filter((p) => p !== '')) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) return undefined;
    mods.add(mod);
  }
  let name: string | undefined;
  const lower = key.toLowerCase();
  if (NAMED_KEYS[lower]) name = NAMED_KEYS[lower];
  else if (/^f([1-9]|1\d|2[0-4])$/i.test(key)) name = key.toUpperCase();
  else if (key.length === 1) name = key.toUpperCase();
  if (name === undefined) return undefined;
  return [...['Ctrl', 'Alt', 'Shift', 'Win'].filter((m) => mods.has(m)), name].join('+');
}

/** `Ctrl+S` -> `^s`, `Enter` -> `{ENTER}`, `Alt+F4` -> `%{F4}`: the SendKeys syntax the bridge's sendKeys speaks. undefined for a chord SendKeys cannot send (the Windows key). */
export function keysToSendKeys(keys: string): string | undefined {
  const normal = normalizeKeys(keys);
  if (normal === undefined) return undefined;
  const parts = normal.split('+');
  const key = normal.endsWith('++') ? '+' : (parts[parts.length - 1] as string);
  const mods = new Set(normal.endsWith('++') ? parts.slice(0, -2) : parts.slice(0, -1));
  if (mods.has('Win')) return undefined;
  let body: string;
  if (SENDKEYS_NAMED[key]) body = SENDKEYS_NAMED[key] as string;
  else if (/^F\d+$/.test(key)) body = `{${key}}`;
  else if (/[+^%~(){}[\]]/.test(key)) body = `{${key}}`;
  else body = mods.size > 0 ? key.toLowerCase() : key;
  return `${mods.has('Ctrl') ? '^' : ''}${mods.has('Alt') ? '%' : ''}${mods.has('Shift') ? '+' : ''}${body}`;
}

// ---------------------------------------------------------------------------------------------------------------------- the stand-in's user

/** A window to act in, by title: a string is a case-insensitive regular expression source, a RegExp is used as it is. */
export type WindowSpec = string | RegExp;

export interface ControlSpec {
  window: WindowSpec;
  /** The control: its name, or full find criteria. */
  find: string | FindCriteria;
  /** Which of several matches (0-based). Default: the first. */
  nth?: number;
}

/**
 * What a person does, for the stand-in desktop (`FakeDesktop.simulateUserActions`, or `--simulate` of `sas-desktop-record`): each action changes
 * the fake program exactly like the framework's own steps would AND reports the raw events the real recorder would have reported. JSON-friendly.
 */
export type UserAction =
  | ({ do: 'click' | 'doubleClick' | 'rightClick' } & ControlSpec)
  | ({ do: 'type'; text: string; commit?: Commit } & ControlSpec)
  | { do: 'key'; keys: string; window: WindowSpec }
  | ({ do: 'select' } & ControlSpec)
  | ({ do: 'toggle'; state?: boolean } & ControlSpec)
  | ({ do: 'expand' | 'collapse' } & ControlSpec)
  | { do: 'pause'; ms: number };
