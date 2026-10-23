import { expect, test } from '@playwright/test';
import { coalesce, validateRecording, type RawEvent, type RecordedEvent } from '../../src/recorder';
import { activated, click, closed, invoke, key, opened, raw, step, target, typed } from './support/events';

const W = 'Log On';
const user = target(W, step.edit('User ID:', { automationId: 'userIdField' }));
const password = target(W, step.edit('Password:'));
const ok = target(W, step.button('OK'));
const types = (events: RecordedEvent[]) => events.map((e) => e.type);
const run = (events: Parameters<typeof raw>[0], gap?: number) => coalesce(raw(events, gap));

test.describe('typing', () => {
  test('consecutive typed events on one field are one text entry with the last value', () => {
    const { events } = run([typed(user, 's'), typed(user, 'sa'), typed(user, 'sas'), click(ok)]);
    expect(types(events)).toEqual(['text', 'click']);
    expect(events[0]).toMatchObject({ type: 'text', value: 'sas', committedBy: 'blur' });
  });

  test('Enter or Tab right after it says how it was committed - and belongs to the field, not a key step', () => {
    const enter = run([typed(user, 'sas'), key('Enter', W), click(ok)]).events;
    expect(types(enter)).toEqual(['text', 'click']);
    expect(enter[0]).toMatchObject({ committedBy: 'enter' });
    const tab = run([typed(user, 'sas'), key('Tab', W), typed(password, 'x')]).events;
    expect(tab[0]).toMatchObject({ committedBy: 'tab' });
    expect(types(tab)).toEqual(['text', 'text']);
    // the bridge may say it itself
    expect(run([typed(user, 'sas', { committedBy: 'enter' })]).events[0]).toMatchObject({ committedBy: 'enter' });
    // Enter in a different window is a key of its own
    expect(types(run([typed(user, 'sas'), key('Enter', 'Other')]).events)).toEqual(['text', 'key']);
  });

  test('two fields are two entries; typing, a click elsewhere, typing again is three', () => {
    const { events } = run([typed(user, 'a'), typed(password, 'x'), click(ok), typed(user, 'b')]);
    expect(types(events)).toEqual(['text', 'text', 'click', 'text']);
  });

  test('a click that only put the cursor into the field the user then typed into is not a step', () => {
    expect(types(run([click(user), typed(user, 'sas')]).events)).toEqual(['text']);
    expect(types(run([click(ok), typed(user, 'sas')]).events)).toEqual(['click', 'text']); // another control: it stays
  });

  test('an emptied field is a text entry with an empty value', () => {
    expect(run([typed(user, '')]).events[0]).toMatchObject({ type: 'text', value: '' });
  });
});

test.describe('secrets (the recording never has one)', () => {
  const typedSecret = 'hunter2-Zq9!';

  test('a typed event flagged secret loses whatever value came with it', () => {
    const result = coalesce(raw([{ type: 'typed', target: password, secret: true, secretKind: 'password', value: typedSecret } as never]));
    expect(result.events[0]).toEqual(expect.objectContaining({ type: 'text', secret: true, secretKind: 'password' }));
    expect(JSON.stringify(result)).not.toContain(typedSecret);
    expect(result.stats.secretEntries).toBe(1);
  });

  test('a field whose name says secret is a secret entry even when the bridge did not flag it', () => {
    for (const [field, kind] of [['Password:', 'password'], ['Your PIN', 'pin'], ['API Key', 'key'], ['Access token', 'token']] as const) {
      const result = coalesce(raw([typed(target(W, step.edit(field)), typedSecret)]));
      expect(result.events[0], field).toMatchObject({ type: 'text', secret: true, secretKind: kind });
      expect(JSON.stringify(result), field).not.toContain(typedSecret);
    }
    // negative control: a field that is not secret keeps its value
    expect(coalesce(raw([typed(user, 'sasdemo')])).events[0]).toMatchObject({ value: 'sasdemo' });
  });

  test('merging a secret burst keeps only the fact, and a secret entry can still be committed with Enter', () => {
    const result = coalesce(
      raw([
        { type: 'typed', target: password, secret: true, secretKind: 'password' } as never,
        { type: 'typed', target: password, secret: true, secretKind: 'password' } as never,
        key('Enter', W),
      ]),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'text', secret: true, committedBy: 'enter' });
    expect(result.events[0]).not.toHaveProperty('value');
  });

  test('a burst where only the later events are flagged is still secret', () => {
    const result = coalesce(raw([typed(user, 'abc'), { type: 'typed', target: user, secret: true } as never]));
    expect(result.events[0]).toMatchObject({ secret: true });
    expect(JSON.stringify(result)).not.toContain('abc');
  });

  test('key presses that would type a character are dropped and counted; shortcuts survive', () => {
    const result = run([key('a', W), key('Shift+Q', W), key('Space', W), key('7', W), key('Ctrl+S', W), key('F5', W), key('Escape', W)]);
    expect(result.events.map((e) => (e as { keys: string }).keys)).toEqual(['Ctrl+S', 'F5', 'Escape']);
    expect(result.stats.printableKeysDropped).toBe(4);
  });

  test('a key aimed at a secret field is dropped unless it carries no content (Enter, Tab, Escape)', () => {
    const aimed = (keys: string) => ({ ...key(keys, W), target: password }) as never;
    const result = coalesce(raw([aimed('Ctrl+V'), aimed('F2'), aimed('Escape')]));
    expect(result.events.map((e) => (e as { keys: string }).keys)).toEqual(['Escape']);
    expect(result.stats.printableKeysDropped).toBe(2);
  });
});

