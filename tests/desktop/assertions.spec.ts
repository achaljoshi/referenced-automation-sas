import { expect, test } from '@playwright/test';
import { closeness, desktopExpect } from '../../src/desktop';
import { button, startDemo } from './demoDesktop';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string) => text.replace(ANSI, '');

const demo = () =>
  startDemo((w, { desktop, log }) => {
    desktop.attach(w, button('OK', log, { automationId: 'okButton' }));
    desktop.attach(w, button('Cancel', log, { automationId: 'cancelButton', enableAfterMs: 250 }));
    desktop.attach(w, { controlType: 'Edit', name: 'User ID:', automationId: 'userId', value: 'sasdemo' });
    desktop.attach(w, { controlType: 'Edit', name: 'Password:', automationId: 'pwd', value: 'hunter2-SECRET', isPassword: true });
    desktop.attach(w, { controlType: 'Text', name: 'Connected to Dev' });
    desktop.attach(w, { controlType: 'CheckBox', name: 'Remember me', toggle: 'On' });
    desktop.attach(w, { controlType: 'ListItem', name: 'Profile A', selectable: true, selected: true });
    desktop.attach(w, { controlType: 'ListItem', name: 'Profile B', selectable: true });
  });

test.describe('desktop assertions retry like Playwright\'s', () => {
  test('toExist waits for a control that appears late, and .not waits for one that goes away', async () => {
    const d = await startDemo((w, { desktop }) => {
      desktop.attach(w, { controlType: 'Text', name: 'Later', appearAfterMs: 200 });
      const going = desktop.attach(w, { controlType: 'Text', name: 'Going' });
      setTimeout(() => desktop.dispose(going), 200);
    });
    const win = d.app.window(/Demo/);
    await desktopExpect(win.getByName('Later')).toExist({ timeout: 1500 });
    await desktopExpect(win.getByName('Going')).not.toExist({ timeout: 1500 });
  });

  test('toBeEnabled waits for a control to become enabled; fails (with the state) when it does not', async () => {
    const d = await demo();
    const cancel = d.app.window(/Demo/).getByName('Cancel');
    await desktopExpect(cancel).toBeEnabled({ timeout: 1500 });
    const never = d.app.window(/Demo/).getByName('Never there');
    const failure = (await desktopExpect(never).toBeEnabled({ timeout: 150 }).catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/toBeEnabled/);
    expect(failure.message).toMatch(/control not on the screen/);
  });

  test('toHaveText / toContainText: strings and patterns, retried until the text changes', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    await desktopExpect(win.getByName('User ID:')).toHaveText('sasdemo');
    await desktopExpect(win.getByName('User ID:')).toContainText('SASD'); // contains is case-insensitive
    await desktopExpect(win.getByName('User ID:')).toHaveText(/^sas/);
    await desktopExpect(win.getByName('User ID:')).not.toHaveText('other');
    await desktopExpect(win.getByName('Connected to Dev')).toHaveText('Connected to Dev'); // no value: the name is the text
    setTimeout(() => {
      const edit = d.window.find((e) => e.name === 'User ID:');
      if (edit) edit.value = 'changed later';
    }, 200);
    await desktopExpect(win.getByName('User ID:')).toHaveText('changed later', { timeout: 1500 });
    const failure = (await desktopExpect(win.getByName('User ID:')).toHaveText('nope', { timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(plain(failure.message)).toContain('Expected: "nope"');
    expect(plain(failure.message)).toContain('Received: "changed later"');
  });

  test('toBeSelected and toBeChecked', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    await desktopExpect(win.getByName('Profile A')).toBeSelected();
    await desktopExpect(win.getByName('Profile B')).not.toBeSelected();
    await win.getByName('Profile B').select();
    await desktopExpect(win.getByName('Profile B')).toBeSelected();
    await desktopExpect(win.getByName('Profile A')).not.toBeSelected(); // selecting one deselects its siblings
    await desktopExpect(win.getByName('Remember me')).toBeChecked();
    await win.getByName('Remember me').uncheck();
    await desktopExpect(win.getByName('Remember me')).not.toBeChecked();
    const failure = (await desktopExpect(win.getByName('Remember me')).toBeChecked({ timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(failure.message).toContain('not checked');
  });

  test('a window\'s toHaveTitle follows the title as it changes', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    await desktopExpect(win).toHaveTitle('Demo window');
    await desktopExpect(win).toHaveTitle(/^Demo/);
    setTimeout(() => (d.window.name = 'Sales - Demo window'), 200);
    await desktopExpect(d.app.window(/Demo window/)).toHaveTitle(/^Sales/, { timeout: 1500 });
    await desktopExpect(d.app.window(/Demo window/)).not.toHaveTitle(/Other/);
  });
});

test.describe('"On the screen now" diagnostics when a control is missing', () => {
  test('lists the window, the controls with names and ids, and the closest match', async () => {
    const d = await demo();
    const failure = (await desktopExpect(d.app.window(/Demo/).getByName('Okay')).toExist({ timeout: 100 }).catch((e: unknown) => e)) as Error;
    const text = failure.message;
    expect(text).toContain('On the screen now (window "Demo window"');
    expect(text).toContain(`pid ${d.process.pid}`);
    expect(text).toContain('Button "OK" #okButton');
    expect(text).toContain('Button "Cancel" #cancelButton');
    expect(text).toContain('Edit "User ID:" #userId');
    expect(text).toMatch(/Closest to "Okay": Button "OK" #okButton/);
  });

  test('an automation id that is missing is matched against ids ("okBtn" -> okButton)', async () => {
    const d = await demo();
    const failure = (await desktopExpect(d.app.window(/Demo/).getByAutomationId('okButon')).toExist({ timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/Closest to "okButon": Button "OK" #okButton/);
  });

  test('a password is never shown: not its value, not in the control list, and the field is marked', async () => {
    const d = await demo();
    const failure = (await desktopExpect(d.app.window(/Demo/).getByName('Missing')).toExist({ timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(failure.message).not.toContain('hunter2');
    expect(failure.message).not.toContain('SECRET');
    expect(failure.message).toContain('Edit "Password:" #pwd (password field)');
    expect(failure.message).not.toContain('sasdemo'); // no input field's value is listed at all, not just passwords
  });

  test('toHaveText on a password field never matches and never reveals it, whatever is expected', async () => {
    const d = await demo();
    const pwd = d.app.window(/Demo/).getByName('Password:');
    const failure = (await desktopExpect(pwd).toHaveText('my guess', { timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeDefined();
    expect(failure.message).not.toContain('hunter2-SECRET'); // the real value is never read
    expect(plain(failure.message)).toContain('Received: "(password field - not shown)"');
    const exact = (await desktopExpect(pwd).toHaveText('hunter2-SECRET', { timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(exact).toBeDefined(); // even the right guess must NOT pass: a test cannot confirm a password by assertion
    await desktopExpect(pwd).not.toHaveText('hunter2-SECRET'); // .not passes: nothing is ever read
  });

  test('a window that is missing is described by what IS open', async () => {
    const d = await demo();
    d.desktop.addWindow(d.process, { title: 'Log On', children: [{ controlType: 'Button', name: 'OK' }] });
    const failure = (await desktopExpect(d.app.window(/Missing dialog/)).toExist({ timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/On the screen now \(window "(Demo window|Log On)"/);
    expect(failure.message).toMatch(/Another window is open \("(Demo window|Log On)"\)/);
  });

  test('the message is bounded: a window with hundreds of controls lists a few and says how many there are', async () => {
    const d = await startDemo((w, { desktop }) => {
      for (let i = 0; i < 300; i++) desktop.attach(w, { controlType: 'Button', name: `Button number ${i}`, automationId: `b${i}` });
    });
    const failure = (await desktopExpect(d.app.window(/Demo/).getByName('Missing')).toExist({ timeout: 100 }).catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/controls \(25 of 300\)/);
    expect(failure.message.length).toBeLessThan(5000);
  });
});

test('closeness: containment is 0, a typo is its distance, unrelated is undefined', () => {
  expect(closeness('ok', 'OK')).toBe(0);
  expect(closeness('Okay', 'OK')).toBe(0); // 'okay' contains 'ok'
  expect(closeness('Cancle', 'Cancel')).toBe(2);
  expect(closeness('Cancel', 'Banana')).toBeUndefined();
  expect(closeness('', 'x')).toBeUndefined();
});
