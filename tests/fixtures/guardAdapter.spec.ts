import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { PolicyViolation, readAudit } from '../../src/core';
import { permissiveGuard, FAKE_EG_PATH, FAKE_PROJECT_PATH, FAKE_SMC_PATH, SasEnterpriseGuide, SasEnterpriseGuideUi, SasManagementConsole, startFakeDesktop } from '../../src/desktop';
import { RAW_UI_OPERATIONS } from '../../src/fixtures';
import { RUN_ID, makeAdapter, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

// The adapter that plugs the core SafetyPolicy and AuditLog into the desktop layer's OperationGuard. Every case uses the REAL policy and a real audit file.

const NS = `AUTO_${RUN_ID}`;
const click = { driver: 'desktop-ui', operation: 'click', kind: 'update' as const, target: 'window "X" > Button name="OK"', local: true };

test.describe('what the adapter tells the policy', () => {
  test('it supplies the environment, and a step that names no host is local', () => {
    const { adapter } = makeAdapter(tempDir(), 'dev');
    expect(adapter.toOperation({ driver: 'sas-eg', operation: 'runProject', kind: 'update', target: 'C:\\x.egp' })).toEqual({ driver: 'sas-eg', operation: 'runProject', kind: 'update', target: 'C:\\x.egp', environment: 'dev', local: true });
  });

  test('a step that names a host is checked against that host - and keeps it', () => {
    const { adapter } = makeAdapter(tempDir(), 'dev');
    const op = adapter.toOperation({ driver: 'sas-x', operation: 'read-thing', kind: 'read', host: 'sasmeta.dev.example.com' });
    expect(op.host).toBe('sasmeta.dev.example.com');
    expect(op.local).toBeUndefined();
    expect(() => adapter.authorize({ driver: 'sas-x', operation: 'read-thing', kind: 'read', host: 'evil.example.net' })).toThrow(/host-not-allowed|not on the allow-list/);
  });

  test('an operation of an unknown environment is refused, and the refusal is audited', () => {
    const dir = tempDir();
    const { adapter, audit } = makeAdapter(dir, 'dev');
    const stranger = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, { environment: 'nowhere' }) as typeof adapter;
    expect(() => stranger.authorize({ driver: 'sas-eg', operation: 'connect', kind: 'read', target: 'x' })).toThrow(PolicyViolation);
    expect(readAudit(audit.file).map((r) => [r.outcome, r.reason])).toEqual([['denied', 'unknown-environment']]);
  });
});

test.describe('raw UI steps (a click names a control, not a SAS object)', () => {
  test('in a nonprod environment the three target rules do not apply: a click outside the namespace is allowed', () => {
    const { adapter } = makeAdapter(tempDir(), 'dev');
    expect(() => adapter.authorize(click)).not.toThrow();
    expect(() => adapter.authorize({ ...click, operation: 'fill', target: 'Edit "a/../b" *' })).not.toThrow();
    expect(() => adapter.authorize({ ...click, target: undefined })).not.toThrow();
  });

  test('in production a raw click is refused (prod-read-only) and audited; a read needs SAS_ALLOW_PROD_READS', () => {
    const dir = tempDir();
    const { adapter, audit } = makeAdapter(dir, 'prod');
    const refusal = (() => {
      try {
        adapter.authorize(click);
      } catch (error) {
        return error as PolicyViolation;
      }
    })();
    expect(refusal).toBeInstanceOf(PolicyViolation);
    expect(refusal?.rule).toBe('prod-read-only');
    expect(() => adapter.authorize({ ...click, operation: 'select', kind: 'read' })).toThrow(/prod-reads-disabled|reads there are switched off/);
    const allowed = makeAdapter(tempDir(), 'prod', { SAS_ALLOW_PROD_READS: 'true' }).adapter;
    expect(() => allowed.authorize({ ...click, operation: 'select', kind: 'read' })).not.toThrow();
    expect(() => allowed.authorize(click)).toThrow(/prod-read-only/); // allowing reads never allows a change
    expect(readAudit(audit.file).map((r) => [r.operation, r.outcome, r.reason])).toEqual([['click', 'denied', 'prod-read-only'], ['select', 'denied', 'prod-reads-disabled']]);
  });

  test('only the raw UI operations are exempt: a step with another name outside the namespace is refused, whatever its driver says', () => {
    const { adapter } = makeAdapter(tempDir(), 'dev');
    expect(() => adapter.authorize({ ...click, operation: 'deleteEverything', kind: 'destructive' })).toThrow(/outside-namespace/);
    expect(() => adapter.authorize({ ...click, driver: 'sas-eg', operation: 'click' })).toThrow(/outside-namespace/); // an application driver is judged on its object
    expect([...RAW_UI_OPERATIONS].sort()).toEqual(['check', 'click', 'closeWindow', 'collapse', 'doubleClick', 'expand', 'fill', 'focus', 'kill', 'press', 'rightClick', 'scrollIntoView', 'select', 'uncheck']);
  });
});