test.describe('clicks and what they cause', () => {
  test('a click and the invoke it raised are one click, whichever came first', () => {
    expect(types(run([click(ok), invoke(ok)]).events)).toEqual(['click']);
    expect(types(run([invoke(ok), click(ok)]).events)).toEqual(['click']);
    expect(types(run([click(ok), opened('Next'), invoke(ok)]).events)).toEqual(['click', 'windowOpened']); // a window opened in between stays, after the step
  });

  test('an invoke with no click (the keyboard) is a click; Enter on a button is not a second step', () => {
    expect(run([invoke(ok)]).events[0]).toMatchObject({ type: 'click' });
    expect(types(run([key('Enter', W), invoke(ok)]).events)).toEqual(['click']);
    expect(types(run([key('Enter', W)]).events)).toEqual(['key']);
  });

  test('two quick clicks on one control are a double click; slow ones, or on different controls, are not', () => {
    expect(types(run([click(ok), click(ok)], 100).events)).toEqual(['doubleClick']);
    expect(types(run([click(ok), click(ok)], 900).events)).toEqual(['click', 'click']);
    expect(types(run([click(ok), click(target(W, step.button('Cancel')))], 100).events)).toEqual(['click', 'click']);
    expect(types(run([click(ok), click(ok), click(ok)], 100).events)).toEqual(['doubleClick', 'click']);
    expect(types(run([{ type: 'rightClick', target: ok } as never]).events)).toEqual(['rightClick']);
  });

  test('a click and the toggle it caused are one toggle with the new state; a toggle by keyboard stands alone', () => {
    const box = target(W, step.check('Remember me'));
    const merged = run([click(box), { type: 'toggled', target: box, state: true } as never]).events;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ type: 'toggle', state: true });
    expect(run([{ type: 'toggled', target: box, state: false } as never]).events[0]).toMatchObject({ type: 'toggle', state: false });
  });

  test('a click and the expansion it caused are one expand (or collapse), also after a double click', () => {
    const node = target('Main', step.node('Environment'));
    expect(run([click(node), { type: 'expanded', target: node } as never]).events[0]).toMatchObject({ type: 'expand' });
    expect(run([click(node), { type: 'collapsed', target: node } as never]).events[0]).toMatchObject({ type: 'collapse' });
    expect(types(run([click(node), click(node), { type: 'expanded', target: node } as never], 100).events)).toEqual(['expand']);
    expect(run([{ type: 'expanded', target: node } as never]).events[0]).toMatchObject({ type: 'expand' });
  });

  test('a click on a tree item that was selected and expanded is a select and an expand', () => {
    const tree = step.node('Tree', { controlType: 'Tree' });
    const node = target('Main', tree, step.node('Users'));
    const events = run([click(node), { type: 'selected', target: node } as never, { type: 'expanded', target: node } as never]).events;
    expect(types(events)).toEqual(['select', 'expand']);
    expect(events[0]).toMatchObject({ items: ['Users'], target: { path: [tree] } });
  });
});

test.describe('selections', () => {
  const list = step.list('Profiles');
  const item = (name: string) => target(W, list, step.item(name));
  const selected = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'selected', target: item(name), ...extra }) as never;

  test('a click and the selection it caused are one select, in the list (its container is the parent when the bridge did not say)', () => {
    const events = run([click(item('Dev')), selected('Dev')]).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'select', items: ['Dev'], target: { path: [list] } });
    const explicit = run([selected('Dev', { container: target(W, step.list('Other')) })]).events[0];
    expect(explicit).toMatchObject({ target: { path: [step.list('Other')] } });
  });

  test('a burst of selections in one list (arrow keys) is the last one; items ADDED to the selection accumulate', () => {
    expect(run([selected('A'), selected('B'), selected('C')], 100).events).toMatchObject([{ type: 'select', items: ['C'] }]);
    expect(run([selected('A'), selected('B', { added: true }), selected('C', { added: true })], 100).events).toMatchObject([{ type: 'select', items: ['A', 'B', 'C'] }]);
    expect(types(run([selected('A'), selected('B')], 1000).events)).toEqual(['select', 'select']); // too far apart to be one burst
  });

  test('an item with no name cannot be selected by name: the click is kept; so is an item with no container', () => {
    const unnamed = { type: 'selected', target: target(W, list, { controlType: 'ListItem' }) } as never;
    expect(run([unnamed]).events[0]).toMatchObject({ type: 'click' });
    const orphan = { type: 'selected', target: target(W, step.item('Lonely')) } as never;
    expect(run([orphan]).events[0]).toMatchObject({ type: 'click' });
  });
});

