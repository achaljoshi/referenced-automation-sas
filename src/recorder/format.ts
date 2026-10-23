import { normalizeKeys, secretKindOfTarget, type Commit, type SecretKind, type Target, type TargetWindow } from '../desktop/recording';

export type { Commit, PathStep, SecretKind, Target, TargetWindow } from '../desktop/recording';

/**
 * The recording file, `<name>.sasrec.json`: what a person did in a SAS desktop program, as data (not code), in a form a reviewer can read and the
 * secret scanner can check. Versioned: a tool refuses a version it does not know. See docs/RECORD_AND_PLAY.md.
 *
 * A recording NEVER contains a secret: a value typed into a password field (or a field named like one) is not in it - the entry says
 * `secret: true` and nothing else about what was typed. `validateRecording` refuses a file that breaks this, so does every writer.
 */
export const RECORDING_VERSION = 1;
export const RECORDING_EXTENSION = '.sasrec.json';

interface Base {
  /** Milliseconds since the recording started. */
  t: number;
}

export type RecordedEvent =
  | (Base & { type: 'windowOpened' | 'windowClosed' | 'windowActivated'; title: string; className?: string; process?: string; owned?: boolean })
  | (Base & { type: 'click' | 'doubleClick' | 'rightClick'; target: Target })
  | (Base & { type: 'text'; target: Target; value: string; committedBy: Commit; secret?: false })
  | (Base & { type: 'text'; target: Target; secret: true; secretKind?: SecretKind; committedBy: Commit })
  /** A shortcut or a named key (Ctrl+S, Alt+F, Enter, Escape, F5) - never a character: typed text is a `text` entry. */
  | (Base & { type: 'key'; keys: string; window: TargetWindow; target?: Target })
  /** `target` is the list / tree / tab strip / table; `items` the names selected in it. */
  | (Base & { type: 'select'; target: Target; items: string[] })
  | (Base & { type: 'toggle'; target: Target; state: boolean })
  | (Base & { type: 'expand' | 'collapse'; target: Target })
  /** A path through a menu: ['File', 'Open']. */
  | (Base & { type: 'menu'; window: TargetWindow; path: string[] })
  /** A dialog that only needed one button pressed (a prompt, a notice): the converter registers a handler for it instead of a step. */
  | (Base & { type: 'dialogHandled'; title: string; button: string });

export type EventType = RecordedEvent['type'];

export const EVENT_TYPES = [
  'windowOpened',
  'windowClosed',
  'windowActivated',
  'click',
  'doubleClick',
  'rightClick',
  'text',
  'key',
  'select',
  'toggle',
  'expand',
  'collapse',
  'menu',
  'dialogHandled',
] as const satisfies readonly EventType[];

export interface RecordingStats {
  /** Raw events the bridge reported (before they were tidied into the events below). */
  rawEvents?: number;
  /** Events the bridge had to throw away because its queue was full. */
  dropped?: number;
  /** Text entries whose value was NOT kept because the field is a secret. */
  secretEntries?: number;
  /** Key presses thrown away while a secret field had the focus (a count; nothing else is known about them). */
  secretKeysDiscarded?: number;
  durationMs?: number;
}

export interface Recording {
  version: typeof RECORDING_VERSION;
  /** 'smc' (SAS Management Console), 'eg' (SAS Enterprise Guide), or a window title regular expression for another program. */
  app: string;
  /** ISO 8601 time the recording started. */
  startedAt: string;
  /** The tool and version that wrote it. */
  tool: string;
  events: RecordedEvent[];
  stats?: RecordingStats;
}

// ---------------------------------------------------------------------------------------------------------------------- the field table

interface FieldSpec {
  required: readonly string[];
  optional: readonly string[];
}

/** Which properties each event type has. The validator and the JSON schema are both built from this one table. */
export const EVENT_FIELDS: Record<EventType, FieldSpec> = {
  windowOpened: { required: ['title'], optional: ['className', 'process', 'owned'] },
  windowClosed: { required: ['title'], optional: ['className', 'process', 'owned'] },
  windowActivated: { required: ['title'], optional: ['className', 'process', 'owned'] },
  click: { required: ['target'], optional: [] },
  doubleClick: { required: ['target'], optional: [] },
  rightClick: { required: ['target'], optional: [] },
  text: { required: ['target', 'committedBy'], optional: ['value', 'secret', 'secretKind'] },
  key: { required: ['keys', 'window'], optional: ['target'] },
  select: { required: ['target', 'items'], optional: [] },
  toggle: { required: ['target', 'state'], optional: [] },
  expand: { required: ['target'], optional: [] },
  collapse: { required: ['target'], optional: [] },
  menu: { required: ['window', 'path'], optional: [] },
  dialogHandled: { required: ['title', 'button'], optional: [] },
};

