import { expect, test } from '@playwright/test';
import {
  compareProgIdVersions,
  ComClient,
  discoverEgProgId,
  EG_PROGID_PREFIX,
  FAKE_PROJECT_PATH,
  SasEnterpriseGuide,
  startFakeDesktop,
  type GuardedOperation,
  type GuardedResult,
  type OperationGuard,
} from '../../src/desktop';

// The Enterprise Guide COM driver against the fake object model (NOT VERIFIED against the real automation API).

function recordingGuard(deny?: (op: GuardedOperation) => boolean): OperationGuard & { asked: GuardedOperation[]; results: GuardedResult[] } {
  const asked: GuardedOperation[] = [];
  const results: GuardedResult[] = [];
  return {
    asked,
    results,
    authorize(op) {
      asked.push(op);
      if (deny?.(op)) throw new Error(`policy: ${op.operation} refused`);
    },
    record: (r) => void results.push(r),
  };
}

test.describe('ProgID discovery', () => {
  test('versions sort newest first, numerically (7.15 before 7.1, 8.3 before 7.15)', () => {
    const ids = ['7.1', '8.3', '7.15', '6.1', '8.10', '8.2'].map((v) => EG_PROGID_PREFIX + v);
    expect(ids.sort(compareProgIdVersions).map((i) => i.slice(EG_PROGID_PREFIX.length))).toEqual(['8.10', '8.3', '8.2', '7.15', '7.1', '6.1']);
  });

  test('SAS_EG_PROGID wins and nothing is probed', async () => {
    const fake = startFakeDesktop({ eg: { comVersions: ['7.1', '8.3'] } });
    const found = await discoverEgProgId(new ComClient(fake.session()), 'SASEGObjectModel.Application.7.1');
    expect(found).toMatchObject({ progId: 'SASEGObjectModel.Application.7.1', how: 'SAS_EG_PROGID' });
    expect(fake.desktop.calls).toHaveLength(0);
  });

  test('without a setting the newest registered version is found by listing the registry', async () => {
    const fake = startFakeDesktop({ eg: { comVersions: ['7.1', '8.3', '7.15'] } });
    const found = await discoverEgProgId(new ComClient(fake.session()));
    expect(found.progId).toBe('SASEGObjectModel.Application.8.3');
    expect(found.how).toMatch(/newest registered/);
  });

  test('when the registry cannot be listed the known versions are tried newest first', async () => {
    const fake = startFakeDesktop({ eg: { comVersions: ['7.1', '6.1'] } });
    const real = fake.desktop.request.bind(fake.desktop);
    fake.desktop.request = async (command) => (command.op === 'com.list' ? Promise.reject(new Error('no listing here')) : real(command));
    const found = await discoverEgProgId(new ComClient(fake.session()));
    expect(found.progId).toBe('SASEGObjectModel.Application.7.1');
    const creates = fake.desktop.calls.filter((c) => c.op === 'com.create').map((c) => (c as { progId: string }).progId);
    expect(creates[0]).toBe('SASEGObjectModel.Application.8.5'); // newest candidate first
    expect(creates.at(-1)).toBe('SASEGObjectModel.Application.7.1');
    expect(creates).not.toContain('SASEGObjectModel.Application.6.1'); // stopped at the first that worked
  });

  test('nothing registered: the message names what was tried and the 32-bit PowerShell', async () => {
    const fake = startFakeDesktop({ eg: { comVersions: [] } });
    const error = (await discoverEgProgId(new ComClient(fake.session())).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/no Enterprise Guide automation class is registered/);
    expect(error.message).toMatch(/SASEGObjectModel\.Application\.8\.5/);
    expect(error.message).toMatch(/SysWOW64/);
  });

  test('an allow-list that excludes Enterprise Guide is reported as such, not as "not installed"', async () => {
    const fake = startFakeDesktop({ allowProgIds: ['SASObjectManager.*'] });
    const error = (await discoverEgProgId(new ComClient(fake.session(), { allowProgIds: ['SASObjectManager.*'] })).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/SAS_COM_PROGIDS does not allow/);
  });
});

