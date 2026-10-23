import { expect, test } from '@playwright/test';
import { clearRejectedLogons, FAKE_SMC_PATH, LogonRejected, SasManagementConsole, startFakeDesktop, type DialogMode, type RejectionStyle } from '../../src/desktop';
import { captureLogs } from './support';

// SAS Management Console flows against the fake Swing application. NOT VERIFIED against the real program.

const good = { user: 'sasdemo', password: 'Orion123' };
const bad = { user: 'sasdemo', password: 'WrongPassw0rd!' };
const profile = 'Dev Metadata Server';

test.beforeEach(() => clearRejectedLogons());

for (const dialogMode of ['toplevel', 'owned'] as DialogMode[]) {
  for (const rejection of ['inline', 'messagebox'] as RejectionStyle[]) {
    test.describe(`Management Console (dialogs ${dialogMode}, rejection ${rejection})`, () => {
      test('launch, choose the profile, log on, and reach the navigation tree', async () => {
        const fake = startFakeDesktop({ smc: { dialogMode, rejection } });
        const smc = await SasManagementConsole.launch(fake.session(), { config: { smcPath: FAKE_SMC_PATH } as never });
        await smc.logon(good, { profile });
        expect(fake.smc.profile).toBe(profile);
        expect(fake.smc.attempts).toEqual([{ user: 'sasdemo', accepted: true }]);
        await expect(smc.mainWindow.getByRole('Tree').resolve()).resolves.toMatchObject({ controlType: 'Tree' });
        await smc.dispose();
        expect(fake.desktop.processes.find((p) => p.name === 'sasmc')?.alive).toBe(false);
      });

      test('a rejected password raises LogonRejected with the application\'s message, cleans up its dialogs, and tries exactly once', async () => {
        const fake = startFakeDesktop({ smc: { dialogMode, rejection, lockoutAfter: 3 } });
        const smc = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
        const error = (await smc.logon(bad, { profile }).catch((e: unknown) => e)) as LogonRejected;
        expect(error).toBeInstanceOf(LogonRejected);
        expect(error.user).toBe('sasdemo');
        expect(error.profile).toBe(profile);
        expect(error.reason).toBe('Invalid user ID or password.');
        expect(error.message).toMatch(/NOT retried/);
        expect(error.message).not.toContain(bad.password);
        expect(fake.smc.attempts).toEqual([{ user: 'sasdemo', accepted: false }]); // ONE attempt, although the fake would have allowed three
        expect(fake.smc.failures).toBe(1);
        expect(fake.smc.locked).toBe(false);
        // nothing is left waiting for a second try
        expect(await smc.app.window(/Log ?On/i).exists()).toBe(false);
        expect(await smc.app.window(/Error/i).exists()).toBe(false);
      });
    });
  }
}

