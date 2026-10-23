import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigReader } from '@automation/referenced-automation-utils';
import { AuditLog, EnvironmentRegistry, RunContext, SafetyPolicy, type SafetyPolicyOptions, type SasEnvironment } from '../../src/core';
import { PolicyGuardAdapter, resolveSettings, type FixtureSettings, type SettingsOptions } from '../../src/fixtures';

export { useCleanSasEnv } from '../core/support';

export const ENVIRONMENTS_FILE = path.resolve(__dirname, 'environments.json');
export const RUN_ID = '261023120000abcd';

/** A run context with the fixed run id. */
export const makeRun = (values: Record<string, string> = {}): RunContext => new RunContext({ runId: RUN_ID, env: reader(values) });

export function tempDir(prefix = 'sas-fixtures-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A reader holding exactly these values (it still falls back to process.env: register `useCleanSasEnv()` in the spec). */
export const reader = (values: Record<string, string> = {}): ConfigReader => new ConfigReader({ ENV: 'qa', SAS_ENVIRONMENTS_FILE: ENVIRONMENTS_FILE, ...values });

/** The settings the fixtures would resolve from `values`, with a fixed run id. */
export function settingsFor(values: Record<string, string> = {}, options: Omit<SettingsOptions, 'env'> = {}): FixtureSettings {
  return resolveSettings({ env: reader(values), runId: RUN_ID, ...options });
}

export const ENVIRONMENTS: SasEnvironment[] = [
  { name: 'dev', kind: 'nonprod', hosts: ['sasmeta.dev.example.com'] },
  { name: 'prod', kind: 'prod', hosts: ['sasmeta.example.com'] },
];

/** A real SafetyPolicy writing its audit log into `dir`, and the adapter that plugs it into the desktop layer as environment `environment`. */
export function makeAdapter(dir: string, environment: 'dev' | 'prod', values: Record<string, string> = {}, options: SafetyPolicyOptions = {}): { adapter: PolicyGuardAdapter; policy: SafetyPolicy; run: RunContext; audit: AuditLog } {
  const env = reader(values);
  const run = new RunContext({ runId: RUN_ID, env });
  const audit = new AuditLog({ file: path.join(dir, 'audit.jsonl'), run, env });
  const policy = new SafetyPolicy({ env, run, environments: new EnvironmentRegistry(ENVIRONMENTS), audit, ...options });
  return { adapter: new PolicyGuardAdapter(policy, environment), policy, run, audit };
}