test.describe('SasEnterpriseGuide (COM)', () => {
  test('connect activates the profile; open, list, run, read the logs, export, save and quit - through the object model only', async () => {
    const fake = startFakeDesktop();
    const eg = await SasEnterpriseGuide.connect(fake.session(), { profile: 'Dev SAS Server' });
    expect(eg.progId).toBe('SASEGObjectModel.Application.8.3');
    expect(await eg.version()).toBe('8.3');
    expect(fake.eg.com.activeProfile).toBe('Dev SAS Server');

    expect(await eg.openProject(FAKE_PROJECT_PATH)).toBe('Sales.egp');
    expect(await eg.listItems()).toEqual([
      { kind: 'processFlow', name: 'Main Flow' },
      { kind: 'program', name: 'Program' },
      { kind: 'program', name: 'Summary' },
    ]);
    expect(await eg.programStatuses()).toEqual([
      { name: 'Program', status: 'NotRun', errors: 0, warnings: 0, source: 'object-model' },
      { name: 'Summary', status: 'NotRun', errors: 0, warnings: 0, source: 'object-model' },
    ]);

    const statuses = await eg.runProject();
    expect(fake.eg.ran).toEqual(['project:' + FAKE_PROJECT_PATH, 'program:Program', 'program:Summary']);
    expect(statuses).toEqual([
      { name: 'Program', status: 'Succeeded', errors: 0, warnings: 0, source: 'object-model' },
      { name: 'Summary', status: 'Warning', errors: 0, warnings: 1, source: 'object-model' },
    ]);
    expect(await eg.programLog('Program')).toContain('19 observations read');

    const written = await eg.exportResults({ program: 'Summary', folder: 'C:\\out' });
    expect(written).toEqual(['C:\\out\\Summary.html', 'C:\\out\\Summary.pdf']);
    expect(fake.eg.com.files.get('C:\\out\\Summary.html')).toContain('Summary.html');
    expect(await eg.exportLog('Program', 'C:\\out\\program.log')).toBe('C:\\out\\program.log');
    expect(fake.eg.com.files.get('C:\\out\\program.log')).toContain('PROCEDURE PRINT');

    await eg.saveProject();
    expect(fake.eg.com.saved).toEqual([FAKE_PROJECT_PATH]);
    await eg.quit();
    expect(fake.eg.com.quitCalls).toBe(1);
    expect(fake.desktop.com.openHandles).toBe(0); // every COM object was released
    expect(fake.desktop.calls.filter((c) => ['click', 'invoke', 'setText', 'sendKeys', 'launch'].includes(c.op))).toHaveLength(0); // no UI was touched
  });

  test('a process flow runs on its own: only its programs run', async () => {
    const fake = startFakeDesktop();
    const eg = await SasEnterpriseGuide.connect(fake.session());
    await eg.openProject(FAKE_PROJECT_PATH);
    await eg.runProcessFlow('Main Flow');
    expect(fake.eg.ran).toEqual(['flow:Main Flow', 'program:Program', 'program:Summary']);
    await expect(eg.runProcessFlow('No Such Flow')).rejects.toThrow(/no process flow named "No Such Flow" \(it has: "Main Flow"\)/);
    await eg.quit();
  });

  test('a program that fails is reported as Error with its count of ERROR lines; without a status member the log decides', async () => {
    const failing = {
      flows: [{ name: 'Flow', programs: ['Bad', 'Good'] }],
      programs: [
        { name: 'Bad', log: 'NOTE: starting\nERROR: File WORK.NOPE.DATA does not exist.\nERROR: second', results: [] },
        { name: 'Good', log: 'NOTE: all fine', results: [] },
      ],
    };
    for (const exposeRunStatus of [true, false]) {
      const fake = startFakeDesktop({ eg: { projects: { 'C:\\p.egp': failing }, exposeRunStatus } });
      const eg = await SasEnterpriseGuide.connect(fake.session());
      await eg.openProject('C:\\p.egp');
      const statuses = await eg.runProject();
      expect(statuses.map((s) => [s.name, s.status, s.errors, s.source])).toEqual([
        ['Bad', 'Error', 2, exposeRunStatus ? 'object-model' : 'log'],
        ['Good', 'Succeeded', 0, exposeRunStatus ? 'object-model' : 'log'],
      ]);
      await eg.quit();
    }
  });

  test('without a status member a program that has not run is Unknown, not Succeeded', async () => {
    const fake = startFakeDesktop({ eg: { exposeRunStatus: false } });
    const eg = await SasEnterpriseGuide.connect(fake.session());
    await eg.openProject(FAKE_PROJECT_PATH);
    expect((await eg.programStatus('Program')).status).toBe('Unknown');
    await eg.quit();
  });

  test('errors say what is wrong: unknown project, unknown program, no project open, unknown profile', async () => {
    const fake = startFakeDesktop();
    const eg = await SasEnterpriseGuide.connect(fake.session());
    await expect(eg.runProject()).rejects.toThrow(/no project is open/);
    await expect(eg.openProject('C:\\missing.egp')).rejects.toThrow(/could not be opened/);
    await eg.openProject(FAKE_PROJECT_PATH);
    await expect(eg.programLog('Nope')).rejects.toThrow(/no program named "Nope" \(it has: "Program", "Summary"\)/);
    await eg.quit();
    await expect(SasEnterpriseGuide.connect(fake.session(), { profile: 'No Such Profile' })).rejects.toThrow(/profile "No Such Profile" does not exist/);
  });

  test('opening a second project closes the first; quit is safe to call twice', async () => {
    const fake = startFakeDesktop({ eg: { projects: { 'C:\\a.egp': { flows: [], programs: [] }, 'C:\\b.egp': { flows: [], programs: [] } } } });
    const eg = await SasEnterpriseGuide.connect(fake.session());
    await eg.openProject('C:\\a.egp');
    await eg.openProject('C:\\b.egp');
    expect(fake.eg.com.openedPaths).toEqual(['C:\\a.egp', 'C:\\b.egp']);
    await eg.quit();
    await eg.quit();
    expect(fake.desktop.com.openHandles).toBe(0);
  });

  test('guard: each driver method is ONE guarded operation with the right kind and target (not the dozen COM calls inside it)', async () => {
    const fake = startFakeDesktop();
    const guard = recordingGuard();
    const eg = await SasEnterpriseGuide.connect(fake.session({ guard }), { profile: 'Dev SAS Server' });
    await eg.openProject(FAKE_PROJECT_PATH);
    await eg.listItems();
    await eg.runProject();
    await eg.runProcessFlow('Main Flow');
    await eg.exportResults({ program: 'Program', folder: 'C:\\out' });
    await eg.saveProject();
    await eg.quit();
    const seen = guard.asked.map((a) => `${a.driver}.${a.operation}:${a.kind}`);
    expect(seen).toEqual([
      'sas-eg.connect:read',
      'sas-eg.openProject:read',
      'sas-eg.listItems:read',
      'sas-eg.runProject:update',
      'sas-eg.runProcessFlow:update',
      'sas-eg.exportResults:create',
      'sas-eg.saveProject:update',
      'sas-eg.closeProject:read',
      'sas-eg.quit:read',
    ]);
    expect(guard.asked.find((a) => a.operation === 'runProject')?.target).toBe(FAKE_PROJECT_PATH);
    expect(guard.asked.find((a) => a.operation === 'exportResults')?.target).toBe('C:\\out');
    expect(guard.results.every((r) => r.outcome === 'ok')).toBe(true);
  });

  test('guard: a refused runProject never reaches Enterprise Guide, and the refusal is recorded', async () => {
    const fake = startFakeDesktop();
    const guard = recordingGuard((op) => op.operation === 'runProject');
    const eg = await SasEnterpriseGuide.connect(fake.session({ guard }));
    await eg.openProject(FAKE_PROJECT_PATH);
    await expect(eg.runProject()).rejects.toThrow(/policy: runProject refused/);
    expect(fake.eg.ran).toEqual([]);
    expect(guard.results.at(-1)).toMatchObject({ operation: 'runProject', outcome: 'denied' });
    await eg.quit();
  });

  test('a COM failure of a long run is an error with the server message, and a dead server is SESSION_LOST', async () => {
    const fake = startFakeDesktop();
    const eg = await SasEnterpriseGuide.connect(fake.session());
    await eg.openProject(FAKE_PROJECT_PATH);
    const real = fake.desktop.request.bind(fake.desktop);
    fake.desktop.request = async (command) => {
      if (command.op === 'com.call' && command.method === 'Run') throw Object.assign(new Error('The RPC server is unavailable.'), { code: 'SESSION_LOST' });
      return real(command);
    };
    const error = (await eg.runProject().catch((e: unknown) => e)) as Error & { cause?: { code?: string } };
    expect(error.message).toMatch(/RPC server is unavailable/);
    expect(error.cause?.code).toBe('SESSION_LOST');
  });
});
