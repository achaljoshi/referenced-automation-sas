import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from '@playwright/test';
import { ConfigReader } from '@automation/referenced-automation-utils';
import {
  AuditLog,
  EnvironmentRegistry,
  RunContext,
  SafetyPolicy,
  clearRegisteredSecrets,
  type SafetyPolicyOptions,
  type SasEnvironment,
} from '../../src/core';

export function tempDir(prefix = 'sas-core-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Tests inject their configuration with `new ConfigReader({...})`; the reader still falls back to process.env for a key it does not
 * hold, so a SAS_* variable exported in the developer's shell could change a result. Register this in a spec to clear them for each
 * test and restore them afterwards.
 */
export function useCleanSasEnv(): void {
  let saved: Record<string, string | undefined> = {};
  test.beforeEach(() => {
    saved = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SAS_')) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    clearRegisteredSecrets();
  });
  test.afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('SAS_') && !(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    clearRegisteredSecrets();
  });
}

export const config = (values: Record<string, string> = {}): ConfigReader => new ConfigReader({ ENV: 'qa', ...values });

export const ENVIRONMENTS: SasEnvironment[] = [
  { name: 'dev', kind: 'nonprod', hosts: ['sasmeta.dev.example.com', '**.dev.example.com:8561'] },
  { name: 'qa', kind: 'nonprod', hosts: ['sasmeta.qa.example.com'] },
  { name: 'prod', kind: 'prod', hosts: ['sasmeta.example.com'] },
];

export const registry = (): EnvironmentRegistry => new EnvironmentRegistry(ENVIRONMENTS);

export const RUN_ID = '261023120000abcd';

export function makeRun(values: Record<string, string> = {}, runId = RUN_ID): RunContext {
  return new RunContext({ runId, env: config(values) });
}

export function makePolicy(dir: string, values: Record<string, string> = {}, options: SafetyPolicyOptions = {}): SafetyPolicy {
  const env = config(values);
  const run = makeRun(values);
  return new SafetyPolicy({
    env,
    run,
    environments: registry(),
    audit: new AuditLog({ file: path.join(dir, 'audit.jsonl'), run, env }),
    ...options,
  });
}
