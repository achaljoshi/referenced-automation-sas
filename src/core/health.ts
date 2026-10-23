import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv, type Adapter, type ConfigReader } from '@automation/referenced-automation-utils';
import { AuditLog } from './audit';
import { credentialsFor, credentialVariables } from './credentials';
import { loadEnvironments, selectedEnvironmentName } from './environments';
import { LogonGuard } from './logonGuard';
import { stateDir } from './stateDir';

const log = getLogger('sas-health');

export interface HealthResult {
  ok: boolean;
  /** What was found, in a few words: `sasmeta.dev.example.com:8561 answered in 40 ms`. */
  detail?: string;
}

/**
 * The common shape of a SAS driver: the utils `Adapter` contract (name, healthCheck, close) plus `health()`, which says WHY it is not
 * usable. `BaseDriver` derives `healthCheck()` from `health()`.
 */
export interface Driver extends Adapter {
  readonly name: string;
  health(): Promise<HealthResult>;
  close(): Promise<void> | void;
}

export abstract class BaseDriver implements Driver {
  abstract readonly name: string;
  abstract health(): Promise<HealthResult>;
  abstract close(): Promise<void> | void;

  async healthCheck(): Promise<boolean> {
    try {
      return (await this.health()).ok;
    } catch {
      return false;
    }
  }
}

/** One thing that must be true before a suite starts. */
export interface HealthCheck {
  name: string;
  /** What to do when it is red - shown in the failure. */
  hint: string;
  run(): Promise<HealthResult> | HealthResult;
  /** A check that does not apply here (a capability this machine lacks): shown as `skipped` with this text, never red. */
  skip?: () => string | undefined;
  timeoutMs?: number;
}

/** The check a driver contributes: its `health()` with a hint. */
export function checkOfDriver(driver: Driver, hint: string, timeoutMs?: number): HealthCheck {
  return { name: driver.name, hint, run: () => driver.health(), ...(timeoutMs ? { timeoutMs } : {}) };
}

export type PreflightStatus = 'ok' | 'FAILED' | 'skipped';

export interface PreflightRow {
  name: string;
  status: PreflightStatus;
  detail: string;
  hint?: string;
  durationMs: number;
}

export interface PreflightReport {
  ok: boolean;
  rows: PreflightRow[];
  /** A plain-text table of every check. */
  table: string;
}

/** Thrown once, listing every red check with its hint - instead of hundreds of timeouts. */
export class PreflightFailed extends AdapterError {
  constructor(readonly report: PreflightReport) {
    const red = report.rows.filter((row) => row.status === 'FAILED');
    super(
      'sas-preflight',
      'preflight',
      `${red.length} of ${report.rows.length} pre-flight check(s) are red; no test was started.\n${report.table}\n` +
        red.map((row) => `  - ${row.name}: ${row.detail}\n      what to do: ${row.hint ?? '(no hint)'}`).join('\n'),
    );
    this.name = 'PreflightFailed';
    Object.setPrototypeOf(this, PreflightFailed.prototype);
  }
}

export function formatPreflightTable(rows: readonly PreflightRow[]): string {
  const width = Math.max(5, ...rows.map((row) => row.name.length));
  const header = `${'CHECK'.padEnd(width)}  ${'STATUS'.padEnd(7)}  DETAIL`;
  const lines = rows.map((row) => `${row.name.padEnd(width)}  ${row.status.padEnd(7)}  ${row.detail}${row.status === 'FAILED' ? `  (${row.durationMs} ms)` : ''}`);
  return [header, ...lines].join('\n');
}

export interface PreflightOptions {
  /** Default per-check time limit (SAS_PREFLIGHT_TIMEOUT_MS, default 10 s). */
  timeoutMs?: number;
  env?: ConfigReader;
}

/**
 * Runs every check (in order, one at a time - they may touch the same desktop), each with a time limit. A check that throws or times
 * out is red. Returns the report when all are green or skipped; otherwise throws ONE PreflightFailed listing every red check with its hint.
 * Every check runs even after a red one, so the person sees all problems at once.
 */
