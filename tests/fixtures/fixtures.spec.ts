import * as path from 'node:path';
import { readAudit, readCreatedEvents } from '../../src/core';
import { desktopExpect as expect, desktopTest as test, sampleProgramName, sampleProjectPath } from '../../src/fixtures';
import { STATE, alive, evidenceFiles, settings, slug } from './desktopSupport';

// The fixtures of desktopTest, end to end on the stand-in desktop: nothing here is a mock of the fixtures themselves.
// Describe blocks that need to see what an EARLIER test left behind (a clean-up, an evidence file, a closed program) are serial: one worker, in order.
// Worker options cannot be changed inside a describe block, so the other settings (warn, evidence on/off/steps, production, a wrong password) have their own files.

test.use({ desktopSimulator: true, sasSettings: settings({ SAS_EVIDENCE: 'failure' }) });

test.describe('the worker fixtures @sas-desktop', () => {
  test('the environment is the declared "simulator" one, the run has a namespace, and the session answers', async ({ environment, runContext, desktopSession, desktopSettings, vars, fakeDesktop }) => {
    expect(environment).toMatchObject({ name: 'simulator', kind: 'nonprod' });
    expect(desktopSettings.simulated).toBe(true);
    expect(runContext.runId).toMatch(/^[A-Za-z0-9]{3,24}$/);
    expect(runContext.runId).toBe(process.env.SAS_RUN_ID); // every worker of the run shares the id config exported
    expect(vars.get('runId')).toBe(runContext.runId);
    expect(vars.interpolate('{{namespace}}_x')).toBe(`${runContext.namespacePrefix}_x`);
    expect((await desktopSession.ping()).bridge).toBeTruthy();
    expect(fakeDesktop).toBeDefined();
    expect(Object.keys(fakeDesktop?.eg.options.projects ?? {})).toContain(sampleProjectPath(runContext));
  });

  test('every step passes the safety policy and is audited under this run', async ({ smcLoggedOn, smc, safetyPolicy, runContext }) => {
    void smcLoggedOn;
    await smc.openPlugin('User Manager');
    const records = readAudit(safetyPolicy.audit.file, { runId: runContext.runId, environment: 'simulator' });
    expect(records.some((r) => r.driver === 'sas-smc' && r.operation === 'logon' && r.outcome === 'ok')).toBe(true);
    expect(records.some((r) => r.driver === 'sas-smc' && r.operation === 'openPlugin' && r.target === 'User Manager')).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/password"\s*:\s*"[^*]/i);
  });
});

test.describe('the app fixtures @sas-desktop', () => {
  test('smcApp is launched but NOT logged on; smc is the wrapper around the same program', async ({ smcApp, smc, fakeDesktop }) => {
    expect(smc.app).toBe(smcApp);
    await expect(smcApp.window(/Connection Profile/i)).toExist();
    expect(fakeDesktop?.smc.attempts).toEqual([]);
    expect(smcApp.launched).toBe(true);
  });

  test('smcLoggedOn is logged on through the logon guard: the navigation tree is there and one accepted attempt was made', async ({ smcLoggedOn, smc, fakeDesktop }) => {
    expect(smc.app).toBe(smcLoggedOn);
    await expect(smc.mainWindow.getByRole('Tree')).toExist();
    expect(fakeDesktop?.smc.attempts.at(-1)).toEqual({ user: 'sasdemo', accepted: true });
    expect(await smc.findUser('sasdemo')).toBe('sasdemo');
  });

  test('egApp is NOT connected; egLoggedOn is; eg is the wrapper', async ({ egApp, eg }) => {
    await expect(eg.mainWindow.getByName('Connect')).toBeEnabled();
    await expect(eg.mainWindow.getByName(/^Connected to/)).not.toExist();
    expect(eg.app).toBe(egApp);
  });

  test('egLoggedOn connects and can open a project of this run', async ({ egLoggedOn, eg, runContext }) => {
    await expect(eg.mainWindow.getByName(/^Connected to/)).toExist();
    expect(eg.app).toBe(egLoggedOn);
    await eg.openProject(sampleProjectPath(runContext));
    await expect(eg.mainWindow).toHaveTitle(/Sales/);
  });

  test('egCom is connected through the automation object model', async ({ egCom, runContext }) => {
    expect(egCom.progId).toBe('SASEGObjectModel.Application.8.3');
    expect(await egCom.openProject(sampleProjectPath(runContext))).toBe(`${runContext.ns('Sales')}.egp`);
    expect((await egCom.programStatus(sampleProgramName(runContext, 'Program'))).status).toBe('NotRun');
  });

  test.describe('the programs a test started are closed at its end', () => {
    test.describe.configure({ mode: 'serial' });
    test('start both programs and the COM driver', async ({ smcLoggedOn, egLoggedOn, egCom, fakeDesktop }) => {
      void smcLoggedOn;
      void egLoggedOn;
      void egCom;
      expect(alive(fakeDesktop, 'sasmc')).toBe(true);
      expect(alive(fakeDesktop, 'SEGuide')).toBe(true);
    });
    test('none is left running by the previous test', async ({ fakeDesktop }) => {
      expect(alive(fakeDesktop, 'sasmc')).toBe(false);
      expect(alive(fakeDesktop, 'SEGuide')).toBe(false);
      expect(fakeDesktop?.eg.com.quitCalls).toBeGreaterThanOrEqual(1);
    });
  });
});