test.describe('Management Console logon safety', () => {
  test('the same rejected credentials are never typed again, even by a second logon() call', async () => {
    const fake = startFakeDesktop({ smc: { lockoutAfter: 3 } });
    const session = fake.session();
    const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
    await expect(smc.logon(bad, { profile })).rejects.toBeInstanceOf(LogonRejected);
    const typedBefore = fake.desktop.calls.filter((c) => c.op === 'setText').length;
    const again = (await smc.logon(bad, { profile }).catch((e: unknown) => e)) as LogonRejected;
    expect(again).toBeInstanceOf(LogonRejected);
    expect(again.reason).toMatch(/already rejected earlier in this run/);
    expect(fake.desktop.calls.filter((c) => c.op === 'setText').length).toBe(typedBefore); // nothing was typed
    expect(fake.smc.attempts).toHaveLength(1);
    // a second console launched in the same process is protected too
    const smc2 = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
    await expect(smc2.logon(bad, { profile })).rejects.toThrow(/already rejected/);
    expect(fake.smc.attempts).toHaveLength(1);
    // different credentials are not blocked
    await smc2.logon(good, { profile });
    expect(fake.smc.attempts.map((a) => a.accepted)).toEqual([false, true]);
  });

  test('an account that is locked says so (the reason is the application\'s own text)', async () => {
    const fake = startFakeDesktop({ smc: { lockoutAfter: 1 } });
    const first = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
    await expect(first.logon(bad, { profile })).rejects.toBeInstanceOf(LogonRejected);
    expect(fake.smc.locked).toBe(true);
    const second = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
    const error = (await second.logon({ ...good }, { profile }).catch((e: unknown) => e)) as LogonRejected;
    expect(error).toBeInstanceOf(LogonRejected);
    expect(error.reason).toBe('The account is locked.');
  });

  test('the password is typed into a secret field and appears in no log line, journal entry, error or step detail', async () => {
    const fake = startFakeDesktop();
    const session = fake.session();
    const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
    const captured = await captureLogs(() => smc.logon({ user: 'sasdemo', password: 'Orion123' }, { profile }));
    expect(captured.error).toBeUndefined();
    const everything = [...captured.lines, JSON.stringify(session.journal)].join('\n');
    expect(everything).not.toContain('Orion123');
    expect(everything).toContain('sasdemo'); // the user name is not a secret
    const typed = fake.desktop.calls.find((c) => c.op === 'setText' && c.text === 'Orion123');
    expect(typed).toMatchObject({ secret: true }); // it WAS typed, flagged secret for the bridge
  });

  test('a rejection leaves no password in the error, the log or the journal either', async () => {
    const fake = startFakeDesktop();
    const session = fake.session();
    const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
    const captured = await captureLogs(() => smc.logon(bad, { profile }));
    const everything = [...captured.lines, JSON.stringify(session.journal), String((captured.error as Error)?.message), String((captured.error as Error)?.stack)].join('\n');
    expect(everything).not.toContain(bad.password);
  });

  test('without a profile configured and a profile dialog showing, it says which setting to fill in instead of guessing', async () => {
    const fake = startFakeDesktop();
    const smc = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH, config: { smcProfile: undefined } as never });
    await expect(smc.logon(good)).rejects.toThrow(/SAS_SMC_PROFILE/);
    expect(fake.smc.attempts).toHaveLength(0);
  });

  test('a logon that finishes slowly is waited for (the application is busy), not mistaken for a failure', async () => {
    const fake = startFakeDesktop({ smc: { logonDelayMs: 300, appearDelayMs: 100 } });
    const smc = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
    await smc.logon(good, { profile });
    expect(fake.smc.attempts).toEqual([{ user: 'sasdemo', accepted: true }]);
  });

  test('a logon that neither succeeds nor shows a recognisable message is an error - dialog cancelled, not retried', async () => {
    const fake = startFakeDesktop({ smc: { logonDelayMs: 5_000 } });
    const smc = await SasManagementConsole.launch(fake.session({ timeoutMs: 600 }), { path: FAKE_SMC_PATH });
    const error = (await smc.logon(good, { profile }).catch((e: unknown) => e)) as Error;
    expect(error).not.toBeInstanceOf(LogonRejected);
    expect(error.message).toMatch(/did not finish logging on within 600ms.*NOT retried/s);
    expect(fake.smc.attempts).toHaveLength(1);
  });

  test('launching without SAS_SMC_PATH says what to set', async () => {
    const fake = startFakeDesktop();
    await expect(SasManagementConsole.launch(fake.session(), { config: { smcPath: undefined } as never })).rejects.toThrow(/SAS_SMC_PATH is not set/);
  });
});

