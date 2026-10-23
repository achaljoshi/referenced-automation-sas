import { expect, test } from '@playwright/test';
import { AmbiguousLocatorError, DesktopElementNotFoundError, FakeDesktop, DesktopSession } from '../../src/desktop';
import { button, startDemo } from './demoDesktop';

const demo = () =>
  startDemo((w, { desktop, log }) => {
    const left = desktop.attach(w, { controlType: 'Pane', name: 'Left', automationId: 'left' });
    const right = desktop.attach(w, { controlType: 'Pane', name: 'Right', automationId: 'right' });
    desktop.attach(left, button('OK', log, { automationId: 'okLeft', className: 'JButton' }));
    desktop.attach(right, button('OK', log, { automationId: 'okRight', className: 'JButton' }));
    desktop.attach(right, button('Cancel', log, { automationId: 'cancel' }));
    desktop.attach(w, { controlType: 'Edit', name: 'Name:', automationId: 'nameField', value: 'abc' });
    desktop.attach(w, { controlType: 'Text', name: 'Status: ready to go' });
    desktop.attach(w, { controlType: 'CheckBox', name: 'Remember me', toggle: 'Off' });
  });

test.describe('strict locators', () => {
  test('a locator that matches more than one control is an error that lists them - for actions AND for reads', async () => {
    const d = await demo();
    const ok = d.app.window(/Demo/).getByName('OK');
    const error = (await ok.click().catch((e: unknown) => e)) as AmbiguousLocatorError;
    expect(error.message).toMatch(/is ambiguous: 2 controls match/);
    expect(error.message).toContain('#okLeft');
    expect(error.message).toContain('#okRight');
    expect(error.message).toMatch(/\.first\(\) \/ \.nth\(i\)/);
    expect(d.log).toEqual([]); // nothing was clicked
    await expect(ok.text()).rejects.toBeInstanceOf(AmbiguousLocatorError);
    await expect(ok.peek()).rejects.toBeInstanceOf(AmbiguousLocatorError);
    expect(await ok.count()).toBe(2); // counting is not an action: it just counts
    expect(await ok.exists()).toBe(true);
  });

  test('first(), last() and nth() choose on purpose; out of range is not found', async () => {
    const d = await demo();
    const ok = d.app.window(/Demo/).getByName('OK');
    await ok.first().click();
    await ok.last().click();
    await ok.nth(1).click();
    await ok.nth(0).click();
    expect(d.log).toEqual(['invoked okLeft', 'invoked okRight', 'invoked okRight', 'invoked okLeft']);
    const error = (await ok.nth(5).resolve(150).catch((e: unknown) => e)) as DesktopElementNotFoundError;
    expect(error).toBeInstanceOf(DesktopElementNotFoundError);
    expect(error.message).toContain('[5]');
  });

  test('chaining from a container makes an ambiguous name unique', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    await win.getByAutomationId('right').getByName('OK').click();
    await win.getByRole('Pane', { name: 'Left' }).getByRole('Button', { name: 'OK' }).click();
    expect(d.log).toEqual(['invoked okRight', 'invoked okLeft']);
  });

  test('getByName: exact by default, a part of the name with exact:false, a RegExp by pattern; getByRole, getByAutomationId, getByText, getByClassName', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    expect(await win.getByName('Remember').exists()).toBe(false); // exact
    expect(await win.getByName('Remember', { exact: false }).exists()).toBe(true);
    expect(await win.getByName('remember ME', { exact: false }).exists()).toBe(true); // case-insensitive
    expect(await win.getByName(/^Remember/).exists()).toBe(true);
    expect(await win.getByName(/^remember/).exists()).toBe(false); // a RegExp keeps its own flags (no i)
    expect(await win.getByName(/^remember/i).exists()).toBe(true);
    expect(await win.getByRole('Button', { name: 'Cancel' }).exists()).toBe(true);
    expect(await win.getByRole('button', { name: /^Can/ }).exists()).toBe(true); // control type is not case-sensitive
    expect(await win.getByRole('Edit', { name: 'OK' }).exists()).toBe(false);
    expect(await win.getByAutomationId('nameField').exists()).toBe(true);
    expect(await win.getByText('ready to').exists()).toBe(true);
    expect(await win.getByText('abc').exists()).toBe(true); // a value counts as text
    expect(await win.getByClassName('JButton').count()).toBe(2);
    expect(await win.getByRole('Button').count()).toBe(3);
  });

  test('nothing is looked up until you act: building locators sends no request', async () => {
    const d = await demo();
    const before = d.desktop.calls.length;
    const loc = d.app.window(/Demo/).getByAutomationId('right').getByName('OK').first();
    void loc.toString();
    expect(d.desktop.calls.length).toBe(before);
  });

  test('descriptions say what a locator looks for', async () => {
    const d = await demo();
    expect(String(d.app.window(/Demo/i).getByRole('Button', { name: 'OK' }).nth(1))).toBe('window /Demo/i > button named "OK" [1]');
    expect(String(d.app.window('Demo window').getByAutomationId('x'))).toBe('window "Demo window" > control with automation id "x"');
  });
});

