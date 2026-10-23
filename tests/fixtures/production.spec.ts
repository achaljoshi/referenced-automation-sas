import { PolicyViolation, readAudit } from '../../src/core';
import { desktopExpect as expect, desktopTest as test, sampleProjectPath } from '../../src/fixtures';
import { alive, settings } from './desktopSupport';

// A production environment: read-only by construction. Reads need SAS_ALLOW_PROD_READS=true, and even then nothing can change.
test.use({ desktopSimulator: true, sasSettings: settings({ SAS_ENVIRONMENT: 'prod-sim', SAS_ALLOW_PROD_READS: 'true' }) });
test.describe.configure({ mode: 'serial' });

test('reads work (log on, look), a raw click is refused before the program is touched, and the audit says so @sas-desktop', async ({ environment, smcLoggedOn, smc, safetyPolicy, runContext }) => {
  void smcLoggedOn;
  expect(environment.kind).toBe('prod');
  await smc.openPlugin('User Manager');
  expect(await smc.listUsers()).toContain('sasdemo');
  const refusal = (await smc.mainWindow.getByRole('TabItem', { name: 'Groups' }).click().catch((e: unknown) => e)) as PolicyViolation;
  expect(refusal).toBeInstanceOf(PolicyViolation);
  expect(refusal.rule).toBe('prod-read-only');
  expect(readAudit(safetyPolicy.audit.file, { runId: runContext.runId, outcome: 'denied', environment: 'prod-sim' }).some((r) => r.operation === 'click')).toBe(true);
});

test('the program that test started was still closed at its end: housekeeping is not a change @sas-desktop', async ({ fakeDesktop }) => {
  expect(alive(fakeDesktop, 'sasmc')).toBe(false);
});

test('running a project by COM is refused in production, whatever it is called @sas-desktop', async ({ egCom, runContext }) => {
  await egCom.openProject(sampleProjectPath(runContext)); // a read
  await expect(egCom.runProject()).rejects.toMatchObject({ rule: 'prod-read-only' });
});