test.describe('clean-up after the test @sas-desktop', () => {
  test.describe('after a passing test', () => {
    test.describe.configure({ mode: 'serial' });
    const undone: string[] = [];
    test('registers what it created', async ({ cleanup, runContext }) => {
      cleanup.register({ type: 'folder', name: runContext.ns('made-by-a-test'), undo: () => void undone.push('made-by-a-test') });
      expect(undone).toEqual([]); // nothing is undone while the test is running
    });
    test('it was undone, and the orphan record was closed', async ({ runContext }) => {
      expect(undone).toEqual(['made-by-a-test']);
      const mine = readCreatedEvents(path.resolve(STATE)).filter((e) => e.name === runContext.ns('made-by-a-test'));
      expect(mine.map((e) => e.event)).toEqual(['created', 'removed']);
    });
  });

  test.describe('after a failing test', () => {
    test.describe.configure({ mode: 'serial' });
    const undone: string[] = [];
    test('fails on purpose after registering a clean-up', async ({ cleanup }) => {
      test.fail(true, 'the test body fails; its clean-up must still run');
      cleanup.register({ type: 'user', name: 'x', undo: () => void undone.push('after-failure') });
      expect(1, 'the failure').toBe(2);
    });
    test('the clean-up ran anyway', async () => {
      expect(undone).toEqual(['after-failure']);
    });
  });

  test.describe('while the program is still open', () => {
    test.describe.configure({ mode: 'serial' });
    const seen: boolean[] = [];
    test('an undo can still use the program', async ({ smcLoggedOn, cleanup, fakeDesktop }) => {
      void smcLoggedOn;
      cleanup.register({ type: 'user', name: 'y', undo: () => void seen.push(alive(fakeDesktop, 'sasmc')) });
    });
    test('it found the program open, and the program is closed now', async ({ fakeDesktop }) => {
      expect(seen).toEqual([true]);
      expect(alive(fakeDesktop, 'sasmc')).toBe(false);
    });
  });

  test('a clean-up that fails FAILS its test (SAS_CLEANUP_FAILURE=fail, the default)', async ({ cleanup }) => {
    test.fail(true, 'the undo throws, so the test must fail in its teardown');
    cleanup.register({ type: 'group', name: 'stuck', undo: () => { throw new Error('the group is in use'); } });
  });
});

test.describe('evidence: SAS_EVIDENCE=failure (the default) @sas-desktop', () => {
  test.describe('a passing test', () => {
    test.describe.configure({ mode: 'serial' });
    test('passes and leaves nothing', async ({ smcApp }) => {
      await expect(smcApp.window(/Connection Profile/i)).toExist();
    });
    test('what the passing test left', async ({ runContext }) => {
      expect(evidenceFiles(runContext.runId).filter((f) => f.includes(slug('passes and leaves nothing')))).toEqual([]);
    });
  });
});
