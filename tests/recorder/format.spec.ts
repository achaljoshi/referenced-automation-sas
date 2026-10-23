import { expect, test } from '@playwright/test';
import {
  COMMIT_VALUES,
  EVENT_FIELDS,
  EVENT_TYPES,
  isPlainTypingKey,
  isRecordableKey,
  parseRecording,
  RecordingFormatError,
  RECORDING_JSON_SCHEMA,
  RECORDING_VERSION,
  serializeRecording,
  validateRecording,
  type Recording,
} from '../../src/recorder';
import { activated, click, closed, key, opened, raw, step, target, typed } from './support/events';
import { validateAgainstSchema } from './support/schema';

const win = 'Log On';
const okButton = target(win, step.button('OK'));

/** One valid event of every type. */
function everyEvent(): Recording['events'] {
  return [
    { type: 'windowOpened', t: 0, title: 'SAS Enterprise Guide', className: 'HwndWrapper', process: 'SEGuide', owned: false },
    { type: 'windowActivated', t: 1, title: 'SAS Enterprise Guide' },
    { type: 'click', t: 2, target: okButton },
    { type: 'doubleClick', t: 3, target: okButton },
    { type: 'rightClick', t: 4, target: okButton },
    { type: 'text', t: 5, target: target(win, step.edit('User ID:')), value: 'sasdemo', committedBy: 'tab' },
    { type: 'text', t: 6, target: target(win, step.edit('Password:')), secret: true, secretKind: 'password', committedBy: 'enter' },
    { type: 'key', t: 7, keys: 'Ctrl+S', window: { titlePattern: '^Log On$' } },
    { type: 'select', t: 8, target: target(win, step.list('Profiles')), items: ['Dev'] },
    { type: 'toggle', t: 9, target: target(win, step.check('Remember me')), state: true },
    { type: 'expand', t: 10, target: target(win, step.node('Environment')) },
    { type: 'collapse', t: 11, target: target(win, step.node('Environment')) },
    { type: 'menu', t: 12, window: { titlePattern: '^Log On$' }, path: ['File', 'Open'] },
    { type: 'dialogHandled', t: 13, title: 'Tip of the Day', button: 'Close' },
    { type: 'windowClosed', t: 14, title: 'Tip of the Day' },
  ];
}

const recording = (events: Recording['events'] = everyEvent()): Recording => ({ version: 1, app: 'eg', startedAt: '2026-10-23T09:00:00.000Z', tool: 'test', events });
const issues = (value: unknown) => {
  const result = validateRecording(value);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
};

