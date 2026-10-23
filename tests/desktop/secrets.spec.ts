import { expect, test } from '@playwright/test';
import { describeCommand, type DesktopCommand, formatInspection, inspectWindows, looksSecret, redactCommand, REDACTED, scrub } from '../../src/desktop';
import { startDemo } from './demoDesktop';
import { captureLogs } from './support';

const PASSWORD = 'Tr0ub4dor&3-never-print';

const demo = () =>
  startDemo((w, { desktop }) => {
    desktop.attach(w, { controlType: 'Edit', name: 'Password:', automationId: 'pwd', value: '', isPassword: true });
    desktop.attach(w, { controlType: 'Edit', name: 'Secret answer', value: '' }); // a name that looks secret, but a plain Edit
    desktop.attach(w, { controlType: 'Edit', name: 'Kennung', automationId: 'plainField', value: '', isPassword: true }); // a neutral name, but the control says IsPassword
    desktop.attach(w, { controlType: 'Edit', name: 'Comment', value: '' });
  });

test.describe('what looks secret', () => {
  test('names that look like a secret, and names that do not', () => {
    for (const name of ['Password:', 'password', 'txtPassword', 'Passwort-ish passwd', 'PWD', 'Secret answer', 'API key', 'api_key', 'Access token', 'credentials', 'PIN', 'Passphrase']) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ['User ID:', 'Comment', 'Spinner', 'Compass', 'Bypass', 'Passing grade', 'Pinned items', '', undefined]) {
      expect(looksSecret(name), String(name)).toBe(false);
    }
    expect(looksSecret('User', 'passwordField')).toBe(true); // any of the names given
  });

  test('redactCommand and describeCommand hide typed text, keys, values and arguments of a secret command - and only of those', () => {
    expect(redactCommand({ op: 'setText', ref: 'e1', text: PASSWORD, secret: true })).toMatchObject({ text: REDACTED });
    expect(redactCommand({ op: 'sendKeys', keys: PASSWORD, secret: true })).toMatchObject({ keys: REDACTED });
    expect(redactCommand({ op: 'com.set', handle: 'o1', path: 'P', value: PASSWORD, secret: true })).toMatchObject({ value: REDACTED });
    expect(redactCommand({ op: 'com.call', handle: 'o1', method: 'Login', args: ['u', PASSWORD], secret: true })).toMatchObject({ args: [REDACTED, REDACTED] });
    expect(redactCommand({ op: 'setText', ref: 'e1', text: 'visible' })).toMatchObject({ text: 'visible' });
    const secretCommands: DesktopCommand[] = [
      { op: 'setText', ref: 'e1', text: PASSWORD, secret: true },
      { op: 'sendKeys', keys: PASSWORD, secret: true },
      { op: 'com.call', handle: 'o1', method: 'Login', args: ['u', PASSWORD], secret: true },
    ];
    for (const command of secretCommands) {
      expect(describeCommand(command)).not.toContain(PASSWORD);
    }
    expect(describeCommand({ op: 'setText', ref: 'e1', text: 'visible' })).toContain('"visible"');
  });

  test('scrub removes given secrets from any text, but not short fragments that would mangle it', () => {
    expect(scrub(`login failed for password ${PASSWORD}!`, [PASSWORD])).toBe(`login failed for password ${REDACTED}!`);
    expect(scrub('ab', ['a'])).toBe('ab');
    expect(scrub('x', [undefined])).toBe('x');
  });
});

test.describe('typing into secret fields', () => {
  test('a field the control reports as IsPassword is secret whatever it is called: flagged for the bridge, absent from logs, journal and step details', async () => {
    const d = await demo();
    const captured = await captureLogs(() => d.app.window(/Demo/).getByAutomationId('plainField').fill(PASSWORD));
    expect(captured.error).toBeUndefined();
    const sent = d.desktop.calls.find((c) => c.op === 'setText');
    expect(sent).toMatchObject({ text: PASSWORD, secret: true }); // delivered, flagged
    const everything = [...captured.lines, JSON.stringify(d.session.journal)].join('\n');
    expect(everything).not.toContain(PASSWORD);
  });

  test('a field with a secret-looking name is secret even without IsPassword; fill({secret:true}) forces it', async () => {
    const d = await demo();
    const win = d.app.window(/Demo/);
    const captured = await captureLogs(async () => {
      await win.getByName('Secret answer').fill(PASSWORD);
      await win.getByName('Comment').fill(PASSWORD, { secret: true });
    });
    expect(captured.error).toBeUndefined();
    const flagged = d.desktop.calls.filter((c) => c.op === 'setText').map((c) => (c as { secret?: boolean }).secret);
    expect(flagged).toEqual([true, true]);
    expect([...captured.lines, JSON.stringify(d.session.journal)].join('\n')).not.toContain(PASSWORD);
  });

  test('an ordinary field is logged (so a test can be followed) and is not flagged', async () => {
    const d = await demo();
    const captured = await captureLogs(() => d.app.window(/Demo/).getByName('Comment').fill('visible text'));
    expect(captured.lines.join('\n')).toContain('visible text');
    expect(d.desktop.calls.find((c) => c.op === 'setText')).toMatchObject({ text: 'visible text', secret: false });
  });

  test('press() of a secret is masked too, and verify is never done for a secret (it would read the password back)', async () => {
    const d = await demo();
    const captured = await captureLogs(async () => {
      await d.app.window(/Demo/).getByAutomationId('plainField').press(PASSWORD, { secret: true });
      await d.app.window(/Demo/).getByAutomationId('plainField').fill(PASSWORD, { verify: true });
    });
    expect(captured.error).toBeUndefined();
    expect(d.desktop.calls.filter((c) => c.op === 'getText')).toHaveLength(0);
    expect([...captured.lines, JSON.stringify(d.session.journal)].join('\n')).not.toContain(PASSWORD);
  });

  test('a failure while typing a secret does not put it in the error or the log', async () => {
    const d = await demo();
    const real = d.desktop.request.bind(d.desktop);
    d.desktop.request = async (c) => {
      if (c.op === 'setText') throw new Error('the control rejected the text'); // a bridge error never echoes the text
      return real(c);
    };
    const captured = await captureLogs(() => d.app.window(/Demo/).getByAutomationId('plainField').fill(PASSWORD));
    const everything = [String((captured.error as Error).message), String((captured.error as Error).stack), ...captured.lines, JSON.stringify(d.session.journal)].join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).toContain('the control rejected the text');
  });

  test('what a password field holds is never read: info, getText, text(), tree dumps and the inspect output are empty or absent', async () => {
    const d = await demo();
    const pwd = d.app.window(/Demo/).getByAutomationId('plainField');
    await pwd.fill(PASSWORD);
    expect((await pwd.info()).value).toBe('');
    expect(await pwd.text()).toBe('');
    const inspected = await inspectWindows(d.session, /Demo/);
    const shown = formatInspection(inspected);
    expect(shown).not.toContain(PASSWORD);
    expect(shown).toContain('PASSWORD FIELD - value never read');
    expect(JSON.stringify(inspected)).not.toContain(PASSWORD);
    // and a plain edit's value is not part of the dump either (only names, ids, types)
    await d.app.window(/Demo/).getByName('Comment').fill('visible text');
    expect(JSON.stringify(await inspectWindows(d.session, /Demo/))).not.toContain('visible text');
  });
});