test.describe('window locators', () => {
  test('a string is the exact title, a RegExp a pattern; two matching windows are ambiguous until narrowed', async () => {
    const d = await demo();
    d.desktop.addWindow(d.process, { title: 'Demo window 2' });
    expect(await d.app.window('Demo window').exists()).toBe(true);
    expect(await d.app.window('Demo').exists()).toBe(false);
    await expect(d.app.window(/Demo window/).peek()).rejects.toBeInstanceOf(AmbiguousLocatorError);
    expect((await d.app.window(/Demo window/).last().peek())?.name).toBe('Demo window 2');
    expect((await d.app.window(/Demo window \d/).peek())?.name).toBe('Demo window 2');
  });

  test('a window of another process is not found through this application', async () => {
    const d = await demo();
    d.desktop.addWindow(d.desktop.addProcess('other'), { title: 'Other thing' });
    expect(await d.app.window(/Other/).exists()).toBe(false);
    expect(await d.session.window(/Other/).exists()).toBe(true);
  });

  test('a dialog owned by a window (a child of it in the UI Automation tree) is found as a window too', async () => {
    const d = await demo();
    d.desktop.attach(d.window, { controlType: 'Window', name: 'Owned dialog', children: [{ controlType: 'Button', name: 'Yes' }] });
    const dialog = d.app.window('Owned dialog');
    expect((await dialog.peek())?.name).toBe('Owned dialog');
    expect(await dialog.getByRole('Button', { name: 'Yes' }).exists()).toBe(true);
    expect((await d.app.windows()).map((w) => w.name)).toEqual(['Demo window', 'Owned dialog']);
  });
});

test.describe('orElse fallbacks (reported, never silent)', () => {
  test('the primary wins when it matches: no drift', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    await win.getByAutomationId('cancel').orElse(win.getByName('Cancel')).click();
    expect(d.log).toEqual(['invoked cancel']);
    expect(d.session.driftItems).toEqual([]);
  });

  test('a missing primary falls back after a grace period and the drift is recorded with what was found', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    const startedAt = Date.now();
    await win.getByAutomationId('btnCancelOld').orElse(win.getByRole('Button', { name: 'Cancel' })).click();
    expect(d.log).toEqual(['invoked cancel']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600); // grace = a third of the timeout: a slow screen is not a changed locator
    expect(d.session.driftItems).toHaveLength(1);
    expect(d.session.driftItems[0]).toMatchObject({ expected: expect.stringContaining('btnCancelOld'), found: expect.stringContaining('#cancel') });
  });

  test('with fallbacks off an alternative is ignored', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Cancel', log, { automationId: 'cancel' })), { session: { fallbacks: 'off', timeoutMs: 300 } });
    const win = d.app.window(/Demo/);
    await expect(win.getByAutomationId('old').orElse(win.getByName('Cancel')).click()).rejects.toThrow(/no control matched/);
    expect(d.log).toEqual([]);
  });

  test('an ambiguous alternative is not used', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    await expect(win.getByAutomationId('gone').orElse(win.getByName('OK')).click({ idleAfter: true })).rejects.toThrow();
    expect(d.log).toEqual([]);
  });
});

test('a session with no windows says so', async () => {
  const session = new DesktopSession(new FakeDesktop(), { timeoutMs: 200, pollMs: 10 });
  const error = (await session.window(/Nothing/).resolve(100).catch((e: unknown) => e)) as DesktopElementNotFoundError;
  expect(error.message).toMatch(/no control matched window \/Nothing\/ after/);
  expect(error.message).toMatch(/no top-level window is open/);
});
