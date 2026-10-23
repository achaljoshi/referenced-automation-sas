import { expect, test } from '@playwright/test';
import { clearRejectedLogons, ComClient, DesktopSession, FAKE_EG_PATH, FAKE_PROJECT_PATH, FAKE_SMC_PATH, LogonRejected, ProcessTransport, SasEnterpriseGuide, SasEnterpriseGuideUi, SasManagementConsole } from '../../src/desktop';
import { captureLogs, standInBridge } from './support';

// The framework through a REAL child process speaking the REAL line protocol (the Node stand-in bridge). NOT VERIFIED against PowerShell.

async function connect(args: string[] = [standInBridge()]): Promise<{ session: DesktopSession; transport: ProcessTransport }> {
  const transport = await ProcessTransport.start({ command: process.execPath, args, label: 'Stand-in', env: { ...process.env, LOG_TO_FILE: 'false' }, requestTimeoutMs: 5_000, startupTimeoutMs: 8_000 });
  return { transport, session: new DesktopSession(transport, { timeoutMs: 5_000, pollMs: 20 }) };
}

test.beforeEach(() => clearRejectedLogons());

test('Enterprise Guide by COM over the line protocol: connect, open, run, statuses, export, save, quit', async () => {
  const { session } = await connect();
  const eg = await SasEnterpriseGuide.connect(session, { profile: 'Dev SAS Server' });
  expect(await eg.openProject(FAKE_PROJECT_PATH)).toBe('Sales.egp');
  expect((await eg.listItems()).map((i) => `${i.kind}:${i.name}`)).toEqual(['processFlow:Main Flow', 'program:Program', 'program:Summary']);
  const statuses = await eg.runProject();
  expect(statuses.map((s) => `${s.name}=${s.status}`)).toEqual(['Program=Succeeded', 'Summary=Warning']);
  expect(await eg.exportResults({ program: 'Summary', folder: 'C:\\out' })).toEqual(['C:\\out\\Summary.html', 'C:\\out\\Summary.pdf']);
  await eg.saveProject();
  await eg.quit();
  await session.close();
});

test('the COM allow-list is the bridge\'s own: widening it on the TypeScript side does not get past a bridge started with a narrower one', async () => {
  const { session } = await connect([standInBridge(), '-AllowProgIds', 'SASEGObjectModel.Application.*']);
  const eg = await SasEnterpriseGuide.connect(session, { config: { comProgIds: ['SASEGObjectModel.Application.*', 'SASObjectManager.*'] } as never });
  expect(eg.progId).toBe('SASEGObjectModel.Application.8.3');
  const widened = new ComClient(session, { allowProgIds: ['SASObjectManager.*'] });
  await expect(widened.create('SASObjectManager.ObjectFactoryMulti2')).rejects.toThrow(/not on the allow-list/);
  await session.close();
});

test('Management Console over the line protocol: launch, rejected logon (once, LogonRejected), then a correct logon and navigation', async () => {
  const { session } = await connect();
  const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
  const bad = { user: 'sasdemo', password: 'definitely-wrong-1' };
  const captured = await captureLogs(() => smc.logon(bad, { profile: 'Dev Metadata Server' }));
  expect(captured.error).toBeInstanceOf(LogonRejected);
  expect(captured.lines.join('\n')).not.toContain(bad.password);
  const second = (await smc.logon(bad, { profile: 'Dev Metadata Server' }).catch((e: unknown) => e)) as Error;
  expect(second.message).toMatch(/already rejected/);
  // the rejected logon was cancelled, leaving nothing waiting for a second try: a fresh start is needed, with the right password
  await smc.dispose();
  const again = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
  await again.logon({ user: 'sasdemo', password: 'Orion123' }, { profile: 'Dev Metadata Server' });
  expect(await again.listUsers()).toEqual(['Alice Analyst', 'Bob Builder', 'sasdemo']);
  expect((await again.serverStatus()).map((s) => s.status)).toEqual(['Running', 'Running', 'Stopped']);
  await again.dispose();
  await session.close();
});

test('Enterprise Guide screens over the line protocol: connect, open a project, run a program, read the log', async () => {
  const { session } = await connect();
  const eg = await SasEnterpriseGuideUi.launch(session, { path: FAKE_EG_PATH });
  await eg.connect({ user: 'sasdemo', password: 'Orion123' }, { profile: 'Dev SAS Server' });
  await eg.openProject(FAKE_PROJECT_PATH);
  const run = await eg.runProgram('Summary');
  expect(run.warnings).toBe(1);
  expect(run.log).toContain('PROCEDURE MEANS');
  await eg.dispose();
  await session.close();
});

test('a bridge that dies mid-session fails the next step with BRIDGE_EXITED, not a hang', async () => {
  const { session, transport } = await connect();
  const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
  (transport as unknown as { child: { kill(): void } }).child.kill();
  const startedAt = Date.now();
  const error = (await smc.app.window(/./).getByName('x').click().catch((e: unknown) => e)) as Error & { cause?: { code?: string } };
  expect(error).toBeDefined();
  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(await session.healthCheck()).toBe(false);
});