export const COMMIT_VALUES = ['enter', 'tab', 'blur'] as const;
export const SECRET_KINDS = ['password', 'pin', 'otp', 'token', 'secret', 'key'] as const;

// ---------------------------------------------------------------------------------------------------------------------- validation

export interface ValidationIssue {
  /** Where, like `events[3].target.path[1].index`. */
  path: string;
  message: string;
}

export type Validation = { ok: true; recording: Recording } | { ok: false; issues: ValidationIssue[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** A key that types a character (a letter, a digit, a symbol, Space, with at most Shift): recordings never carry those - they would be typed text. */
export function isPlainTypingKey(keys: string): boolean {
  const normal = normalizeKeys(keys);
  if (normal === undefined) return false;
  const parts = normal.split('+');
  const key = normal.endsWith('++') ? '+' : (parts[parts.length - 1] as string);
  const mods = new Set(normal.endsWith('++') ? parts.slice(0, -2) : parts.slice(0, -1));
  const typesCharacter = key.length === 1 || key === 'Space';
  return typesCharacter && !mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Win');
}

/** True when `keys` is a chord a recording may hold: a shortcut with Ctrl / Alt, or a named key (Enter, Escape, Tab, F-keys, navigation) - not a character. */
export function isRecordableKey(keys: string): boolean {
  return normalizeKeys(keys) !== undefined && !isPlainTypingKey(keys);
}

class Checker {
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  string(object: Record<string, unknown>, key: string, path: string, options: { optional?: boolean; nonEmpty?: boolean } = {}): void {
    const value = object[key];
    if (value === undefined) {
      if (!options.optional) this.add(`${path}.${key}`, 'is required');
      return;
    }
    if (!isString(value)) this.add(`${path}.${key}`, 'must be a string');
    else if (options.nonEmpty && value.trim() === '') this.add(`${path}.${key}`, 'must not be empty');
  }

  noExtra(object: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(object)) if (!allowed.includes(key)) this.add(`${path}.${key}`, 'is not a property of this entry (a typo, or a file from a newer tool)');
  }
}

function checkWindow(c: Checker, value: unknown, path: string): void {
  if (!isObject(value)) return void c.add(path, 'must be an object with a titlePattern');
  c.noExtra(value, ['titlePattern', 'title', 'className'], path);
  c.string(value, 'titlePattern', path, { nonEmpty: true });
  c.string(value, 'title', path, { optional: true });
  c.string(value, 'className', path, { optional: true });
  if (isString(value.titlePattern)) {
    try {
      new RegExp(value.titlePattern, 'i');
    } catch {
      c.add(`${path}.titlePattern`, 'is not a valid regular expression');
    }
  }
}

function checkRect(c: Checker, value: unknown, path: string, keys: readonly string[]): void {
  if (!isObject(value)) return void c.add(path, `must be an object with ${keys.join(', ')}`);
  c.noExtra(value, keys, path);
  for (const key of keys) if (!isInt(value[key])) c.add(`${path}.${key}`, 'must be a whole number');
}

function checkTarget(c: Checker, value: unknown, path: string): void {
  if (!isObject(value)) return void c.add(path, 'must be a target: { window, path, bounds?, fallbackPoint? }');
  c.noExtra(value, ['window', 'path', 'bounds', 'fallbackPoint', 'unique'], path);
  checkWindow(c, value.window, `${path}.window`);
  if (!Array.isArray(value.path)) c.add(`${path}.path`, 'must be an array of steps (the last one is the control itself)');
  else
    value.path.forEach((step: unknown, index: number) => {
      const at = `${path}.path[${index}]`;
      if (!isObject(step)) return void c.add(at, 'must be an object');
      c.noExtra(step, ['controlType', 'name', 'automationId', 'className', 'index'], at);
      for (const key of ['controlType', 'name', 'automationId', 'className']) c.string(step, key, at, { optional: true });
      if (step.index !== undefined && !(isInt(step.index) && step.index >= 0)) c.add(`${at}.index`, 'must be a whole number, 0 or more');
    });
  if (value.bounds !== undefined) checkRect(c, value.bounds, `${path}.bounds`, ['x', 'y', 'width', 'height']);
  if (value.fallbackPoint !== undefined) checkRect(c, value.fallbackPoint, `${path}.fallbackPoint`, ['x', 'y']);
  if (value.unique !== undefined) {
    if (!isObject(value.unique)) c.add(`${path}.unique`, 'must be an object');
    else {
      c.noExtra(value.unique, ['automationId', 'nameAndType'], `${path}.unique`);
      for (const key of ['automationId', 'nameAndType']) if (value.unique[key] !== undefined && typeof value.unique[key] !== 'boolean') c.add(`${path}.unique.${key}`, 'must be true or false');
    }
  }
}

function checkEvent(c: Checker, event: unknown, index: number): void {
  const path = `events[${index}]`;
  if (!isObject(event)) return void c.add(path, 'must be an object');
  const type = event.type;
  if (!isString(type) || !(EVENT_TYPES as readonly string[]).includes(type)) return void c.add(`${path}.type`, `must be one of ${EVENT_TYPES.join(', ')}`);
  const spec = EVENT_FIELDS[type as EventType];
  c.noExtra(event, ['type', 't', ...spec.required, ...spec.optional], path);
  if (typeof event.t !== 'number' || !Number.isFinite(event.t) || event.t < 0) c.add(`${path}.t`, 'must be a number of milliseconds, 0 or more');
  for (const key of spec.required) if (event[key] === undefined) c.add(`${path}.${key}`, 'is required');

  switch (type as EventType) {
    case 'windowOpened':
    case 'windowClosed':
    case 'windowActivated':
      c.string(event, 'title', path);
      for (const key of ['className', 'process']) c.string(event, key, path, { optional: true });
      if (event.owned !== undefined && typeof event.owned !== 'boolean') c.add(`${path}.owned`, 'must be true or false');
      break;
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'expand':
    case 'collapse':
      if (event.target !== undefined) checkTarget(c, event.target, `${path}.target`);
      break;
    case 'text': {
      if (event.target !== undefined) checkTarget(c, event.target, `${path}.target`);
      if (event.committedBy !== undefined && !(COMMIT_VALUES as readonly unknown[]).includes(event.committedBy)) c.add(`${path}.committedBy`, `must be one of ${COMMIT_VALUES.join(', ')}`);
      if (event.secretKind !== undefined && !(SECRET_KINDS as readonly unknown[]).includes(event.secretKind)) c.add(`${path}.secretKind`, `must be one of ${SECRET_KINDS.join(', ')}`);
      if (event.secret !== undefined && typeof event.secret !== 'boolean') c.add(`${path}.secret`, 'must be true or false');
      const secret = event.secret === true;
      if (secret) {
        if (event.value !== undefined) c.add(`${path}.value`, 'a secret entry must not carry a value: nothing typed into a secret field is ever recorded');
      } else {
        if (!isString(event.value)) c.add(`${path}.value`, 'must be a string (a secret field is written with secret: true and no value)');
        if (event.secretKind !== undefined) c.add(`${path}.secretKind`, 'only a secret entry has a secretKind');
        const kind = isObject(event.target) ? secretKindOfTarget(event.target as unknown as Target) : undefined;
        if (kind && isString(event.value))
          c.add(`${path}.value`, `the field looks like a ${kind} field (by its name or automation id) but a value was recorded: a recording never keeps one - write secret: true and drop the value`);
      }
      break;
    }
    case 'key':
      c.string(event, 'keys', path, { nonEmpty: true });
      if (isString(event.keys)) {
        if (normalizeKeys(event.keys) === undefined) c.add(`${path}.keys`, 'must be a key chord such as Ctrl+S, Alt+F, Enter, Escape or F5');
        else if (isPlainTypingKey(event.keys)) c.add(`${path}.keys`, 'a plain character is never recorded as a key: typed text is a "text" entry (and a secret is never kept)');
      }
      if (event.window !== undefined) checkWindow(c, event.window, `${path}.window`);
      if (event.target !== undefined) checkTarget(c, event.target, `${path}.target`);
      break;
    case 'select':
      if (event.target !== undefined) checkTarget(c, event.target, `${path}.target`);
      if (!Array.isArray(event.items) || event.items.length === 0 || !event.items.every((item) => isString(item) && item !== '')) c.add(`${path}.items`, 'must be a non-empty array of item names');
      break;
    case 'toggle':
      if (event.target !== undefined) checkTarget(c, event.target, `${path}.target`);
      if (typeof event.state !== 'boolean') c.add(`${path}.state`, 'must be true or false');
      break;
    case 'menu':
      if (event.window !== undefined) checkWindow(c, event.window, `${path}.window`);
      if (!Array.isArray(event.path) || event.path.length === 0 || !event.path.every((item) => isString(item) && item !== '')) c.add(`${path}.path`, 'must be a non-empty array of menu item names');
      break;
    case 'dialogHandled':
      c.string(event, 'title', path, { nonEmpty: true });
      c.string(event, 'button', path, { nonEmpty: true });
      break;
  }
}

/**
 * Checks a parsed recording against the format (every property, every type) and against the rules that keep secrets out: a secret entry has no
 * value, a field named like a secret has no value, no plain character is recorded as a key. Never throws; lists every problem it finds.
 */
export function validateRecording(value: unknown): Validation {
  const c = new Checker();
  if (!isObject(value)) return { ok: false, issues: [{ path: '$', message: 'a recording is a JSON object: { version, app, startedAt, tool, events }' }] };
  c.noExtra(value, ['version', 'app', 'startedAt', 'tool', 'events', 'stats'], '$');
  if (value.version !== RECORDING_VERSION) {
    c.add('$.version', typeof value.version === 'number' ? `this tool reads version ${RECORDING_VERSION} (the file is version ${value.version}): convert it with a tool of that version` : `must be ${RECORDING_VERSION}`);
  }
  c.string(value, 'app', '$', { nonEmpty: true });
  c.string(value, 'tool', '$', { nonEmpty: true });
  c.string(value, 'startedAt', '$');
  if (isString(value.startedAt) && Number.isNaN(Date.parse(value.startedAt))) c.add('$.startedAt', 'must be an ISO 8601 date and time');
  if (value.stats !== undefined) {
    if (!isObject(value.stats)) c.add('$.stats', 'must be an object');
    else {
      c.noExtra(value.stats, ['rawEvents', 'dropped', 'secretEntries', 'secretKeysDiscarded', 'durationMs'], '$.stats');
      for (const [key, item] of Object.entries(value.stats)) if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) c.add(`$.stats.${key}`, 'must be a number, 0 or more');
    }
  }
  if (!Array.isArray(value.events)) c.add('$.events', 'must be an array');
  else {
    value.events.forEach((event, index) => checkEvent(c, event, index));
    let last = 0;
    value.events.forEach((event, index) => {
      const t = isObject(event) ? event.t : undefined;
      if (typeof t === 'number' && Number.isFinite(t)) {
        if (t < last) c.add(`events[${index}].t`, 'events must be in time order');
        last = Math.max(last, t);
      }
    });
  }
  return c.issues.length === 0 ? { ok: true, recording: value as unknown as Recording } : { ok: false, issues: c.issues };
}

