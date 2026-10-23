import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  BaseDriver,
  LogonGuard,
  PreflightFailed,
  checkOfDriver,
  coreHealthChecks,
  Credentials,
  formatPreflightTable,
  runPreflight,
  type HealthCheck,
  type HealthResult,
} from '../../src/core';
import { config, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

const green = (name: string, detail = 'fine'): HealthCheck => ({ name, hint: `fix ${name}`, run: () => ({ ok: true, detail }) });
const red = (name: string, detail = 'broken'): HealthCheck => ({ name, hint: `fix ${name}: do this`, run: () => ({ ok: false, detail }) });

test.describe('runPreflight', () => {
  test('all green: returns a table with every check', async () => {
    const report = await runPreflight([green('metadata-port', '8561 open'), green('bridge')], { env: config() });
    expect(report.ok).toBe(true);
    expect(report.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(report.table).toMatch(/^CHECK\s+STATUS\s+DETAIL/);
    expect(report.table).toContain('metadata-port');
    expect(report.table).toContain('8561 open');
  });

  test('throws ONE PreflightFailed listing EVERY red check with its hint (a check after a red one still runs)', async () => {
    let ranAfter = false;
    const checks: HealthCheck[] = [green('a'), red('metadata-port', 'connection refused'), { name: 'throws', hint: 'fix throws', run: () => { throw new Error('boom'); } }, { name: 'after', hint: 'x', run: () => { ranAfter = true; return { ok: true }; } }];
    const error = (await runPreflight(checks, { env: config() }).catch((e: unknown) => e)) as PreflightFailed;
    expect(error).toBeInstanceOf(PreflightFailed);
    expect(ranAfter).toBe(true);
    expect(error.message).toContain('2 of 4 pre-flight check(s) are red; no test was started');
    expect(error.message).toContain('metadata-port: connection refused');
    expect(error.message).toContain('what to do: fix metadata-port: do this');
    expect(error.message).toContain('throws: boom');
    expect(error.message).toContain('what to do: fix throws');
    expect(error.report.rows.map((r) => r.status)).toEqual(['ok', 'FAILED', 'FAILED', 'ok']);
  });

  test('a check that does not answer in time is red, not a hang', async () => {
    const slow: HealthCheck = { name: 'slow', hint: 'wake it up', timeoutMs: 50, run: () => new Promise<HealthResult>(() => undefined) };
    const started = Date.now();
    const error = (await runPreflight([slow], { env: config() }).catch((e: unknown) => e)) as PreflightFailed;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error.message).toContain('slow: no answer within 50 ms');
  });

  test('SAS_PREFLIGHT_TIMEOUT_MS sets the default time limit', async () => {
    const slow: HealthCheck = { name: 'slow', hint: 'h', run: () => new Promise<HealthResult>(() => undefined) };
    const error = (await runPreflight([slow], { env: config({ SAS_PREFLIGHT_TIMEOUT_MS: '40' }) }).catch((e: unknown) => e)) as PreflightFailed;
    expect(error.message).toContain('no answer within 40 ms');
  });

  test('a skipped check (a capability this machine lacks) shows why and is never red', async () => {
    const report = await runPreflight([{ ...red('eg-com'), skip: () => 'not on this machine (no Windows)' }, green('x')], { env: config() });
    expect(report.rows[0]).toMatchObject({ status: 'skipped', detail: 'not on this machine (no Windows)' });
    expect(report.table).toContain('skipped');
  });

  test('formatPreflightTable aligns the columns', () => {
    const table = formatPreflightTable([{ name: 'a', status: 'ok', detail: 'x', durationMs: 1 }, { name: 'longer-name', status: 'FAILED', detail: 'y', durationMs: 2 }]);
    const lines = table.split('\n');
    expect(lines[1]?.indexOf('ok')).toBe(lines[2]?.indexOf('FAILED'));
  });
});

test.describe('Driver and BaseDriver', () => {
  class Fake extends BaseDriver {
    readonly name = 'fake';
    closed = false;
    constructor(private readonly result: HealthResult | Error) {
      super();
    }
    async health(): Promise<HealthResult> {
      if (this.result instanceof Error) throw this.result;
      return this.result;
    }
    close(): void {
      this.closed = true;
    }
  }

  test('healthCheck() (the utils Adapter contract) is derived from health(); a throwing health() is false, not an exception', async () => {
    expect(await new Fake({ ok: true }).healthCheck()).toBe(true);
    expect(await new Fake({ ok: false, detail: 'x' }).healthCheck()).toBe(false);
    expect(await new Fake(new Error('x')).healthCheck()).toBe(false);
  });

  test('checkOfDriver turns a driver into a pre-flight check named after it', async () => {
    const check = checkOfDriver(new Fake({ ok: false, detail: 'no bridge' }), 'start the bridge');
    expect(check.name).toBe('fake');
    const error = (await runPreflight([check], { env: config() }).catch((e: unknown) => e)) as PreflightFailed;
    expect(error.message).toContain('fake: no bridge');
    expect(error.message).toContain('start the bridge');
  });
});

test.describe('coreHealthChecks', () => {
  const values = (dir: string, over: Record<string, string> = {}) => ({ SAS_STATE_DIR: path.join(dir, 'state'), SAS_AUDIT_FILE: path.join(dir, 'audit', 'a.jsonl'), SAS_ENVIRONMENT: 'dev', SAS_ENVIRONMENTS_FILE: path.join(dir, 'envs.json'), ...over });
  const writeEnvs = (dir: string) => fs.writeFileSync(path.join(dir, 'envs.json'), JSON.stringify({ environments: { dev: { kind: 'nonprod', hosts: ['sasmeta.dev.example.com'] } } }));

  test('green when the environment is declared, the folders are writable and credentials are set', async () => {
    const dir = tempDir();
    writeEnvs(dir);
    const report = await runPreflight(coreHealthChecks({ applications: ['smc'], env: config({ ...values(dir), SAS_USER: 'u', SAS_PASSWORD: 'secret-pw' }) }), { env: config() });
    expect(report.rows.map((r) => r.name)).toEqual(['environment', 'state-dir', 'audit-log', 'credentials:smc']);
    expect(report.table).toContain('dev (nonprod)');
    expect(report.table).not.toContain('secret-pw');
  });

  test('red for an undeclared environment, a missing credential - each with its hint', async () => {
    const dir = tempDir();
    writeEnvs(dir);
    const error = (await runPreflight(coreHealthChecks({ applications: ['eg'], env: config(values(dir, { SAS_ENVIRONMENT: 'stage' })) }), { env: config() }).catch((e: unknown) => e)) as PreflightFailed;
    expect(error.message).toContain('environment:');
    expect(error.message).toContain('"stage" is not declared');
    expect(error.message).toContain('credentials:eg:');
    expect(error.message).toContain('set SAS_EG_USER and SAS_EG_PASSWORD');
  });

  test('a logon cooldown turns the credentials check red BEFORE any test starts', async () => {
    const dir = tempDir();
    writeEnvs(dir);
    const env = config({ ...values(dir), SAS_USER: 'u', SAS_PASSWORD: 'rejected-pw' });
    new LogonGuard({ env }).recordRejection('dev', new Credentials({ application: 'smc', user: 'u', password: 'rejected-pw' }), 'rejected');
    const error = (await runPreflight(coreHealthChecks({ applications: ['smc'], env }), { env: config() }).catch((e: unknown) => e)) as PreflightFailed;
    expect(error.message).toContain('credentials:smc:');
    expect(error.message).toContain('logon NOT attempted');
  });

  test('an unwritable audit location is red with the hint', async () => {
    const dir = tempDir();
    writeEnvs(dir);
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    const error = (await runPreflight(coreHealthChecks({ env: config(values(dir, { SAS_AUDIT_FILE: path.join(dir, 'blocker', 'a.jsonl') })) }), { env: config() }).catch((e: unknown) => e)) as PreflightFailed;
    expect(error.message).toContain('audit-log:');
    expect(error.message).toContain('no privileged action runs without an audit record');
  });
});