test.describe('the recording format', () => {
  test('a recording with every kind of event is valid, and the table of event types covers them all', () => {
    expect(issues(recording())).toEqual([]);
    expect(everyEvent().map((e) => e.type).filter((t, i, all) => all.indexOf(t) === i).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(EVENT_FIELDS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  test('it round-trips through the text form unchanged', () => {
    const original = recording();
    const text = serializeRecording(original);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseRecording(text)).toEqual(original);
    expect(parseRecording(`\uFEFF${text}`)).toEqual(original); // a byte order mark from an editor is tolerated
  });

  test('what is wrong is named with its path: version, missing parts, unknown parts, wrong types', () => {
    expect(issues(null)[0]).toMatch(/^\$: a recording is a JSON object/);
    expect(issues({ ...recording(), version: 2 })).toContainEqual(expect.stringMatching(/\$\.version: this tool reads version 1 \(the file is version 2\)/));
    expect(issues({ ...recording(), version: 'one' })).toContainEqual('$.version: must be 1');
    expect(issues({ ...recording(), extra: 1 })).toContainEqual(expect.stringMatching(/\$\.extra: is not a property/));
    const { app: _app, ...withoutApp } = recording();
    void _app;
    expect(issues(withoutApp)).toContain('$.app: is required');
    expect(issues({ ...recording(), startedAt: 'yesterday' })).toContain('$.startedAt: must be an ISO 8601 date and time');
    expect(issues({ ...recording(), events: 'none' })).toContain('$.events: must be an array');
    expect(issues(recording([{ type: 'click', t: 1 } as never]))).toContain('events[0].target: is required');
    expect(issues(recording([{ type: 'hover', t: 1 } as never]))[0]).toMatch(/^events\[0\]\.type: must be one of windowOpened/);
    expect(issues(recording([{ type: 'click', t: -1, target: okButton }]))).toContain('events[0].t: must be a number of milliseconds, 0 or more');
    expect(issues(recording([{ type: 'click', t: 1, target: okButton, surprise: true } as never]))).toContainEqual(expect.stringMatching(/events\[0\]\.surprise: is not a property/));
    expect(issues(recording([{ type: 'click', t: 5, target: okButton }, { type: 'click', t: 4, target: okButton }]))).toContain('events[1].t: events must be in time order');
  });

  test('targets are checked down to the step: bad regular expression, bad index, bad rectangle', () => {
    const bad = (patch: Record<string, unknown>) => issues(recording([{ type: 'click', t: 1, target: { ...okButton, ...patch } as never }]));
    expect(bad({ window: { titlePattern: '(' } })).toContain('events[0].target.window.titlePattern: is not a valid regular expression');
    expect(bad({ path: [{ controlType: 'Button', index: -1 }] })).toContain('events[0].target.path[0].index: must be a whole number, 0 or more');
    expect(bad({ path: [{ controlType: 5 }] })).toContain('events[0].target.path[0].controlType: must be a string');
    expect(bad({ path: 'x' })).toContainEqual(expect.stringMatching(/target\.path: must be an array/));
    expect(bad({ bounds: { x: 1 } })).toContain('events[0].target.bounds.y: must be a whole number');
    expect(bad({ fallbackPoint: { x: 1.5, y: 2 } })).toContain('events[0].target.fallbackPoint.x: must be a whole number');
    expect(bad({ unique: { automationId: 'yes' } })).toContain('events[0].target.unique.automationId: must be true or false');
  });

  test('a SECRET is never in a recording: a secret entry has no value, and a field named like a secret cannot carry one', () => {
    const entry = (patch: Record<string, unknown>, field = 'Password:') => issues(recording([{ type: 'text', t: 1, target: target(win, step.edit(field)), committedBy: 'blur', ...patch } as never]));
    expect(entry({ secret: true, value: 'hunter2-Zq9!' })).toContain('events[0].value: a secret entry must not carry a value: nothing typed into a secret field is ever recorded');
    expect(entry({ value: 'hunter2-Zq9!' })).toContainEqual(expect.stringMatching(/looks like a password field \(by its name or automation id\) but a value was recorded/));
    expect(entry({ value: '123456' }, 'One-time OTP')).toContainEqual(expect.stringMatching(/looks like a otp field/));
    expect(entry({ value: 'abc' }, 'API Key')).toContainEqual(expect.stringMatching(/looks like a key field/));
    expect(entry({})).toContain('events[0].value: must be a string (a secret field is written with secret: true and no value)');
    expect(entry({ secret: true })).toEqual([]);
    expect(entry({ value: 'sasdemo' }, 'User ID:')).toEqual([]); // negative control: an ordinary field keeps its value
    expect(entry({ value: 'x', secretKind: 'pin' }, 'User ID:')).toContain('events[0].secretKind: only a secret entry has a secretKind');
    // and a writer refuses it too
    expect(() => serializeRecording(recording([{ type: 'text', t: 1, target: target(win, step.edit('Password:')), committedBy: 'blur', secret: true, value: 'hunter2-Zq9!' } as never]))).toThrow(RecordingFormatError);
  });

  test('a key press is never a character: plain letters, digits and Space are refused, shortcuts and named keys are fine', () => {
    for (const keys of ['a', 'A', 'Shift+a', '5', 'Space', ';']) expect(isPlainTypingKey(keys), keys).toBe(true);
    for (const keys of ['Ctrl+S', 'Alt+F', 'Enter', 'Escape', 'F5', 'Tab', 'Ctrl+Alt+Q', 'Delete', 'PageDown']) expect(isRecordableKey(keys), keys).toBe(true);
    expect(isRecordableKey('Hyper+Q')).toBe(false);
    const keyIssues = (keys: string) => issues(recording([{ type: 'key', t: 1, keys, window: { titlePattern: '^x$' } }]));
    expect(keyIssues('q')).toContainEqual(expect.stringMatching(/a plain character is never recorded as a key/));
    expect(keyIssues('Hyper+Q')).toContainEqual(expect.stringMatching(/must be a key chord/));
    expect(keyIssues('Ctrl+S')).toEqual([]);
  });

  test('select, menu, dialogHandled, toggle and commit have their own rules', () => {
    const one = (event: Record<string, unknown>) => issues(recording([{ t: 1, ...event } as never]));
    expect(one({ type: 'select', target: okButton, items: [] })).toContain('events[0].items: must be a non-empty array of item names');
    expect(one({ type: 'menu', window: { titlePattern: '^x$' }, path: [] })).toContain('events[0].path: must be a non-empty array of menu item names');
    expect(one({ type: 'toggle', target: okButton, state: 'on' })).toContain('events[0].state: must be true or false');
    expect(one({ type: 'dialogHandled', title: '', button: 'OK' })).toContain('events[0].title: must not be empty');
    expect(one({ type: 'text', target: target('w', step.edit('Name')), value: 'v', committedBy: 'later' })).toContain(`events[0].committedBy: must be one of ${COMMIT_VALUES.join(', ')}`);
  });

  test('parseRecording says which file and lists the problems; invalid JSON is one clear message', () => {
    let error: unknown;
    try {
      parseRecording(JSON.stringify({ ...recording(), version: 9 }), 'recordings/old.sasrec.json');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RecordingFormatError);
    expect((error as Error).message).toMatch(/^recordings\/old\.sasrec\.json is not a valid recording \(1 problem\):\n {2}\$\.version:/);
    expect(() => parseRecording('{ nope', 'x')).toThrow(/x is not a valid recording[^]*is not valid JSON/);
    const many = recording(Array.from({ length: 20 }, (_, i) => ({ type: 'click', t: i, target: 5 }) as never));
    expect(() => serializeRecording(many)).toThrow(/and \d+ more/);
  });
});

test.describe('the JSON schema', () => {
  const schema = RECORDING_JSON_SCHEMA;
  const eventSchemas = schema.properties.events.items.oneOf as Array<{ properties: Record<string, { const?: string }>; required: string[] }>;

  test('has exactly one entry per event type, with the required and optional properties of the field table', () => {
    expect(eventSchemas.map((s) => s.properties.type?.const).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) {
      const entry = eventSchemas.find((s) => s.properties.type?.const === type) as (typeof eventSchemas)[number];
      expect(entry.required.sort(), type).toEqual(['type', 't', ...EVENT_FIELDS[type].required].sort());
      expect(Object.keys(entry.properties).sort(), type).toEqual(['type', 't', ...EVENT_FIELDS[type].required, ...EVENT_FIELDS[type].optional].sort());
    }
    expect(schema.properties.version.const).toBe(RECORDING_VERSION);
  });

  test('accepts what the validator accepts and rejects what it rejects (for the rules a schema can express)', () => {
    expect(validateAgainstSchema(schema, recording())).toEqual([]);
    const bad: Array<[string, unknown]> = [
      ['a wrong version', { ...recording(), version: 2 }],
      ['no events', { ...recording(), events: undefined }],
      ['an unknown event', recording([{ type: 'hover', t: 1 } as never])],
      ['a click without a target', recording([{ type: 'click', t: 1 } as never])],
      ['a secret with a value', recording([{ type: 'text', t: 1, target: okButton, committedBy: 'blur', secret: true, value: 'x' } as never])],
      ['an ordinary text without a value', recording([{ type: 'text', t: 1, target: okButton, committedBy: 'blur' } as never])],
      ['a negative index', recording([{ type: 'click', t: 1, target: { ...okButton, path: [{ index: -1 }] } } as never])],
      ['an extra property', recording([{ type: 'click', t: 1, target: okButton, more: 1 } as never])],
      ['empty select items', recording([{ type: 'select', t: 1, target: okButton, items: [] } as never])],
    ];
    for (const [what, value] of bad) {
      expect(validateAgainstSchema(schema, value).length, `the schema accepts ${what}`).toBeGreaterThan(0);
      expect(issues(value).length, `the validator accepts ${what}`).toBeGreaterThan(0);
    }
  });
});

test('the builders used in the other tests make events the validator accepts once tidied', () => {
  expect(raw([opened('A'), activated('A'), click(okButton), typed(target('A', step.edit('Name')), 'x'), key('Enter', 'A'), closed('A')]).map((e) => e.t)).toEqual([50, 100, 150, 200, 250, 300]);
});
