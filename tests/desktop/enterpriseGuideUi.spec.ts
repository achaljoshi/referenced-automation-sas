import { expect, test } from '@playwright/test';
import { clearRejectedLogons, FAKE_EG_PATH, FAKE_PROJECT_PATH, LogonRejected, SasEnterpriseGuideUi, startFakeDesktop, type DialogMode, type RejectionStyle } from '../../src/desktop';

// Enterprise Guide's own screens (the SECOND route; COM is the first) against the fake WPF application. NOT VERIFIED against the real program.

const good = { user: 'sasdemo', password: 'Orion123' };
const bad = { user: 'sasdemo', password: 'WrongPassw0rd!' };
const profile = 'Dev SAS Server';

test.beforeEach(() => clearRejectedLogons());

for (const dialogMode of ['toplevel', 'owned'] as DialogMode[]) {
  for (const rejection of ['messagebox', 'inline'] as RejectionStyle[]) {
    test.describe(`Enterprise Guide UI (dialogs ${dialogMode}, rejection ${rejection})`, () => {
      test('connect: Connect button, profile, logon dialog, connected', async () => {
        const fake = startFakeDesktop({ eg: { dialogMode, rejection } });
        const eg = await SasEnterpriseGuideUi.launch(fake.session(), { path: FAKE_EG_PATH });
        await eg.connect(good, { profile });
        expect(fake.eg.profile).toBe(profile);
        expect(fake.eg.attempts).toEqual([{ user: 'sasdemo', accepted: true }]);
        await eg.dispose();
      });

      test('a rejected password is LogonRejected, cleaned up, tried once - never retried', async () => {
        const fake = startFakeDesktop({ eg: { dialogMode, rejection, lockoutAfter: 3 } });
        const eg = await SasEnterpriseGuideUi.launch(fake.session(), { path: FAKE_EG_PATH });
        const error = (await eg.connect(bad, { profile }).catch((e: unknown) => e)) as LogonRejected;
        expect(error).toBeInstanceOf(LogonRejected);
        expect(error.reason).toBe('Invalid user ID or password.');
        expect(fake.eg.attempts).toHaveLength(1);
        expect(await eg.app.window(/SAS Logon/i).exists()).toBe(false);
        expect(await eg.app.window(/Error/i).exists()).toBe(false);
        await expect(eg.connect(bad, { profile })).rejects.toThrow(/already rejected/);
        expect(fake.eg.attempts).toHaveLength(1);
      });
    });
  }
}

test.describe('Enterprise Guide UI: projects and programs', () => {
  async function connected(options: Parameters<typeof startFakeDesktop>[0] = {}) {
    const fake = startFakeDesktop(options);
    const eg = await SasEnterpriseGuideUi.launch(fake.session(), { path: FAKE_EG_PATH });
    await eg.connect(good, { profile });
    return { fake, eg };
  }

  test('openProject uses Ctrl+O and the standard Open dialog, then waits until the window carries the project name', async () => {
    const { fake, eg } = await connected();
    await eg.openProject(FAKE_PROJECT_PATH);
    expect(fake.eg.openProjectPath).toBe(FAKE_PROJECT_PATH);
    expect((await eg.mainWindow.peek())?.name).toBe('Sales - SAS Enterprise Guide');
    expect(fake.desktop.calls.some((c) => c.op === 'sendKeys' && c.keys === '^o')).toBe(true);
  });

  test('a file that does not exist is an error with the dialog\'s message, and the dialog is closed', async () => {
    const { eg } = await connected();
    const error = (await eg.openProject('C:\\nope.egp').catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/could not open C:\\nope\.egp: "The file could not be found\."/);
    expect(await eg.app.window(/^Open$/).exists()).toBe(false);
  });

  test('runProgram selects the node, runs it, waits until it has finished (not before) and returns the log and results', async () => {
    const project = { flows: [{ name: 'Flow', programs: ['Slow'] }], programs: [{ name: 'Slow', log: 'NOTE: done\nERROR: oops\nWARNING: hmm', results: ['a.html'], runMs: 250 }] };
    const { fake, eg } = await connected({ eg: { projects: { 'C:\\s.egp': project } } });
    await eg.openProject('C:\\s.egp');
    const startedAt = Date.now();
    const run = await eg.runProgram('Slow');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(240); // it waited for the program
    expect(fake.eg.ran).toEqual(['program:Slow']);
    expect(run).toEqual({ program: 'Slow', log: 'NOTE: done\nERROR: oops\nWARNING: hmm', results: 'a.html', errors: 1, warnings: 1 });
    expect(await eg.readLog()).toContain('NOTE: done');
    expect(await eg.readResults()).toBe('a.html');
  });

  test('a program that never finishes fails with its name after the timeout, not later', async () => {
    const project = { flows: [{ name: 'Flow', programs: ['Forever'] }], programs: [{ name: 'Forever', log: '', results: [], runMs: 10_000 }] };
    const { eg } = await connected({ eg: { projects: { 'C:\\f.egp': project } } });
    await eg.openProject('C:\\f.egp');
    const startedAt = Date.now();
    await expect(eg.runProgram('Forever', { timeoutMs: 300 })).rejects.toThrow(/"Forever" was still running after 300ms/);
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test('a very short program that finishes before it can be seen running is still read after the start grace', async () => {
    const { eg } = await connected();
    await eg.openProject(FAKE_PROJECT_PATH);
    const run = await eg.runProgram('Program', { startGraceMs: 50 });
    expect(run.log).toContain('19 observations');
    expect(run.errors).toBe(0);
  });

  test('a dialog handler deals with a prompt that appears in front of a step, once, without sleeping', async () => {
    const { fake, eg } = await connected();
    let handled = 0;
    eg.app.onDialog(/Tip of the Day/, async (dialog) => {
      handled++;
      await dialog.getByRole('Button', { name: 'Close' }).click();
    });
    // the application shows a tip dialog when the project opens
    const real = fake.desktop.request.bind(fake.desktop);
    let shown = false;
    fake.desktop.request = async (command) => {
      const reply = await real(command);
      if (!shown && command.op === 'click') {
        shown = true;
        const main = fake.eg.main!;
        const tip = fake.desktop.addWindow(fake.eg.process!, { title: 'Tip of the Day' });
        fake.desktop.attach(tip, { controlType: 'Button', name: 'Close', on: { invoke: () => fake.desktop.dispose(tip) } });
        void main;
      }
      return reply;
    };
    await eg.openProject(FAKE_PROJECT_PATH); // the tip appears while this last click is processed
    expect(handled).toBe(0); // handlers run BEFORE a step: nothing has been in the way yet
    await eg.runProgram('Program'); // its first step finds the tip in front, runs the handler, then goes on
    expect(handled).toBe(1);
    expect(await eg.app.window(/Tip of the Day/).exists()).toBe(false);
    await eg.runProgram('Summary');
    expect(handled).toBe(1); // it was dismissed: not handled again
  });

  test('launching without SAS_EG_PATH says what to set', async () => {
    const fake = startFakeDesktop();
    await expect(SasEnterpriseGuideUi.launch(fake.session(), { config: { egPath: undefined } as never })).rejects.toThrow(/SAS_EG_PATH is not set/);
  });
});