test.describe('object-level operations are judged on the SAS object they name', () => {
  test('an update outside the run namespace is refused with the rule and how to proceed; inside it is allowed', () => {
    const dir = tempDir();
    const { adapter, audit } = makeAdapter(dir, 'dev');
    const outside = { driver: 'sas-eg', operation: 'runProject', kind: 'update' as const, target: 'C:\\Projects\\Sales.egp' };
    const refusal = (() => {
      try {
        adapter.authorize(outside);
      } catch (error) {
        return error as PolicyViolation;
      }
    })();
    expect(refusal?.rule).toBe('outside-namespace');
    expect(refusal?.message).toContain('How to proceed');
    expect(() => adapter.authorize({ ...outside, target: `C:\\Projects\\${NS}_Sales.egp` })).not.toThrow();
    expect(readAudit(audit.file, { outcome: 'denied' })).toHaveLength(1);
  });

  test('SAS_ALLOW_OUTSIDE_NAMESPACE lifts only the namespace, needs a reason, and marks the audit record', () => {
    const op = { driver: 'sas-eg', operation: 'runProject', kind: 'update' as const, target: 'C:\\Projects\\Sales.egp' };
    expect(() => makeAdapter(tempDir(), 'dev', { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true' }).adapter.authorize(op)).toThrow(/override-reason-missing|REASON/);
    const { adapter, audit } = makeAdapter(tempDir(), 'dev', { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: 'ticket SAS-123: run the nightly project' });
    expect(() => adapter.authorize(op)).not.toThrow();
    adapter.record({ operation: 'runProject', outcome: 'ok', durationMs: 5, op });
    expect(readAudit(audit.file)[0]).toMatchObject({ outcome: 'ok', override: 'outside-namespace', reason: expect.stringContaining('SAS-123') });
    const prod = makeAdapter(tempDir(), 'prod', { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: 'ticket SAS-123: run the nightly project' }).adapter;
    expect(() => prod.authorize(op)).toThrow(/prod-read-only/); // nothing lifts production
  });

  test('raw COM calls are not exempt: their target is a member name, so they are refused (fail closed)', () => {
    const { adapter } = makeAdapter(tempDir(), 'dev');
    expect(() => adapter.authorize({ driver: 'desktop-com', operation: 'com.call', kind: 'update', target: 'SASObjectManager.ObjectFactoryMulti2.Delete' })).toThrow(/outside-namespace/);
    expect(() => adapter.authorize({ driver: 'desktop-com', operation: 'com.get', kind: 'read', target: 'SASObjectManager.ObjectFactoryMulti2.Version' })).not.toThrow();
  });
});

test.describe('results', () => {
  test('ok and error outcomes are forwarded with their duration; a denied outcome is not written a second time', () => {
    const { adapter, audit } = makeAdapter(tempDir(), 'dev');
    const op = { ...click, target: 'a control' };
    adapter.record({ operation: 'click', outcome: 'ok', durationMs: 12, op });
    adapter.record({ operation: 'click', outcome: 'error', durationMs: 34, op });
    adapter.record({ operation: 'click', outcome: 'denied', durationMs: 1, op });
    adapter.record({ operation: 'click', outcome: 'ok', durationMs: 1 }); // no op: cannot be attributed, so nothing is invented
    const records = readAudit(audit.file);
    expect(records.map((r) => [r.operation, r.outcome, r.durationMs, r.kind, r.environment, r.driver])).toEqual([
      ['click', 'ok', 12, 'update', 'dev', 'desktop-ui'],
      ['click', 'error', 34, 'update', 'dev', 'desktop-ui'],
    ]);
  });

  test('the audit log carries no secret: a password-looking value in a target is masked', () => {
    const { adapter, audit } = makeAdapter(tempDir(), 'dev');
    adapter.record({ operation: 'fill', outcome: 'ok', durationMs: 1, op: { ...click, operation: 'fill', target: 'field password=Hunter2Hunter2' } });
    expect(JSON.stringify(readAudit(audit.file))).not.toContain('Hunter2Hunter2');
  });
});

test.describe('housekeeping: closing what this run started is not a change to SAS', () => {
  const close = { driver: 'desktop-ui', operation: 'closeWindow', kind: 'update' as const, target: 'SAS Management Console' };
  const kill = { driver: 'desktop-ui', operation: 'kill', kind: 'destructive' as const, target: 'sasmc (1234)' };

  test('in production closeWindow and kill are refused - except inside housekeeping, where they are judged as reads', async () => {
    const dir = tempDir();
    const { adapter, audit } = makeAdapter(dir, 'prod', { SAS_ALLOW_PROD_READS: 'true' });
    expect(() => adapter.authorize(close)).toThrow(/prod-read-only/);
    expect(() => adapter.authorize(kill)).toThrow(/prod-read-only/);
    await adapter.housekeeping(async () => {
      expect(() => adapter.authorize(close)).not.toThrow();
      expect(() => adapter.authorize(kill)).not.toThrow();
      adapter.record({ operation: 'closeWindow', outcome: 'ok', durationMs: 3, op: close });
      // housekeeping is NOT a way round the gate: any other change is still refused inside it
      expect(() => adapter.authorize(click)).toThrow(/prod-read-only/);
      expect(() => adapter.authorize({ driver: 'sas-eg', operation: 'runProject', kind: 'update', target: 'x' })).toThrow(/prod-read-only/);
    });
    expect(() => adapter.authorize(close)).toThrow(/prod-read-only/); // and it ends with the scope
    const ok = readAudit(audit.file, { outcome: 'ok' });
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ kind: 'read', detail: { housekeeping: true, requestedKind: 'update' } });
  });

  test('housekeeping applies only to the desktop-ui driver', async () => {
    const { adapter } = makeAdapter(tempDir(), 'prod');
    await adapter.housekeeping(async () => {
      expect(() => adapter.authorize({ ...close, driver: 'sas-eg' })).toThrow(/prod-read-only/);
    });
  });
});

test.describe('through the real desktop layer on the stand-in', () => {
  test('in production the console can be opened and logged on (reads) but a raw click is refused before anything is touched', async () => {
    const dir = tempDir();
    const { adapter, audit } = makeAdapter(dir, 'prod', { SAS_ALLOW_PROD_READS: 'true' });
    const fake = startFakeDesktop();
    const session = fake.session({ guard: adapter });
    const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
    const login = fake.smc.options.accounts[0];
    if (!login) throw new Error('the stand-in has no account');
    await smc.logon(login, { profile: 'Dev Metadata Server' });
    await smc.openPlugin('User Manager');
    const clicksBefore = fake.desktop.calls.filter((c) => c.op === 'click' || c.op === 'invoke').length;
    const refusal = (await smc.mainWindow.getByRole('TabItem', { name: 'Groups' }).click().catch((e: unknown) => e)) as PolicyViolation;
    expect(refusal).toBeInstanceOf(PolicyViolation);
    expect(refusal.rule).toBe('prod-read-only');
    expect(fake.desktop.calls.filter((c) => c.op === 'click' || c.op === 'invoke').length).toBe(clicksBefore); // the application was not touched
    // closing the program this run started is housekeeping: it works, and without it production would refuse it
    await expect(smc.dispose()).resolves.toBeUndefined(); // dispose swallows the refusal to close the window ...
    expect(fake.desktop.processes.find((p) => p.name === 'sasmc')?.alive).toBe(false); // ... and still stops the program it started (a read), so nothing is left behind
    await adapter.housekeeping(() => smc.dispose()); // and doing it again is harmless
    expect(fake.desktop.processes.find((p) => p.name === 'sasmc')?.alive).toBe(false);
    const denied = readAudit(audit.file, { outcome: 'denied' }).map((r) => r.operation);
    expect(denied).toContain('click');
    expect(denied).toContain('closeWindow');
  });

  test('negative control: the permissive guard of the desktop layer lets the same click through - it is the adapter that refuses', async () => {
    const fake = startFakeDesktop();
    const session = fake.session({ guard: permissiveGuard });
    const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
    const login = fake.smc.options.accounts[0];
    if (!login) throw new Error('the stand-in has no account');
    await smc.logon(login, { profile: 'Dev Metadata Server' });
    await smc.openPlugin('User Manager');
    await expect(smc.mainWindow.getByRole('TabItem', { name: 'Groups' }).click()).resolves.toBeUndefined();
  });

  test('Enterprise Guide by COM: running a project outside the namespace is refused before anything runs; inside it, it runs', async () => {
    const dir = tempDir();
    const { adapter, audit } = makeAdapter(dir, 'dev');
    const fake = startFakeDesktop();
    const session = fake.session({ guard: adapter });
    const eg = await SasEnterpriseGuide.connect(session, {});
    await eg.openProject(FAKE_PROJECT_PATH); // a read
    await expect(eg.runProject()).rejects.toMatchObject({ rule: 'outside-namespace' });
    expect(fake.eg.ran).toEqual([]);
    const inside = `C:\\Projects\\${NS}_Sales.egp`;
    fake.eg.options.projects[inside] = fake.eg.options.projects[FAKE_PROJECT_PATH] as never;
    await eg.openProject(inside);
    expect((await eg.runProject()).length).toBe(2);
    expect(fake.eg.ran).toContain(`project:${inside}`);
    expect(readAudit(audit.file).filter((r) => r.operation === 'runProject').map((r) => r.outcome)).toEqual(['denied', 'ok']);
    await eg.quit();
  });

  test('Enterprise Guide screens: running a program is judged on its name (an update), connecting is not', async () => {
    const { adapter } = makeAdapter(tempDir(), 'dev');
    const fake = startFakeDesktop();
    const session = fake.session({ guard: adapter });
    const eg = await SasEnterpriseGuideUi.launch(session, { path: FAKE_EG_PATH });
    const login = fake.eg.options.accounts[0];
    if (!login) throw new Error('the stand-in has no account');
    await eg.connect(login, { profile: 'Dev SAS Server' });
    await eg.openProject(FAKE_PROJECT_PATH);
    await expect(eg.runProgram('Summary')).rejects.toMatchObject({ rule: 'outside-namespace' });
    expect(fake.eg.ran).toEqual([]);
  });

  test('the audit file is the one the policy was given', () => {
    const dir = tempDir();
    const { audit } = makeAdapter(dir, 'dev');
    expect(audit.file).toBe(path.join(dir, 'audit.jsonl'));
  });
});