export class RecordingFormatError extends Error {
  constructor(
    readonly source: string,
    readonly issues: ValidationIssue[],
  ) {
    super(`${source} is not a valid recording (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n${issues.slice(0, 12).map((i) => `  ${i.path}: ${i.message}`).join('\n')}${issues.length > 12 ? `\n  ... and ${issues.length - 12} more` : ''}`);
    this.name = 'RecordingFormatError';
  }
}

/** Parses and validates the text of a `.sasrec.json` file. Throws RecordingFormatError naming every problem. */
export function parseRecording(text: string, source = 'the recording'): Recording {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new RecordingFormatError(source, [{ path: '$', message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }]);
  }
  const result = validateRecording(json);
  if (!result.ok) throw new RecordingFormatError(source, result.issues);
  return result.recording;
}

/** The text of a recording file (2-space JSON, a final newline). Refuses to write an invalid one - so a secret can never reach a file through here. */
export function serializeRecording(recording: Recording): string {
  const result = validateRecording(JSON.parse(JSON.stringify(recording)));
  if (!result.ok) throw new RecordingFormatError('the recording to write', result.issues);
  return `${JSON.stringify(recording, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------- JSON schema

const STRING = { type: 'string' } as const;
const INT = { type: 'integer' } as const;
const FIELD_SCHEMAS: Record<string, unknown> = {
  title: { type: 'string' },
  className: STRING,
  process: STRING,
  owned: { type: 'boolean' },
  target: { $ref: '#/$defs/target' },
  window: { $ref: '#/$defs/window' },
  value: STRING,
  secret: { type: 'boolean' },
  secretKind: { enum: [...SECRET_KINDS] },
  committedBy: { enum: [...COMMIT_VALUES] },
  keys: { type: 'string', minLength: 1 },
  items: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
  state: { type: 'boolean' },
  path: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
  button: { type: 'string', minLength: 1 },
};

function eventSchema(type: EventType): unknown {
  const spec = EVENT_FIELDS[type];
  const properties: Record<string, unknown> = { type: { const: type }, t: { type: 'number', minimum: 0 } };
  for (const key of [...spec.required, ...spec.optional]) properties[key] = FIELD_SCHEMAS[key];
  const schema: Record<string, unknown> = { type: 'object', properties, required: ['type', 't', ...spec.required], additionalProperties: false };
  if (type === 'text') {
    // a secret entry has no value; an ordinary one has
    schema.oneOf = [
      { properties: { secret: { const: true } }, required: ['secret'], not: { required: ['value'] } },
      { required: ['value'], not: { anyOf: [{ required: ['secretKind'] }, { properties: { secret: { const: true } }, required: ['secret'] }] } },
    ];
  }
  return schema;
}

/**
 * The recording format as JSON Schema (draft 2020-12), generated from the same field table the validator uses. It cannot express the rules about
 * what a secret field is called, nor that a key is never a plain character - `validateRecording` is the authority; the schema is for editors and other tools.
 */
export const RECORDING_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://sas-automation.invalid/schemas/sasrec-1.json',
  title: 'SAS desktop recording (.sasrec.json), version 1',
  type: 'object',
  required: ['version', 'app', 'startedAt', 'tool', 'events'],
  additionalProperties: false,
  properties: {
    version: { const: RECORDING_VERSION },
    app: { type: 'string', minLength: 1, description: "'smc', 'eg' or a window title regular expression" },
    startedAt: { type: 'string', format: 'date-time' },
    tool: { type: 'string', minLength: 1 },
    stats: {
      type: 'object',
      additionalProperties: false,
      properties: { rawEvents: { type: 'number' }, dropped: { type: 'number' }, secretEntries: { type: 'number' }, secretKeysDiscarded: { type: 'number' }, durationMs: { type: 'number' } },
    },
    events: { type: 'array', items: { oneOf: EVENT_TYPES.map((type) => eventSchema(type)) } },
  },
  $defs: {
    window: {
      type: 'object',
      required: ['titlePattern'],
      additionalProperties: false,
      properties: { titlePattern: { type: 'string', minLength: 1, description: 'an anchored, escaped regular expression of the window title' }, title: STRING, className: STRING },
    },
    step: {
      type: 'object',
      additionalProperties: false,
      properties: { controlType: STRING, name: STRING, automationId: STRING, className: STRING, index: { type: 'integer', minimum: 0 } },
    },
    target: {
      type: 'object',
      required: ['window', 'path'],
      additionalProperties: false,
      properties: {
        window: { $ref: '#/$defs/window' },
        path: { type: 'array', items: { $ref: '#/$defs/step' }, description: 'from the window down to the control; the last step is the control' },
        bounds: { type: 'object', required: ['x', 'y', 'width', 'height'], additionalProperties: false, properties: { x: INT, y: INT, width: INT, height: INT } },
        fallbackPoint: { type: 'object', required: ['x', 'y'], additionalProperties: false, properties: { x: INT, y: INT } },
        unique: { type: 'object', additionalProperties: false, properties: { automationId: { type: 'boolean' }, nameAndType: { type: 'boolean' } } },
      },
    },
  },
} as const;