test.describe('Management Console navigation (plug-in tree)', () => {
  async function loggedOn(options: Parameters<typeof startFakeDesktop>[0] = {}) {
    const fake = startFakeDesktop(options);
    const smc = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
    await smc.logon(good, { profile });
    return { fake, smc };
  }

  test('openPlugin expands the node it sits under and selects the plug-in; children of a collapsed node do not exist until then', async () => {
    const { fake, smc } = await loggedOn();
    const tree = smc.mainWindow.getByRole('Tree');
    expect(await tree.getByRole('TreeItem', { name: 'User Manager' }).exists()).toBe(false); // hidden while "Environment Management" is collapsed
    await smc.openPlugin('User Manager');
    expect(fake.smc.plugin).toBe('User Manager');
    expect((await tree.getByRole('TreeItem', { name: 'User Manager' }).snapshot())?.selected).toBe(true);
    await smc.openPlugin('Server Manager'); // second time: already expanded
    expect(fake.smc.plugin).toBe('Server Manager');
    await smc.openPlugin('Library Manager'); // framework name -> the console's name "Data Library Manager"
    expect(fake.smc.plugin).toBe('Data Library Manager');
  });

  test('every named plug-in can be opened', async () => {
    const { fake, smc } = await loggedOn();
    for (const [name, shown] of [['User Manager', 'User Manager'], ['Server Manager', 'Server Manager'], ['Metadata Manager', 'Metadata Manager'], ['Library Manager', 'Data Library Manager'], ['Schedule Manager', 'Schedule Manager']] as const) {
      await smc.openPlugin(name);
      expect(fake.smc.plugin).toBe(shown);
    }
    await expect(smc.openPlugin('Nonexistent Manager' as never)).rejects.toThrow(/unknown plug-in/);
  });

  test('listUsers, findUser, listGroups, listLibraries and serverStatus read what the screens show', async () => {
    const { smc } = await loggedOn();
    expect(await smc.listUsers()).toEqual(['Alice Analyst', 'Bob Builder', 'sasdemo']);
    expect(await smc.findUser('bob builder')).toBe('Bob Builder'); // case-insensitive, returns the listed spelling
    expect(await smc.findUser('Nobody')).toBeUndefined();
    expect(await smc.listGroups()).toEqual(['BI Users', 'SAS Administrators']);
    expect(await smc.listLibraries()).toEqual(['Orion', 'Sashelp', 'Stored Processes']);
    expect(await smc.serverStatus()).toEqual([
      { name: 'SASApp - Workspace Server', type: 'Workspace Server', status: 'Running' },
      { name: 'SASMeta - Metadata Server', type: 'Metadata Server', status: 'Running' },
      { name: 'SASApp - Stored Process Server', type: 'Stored Process Server', status: 'Stopped' },
    ]);
  });

  test('a user list switched to Groups and back is read for the right tab each time', async () => {
    const { smc } = await loggedOn({ smc: { users: ['u1'], groups: ['g1', 'g2'] } });
    expect(await smc.listGroups()).toEqual(['g1', 'g2']);
    expect(await smc.listUsers()).toEqual(['u1']);
  });

  test('a list that is still filling is read until it is stable, not returned half loaded', async () => {
    const { fake, smc } = await loggedOn({ smc: { users: ['a'] } });
    await smc.openPlugin('User Manager');
    const table = smc.mainWindow.getByRole('Table');
    await table.resolve();
    // rows arrive over time while the list is being read
    const timers = ['b', 'c'].map((name, i) => setTimeout(() => {
      const tableEl = fake.smc.main?.find((e) => e.controlType === 'Table');
      if (tableEl) fake.desktop.attach(tableEl, { controlType: 'DataItem', name });
    }, 60 * (i + 1)));
    const users = await smc.listUsers();
    timers.forEach(clearTimeout);
    expect(users).toEqual(['a', 'b', 'c']);
  });
});

test.describe('Management Console and the Java Access Bridge', () => {
  test('without the Java Access Bridge the window is empty to UI Automation: the logon fails with what IS on the screen, and diagnoseJava names the symptom', async () => {
    const fake = startFakeDesktop({ smc: { javaAccessBridge: false }, environment: { accessBridgeDll: false } } as never);
    const smc = await SasManagementConsole.launch(fake.session({ timeoutMs: 400 }), { path: FAKE_SMC_PATH });
    const error = (await smc.logon(good, { profile }).catch((e: unknown) => e)) as Error;
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(LogonRejected);
    expect(error.message).toMatch(/controls \(none found - for a Java application check the Java Access Bridge/);
    expect(fake.smc.attempts).toHaveLength(0); // it never typed a password into anything
    const java = (await smc.diagnoseJava()) as { windows: Array<{ suspectedBridgeMissing: boolean; title: string }> };
    expect(java.windows).toHaveLength(1);
    expect(java.windows[0]).toMatchObject({ title: 'SAS Management Console', suspectedBridgeMissing: true });
  });

  test('with the bridge enabled the same window is not suspect', async () => {
    const fake = startFakeDesktop();
    const smc = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
    const java = (await smc.diagnoseJava()) as { windows: Array<{ suspectedBridgeMissing: boolean }> };
    expect(java.windows.every((w) => !w.suspectedBridgeMissing)).toBe(true);
  });
});