export async function runPreflight(checks: readonly HealthCheck[], options: PreflightOptions = {}): Promise<PreflightReport> {
  const env = options.env ?? loadEnv();
  const defaultTimeout = options.timeoutMs ?? env.getInt('SAS_PREFLIGHT_TIMEOUT_MS', 10_000);
  const rows: PreflightRow[] = [];
  for (const check of checks) {
    const skipReason = check.skip?.();
    if (skipReason !== undefined) {
      rows.push({ name: check.name, status: 'skipped', detail: skipReason, durationMs: 0 });
      continue;
    }
    const startedAt = Date.now();
    const timeoutMs = check.timeoutMs ?? defaultTimeout;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => check.run()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      rows.push({ name: check.name, status: result.ok ? 'ok' : 'FAILED', detail: result.detail ?? (result.ok ? '' : 'not ok'), hint: check.hint, durationMs: Date.now() - startedAt });
    } catch (error) {
      rows.push({ name: check.name, status: 'FAILED', detail: error instanceof Error ? error.message : String(error), hint: check.hint, durationMs: Date.now() - startedAt });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const report: PreflightReport = { ok: rows.every((row) => row.status !== 'FAILED'), rows, table: formatPreflightTable(rows) };
  if (!report.ok) throw new PreflightFailed(report);
  log.info(`[sas-health] pre-flight green:\n${report.table}`);
  return report;
}

export interface CoreChecksOptions {
  /** Applications whose credentials must be configured and not in a logon cooldown: `['smc', 'eg']`. */
  applications?: readonly string[];
  env?: ConfigReader;
}

/**
 * The checks the core itself can make, for fixtures to put first: the selected environment is declared, the state folder and the
 * audit log are writable, and each application has credentials that are not in a logon cooldown (so a locked-out run stops BEFORE it
 * starts, not at the first test).
 */
export function coreHealthChecks(options: CoreChecksOptions = {}): HealthCheck[] {
  const env = options.env ?? loadEnv();
  const checks: HealthCheck[] = [
    {
      name: 'environment',
      hint: 'declare the environment in the environments file (SAS_ENVIRONMENTS_FILE) or set SAS_ENVIRONMENT to a declared name.',
      run: () => {
        const name = selectedEnvironmentName(env);
        const found = loadEnvironments(env).get(name);
        return found ? { ok: true, detail: `${found.name} (${found.kind}), ${found.hosts.length} host pattern(s)` } : { ok: false, detail: `"${name}" is not declared` };
      },
    },
    {
      name: 'state-dir',
      hint: 'make SAS_STATE_DIR (default .sas-state) writable: the logon-failure marker and the created-objects list live there.',
      run: () => {
        const dir = stateDir(env);
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return { ok: true, detail: path.relative(process.cwd(), dir) || '.' };
      },
    },
    {
      name: 'audit-log',
      hint: 'make the audit folder writable or point SAS_AUDIT_FILE at a writable file: no privileged action runs without an audit record.',
      run: () => {
        const audit = new AuditLog({ env });
        audit.ensureWritable();
        return { ok: true, detail: path.relative(process.cwd(), audit.file) };
      },
    },
  ];
  for (const application of options.applications ?? []) {
    checks.push({
      name: `credentials:${application}`,
      hint: `set ${credentialVariables(application).user} and ${credentialVariables(application).password} (or SAS_USER / SAS_PASSWORD) in .env.<ENV>.local; if a logon cooldown is active, follow the steps in its message.`,
      run: () => {
        const credentials = credentialsFor(application, env);
        new LogonGuard({ env }).assertAllowed(selectedEnvironmentName(env), credentials);
        return { ok: true, detail: `${credentials.user} (from ${credentials.source}); no logon cooldown` };
      },
    });
  }
  return checks;
}