test.describe('menus', () => {
  const file = target('Main', step.menu('File'));
  const open = target('Main', step.menu('File'), step.menu('Open'));

  test('clicks through a menu are one path', () => {
    const events = run([click(file), invoke(file), click(open), invoke(open)], 300).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'menu', path: ['File', 'Open'], window: { titlePattern: '^Main$' } });
  });

  test('a long pause, or another kind of step, ends the path; popups opening as windows do not', () => {
    expect(types(run([click(file), click(open)], 9000).events)).toEqual(['menu', 'menu']);
    expect(types(run([click(file), click(ok), click(open)], 300).events)).toEqual(['menu', 'click', 'menu']);
    const popup = run([click(file), opened('Popup'), closed('Popup'), click(open)], 300).events;
    expect(popup).toMatchObject([{ type: 'menu', path: ['File', 'Open'] }]);
  });

  test('a menu item with no name stays a click', () => {
    expect(run([click(target('Main', { controlType: 'MenuItem' }))]).events[0]).toMatchObject({ type: 'click' });
  });
});

test.describe('dialogs', () => {
  const tip = target('Tip of the Day', step.button('Close'));

  test('a dialog that opened, had one button pressed and closed is a handled dialog', () => {
    const events = run([opened('Tip of the Day', { className: '#32770' }), click(tip), invoke(tip), closed('Tip of the Day'), click(ok)]).events;
    expect(events).toMatchObject([{ type: 'dialogHandled', title: 'Tip of the Day', button: 'Close' }, { type: 'click' }]);
    expect(run([opened('Notice', { owned: true }), click(target('Notice', step.button('OK'))), closed('Notice')]).events[0]).toMatchObject({ type: 'dialogHandled' });
  });

  test('anything more than one button press is a dialog with its own steps', () => {
    const name = target('Tip of the Day', step.edit('Name'));
    expect(types(run([opened('Tip of the Day', { className: '#32770' }), typed(name, 'x'), click(tip), closed('Tip of the Day')]).events)).toEqual(['windowOpened', 'text', 'click', 'windowClosed']);
    expect(types(run([opened('Tip of the Day', { className: '#32770' }), click(tip), click(target('Tip of the Day', step.button('Other'))), closed('Tip of the Day')], 700).events)).toContain('windowOpened');
    // it never closed: nothing is claimed
    expect(types(run([opened('Tip of the Day', { className: '#32770' }), click(tip)]).events)).toEqual(['windowOpened', 'click']);
  });

  test('a window that is not a dialog (a program window) is never turned into a handler', () => {
    expect(types(run([opened('Main', { className: 'HwndWrapper' }), click(target('Main', step.button('Go'))), closed('Main')]).events)).toEqual(['windowOpened', 'click', 'windowClosed']);
  });
});

test.describe('windows', () => {
  test('a window activated right after it opened, or twice, is said once', () => {
    expect(types(run([opened('A'), activated('A'), activated('A'), opened('B'), activated('B'), activated('A')]).events)).toEqual(['windowOpened', 'windowOpened', 'windowActivated']);
    expect(types(run([opened('A'), closed('A'), activated('A')]).events)).toEqual(['windowOpened', 'windowClosed', 'windowActivated']);
  });
});

test.describe('housekeeping', () => {
  test('malformed raw events are dropped and counted, never thrown at', () => {
    const result = coalesce([
      { type: 'click', t: 1 } as never,
      { type: 'warp', t: 2 } as never,
      { type: 'typed', t: 3, target: user } as never,
      { type: 'key', t: 4, keys: 'Hyper+Q', window: user.window } as never,
      null as never,
      { type: 'windowOpened', t: 5 } as never,
      { type: 'click', t: 6, target: ok } as RawEvent,
    ]);
    expect(types(result.events)).toEqual(['click']);
    expect(result.stats.invalidDropped).toBe(6);
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings[0]).toMatch(/raw event 1 dropped: click without a target/);
  });

  test('time never runs backwards, the input is not changed, and the same input gives the same output', () => {
    const input = raw([typed(user, 'a'), click(ok), opened('X')]);
    const copy = JSON.parse(JSON.stringify(input)) as RawEvent[];
    const first = coalesce(input);
    expect(input).toEqual(copy);
    expect(coalesce(copy)).toEqual(first);
    const shuffled = coalesce([{ ...click(ok), t: 500 } as RawEvent, { ...click(target(W, step.button('Cancel'))), t: 100 } as RawEvent]);
    expect(shuffled.events.map((e) => e.t)).toEqual([500, 500]);
  });

  test('what comes out of a realistic session is a valid recording', () => {
    const { events } = run([
      opened('SAS Logon'),
      typed(user, 'sasdemo'),
      { type: 'typed', target: password, secret: true } as never,
      key('Enter', W),
      click(ok),
      invoke(ok),
      closed('SAS Logon'),
      key('Ctrl+O', 'Main'),
    ]);
    const result = validateRecording({ version: 1, app: 'eg', startedAt: '2026-10-23T09:00:00.000Z', tool: 'test', events });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
