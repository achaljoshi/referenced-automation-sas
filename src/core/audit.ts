import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv, redact, type ConfigReader } from '@automation/referenced-automation-utils';
import type { OperationKind, OperationOutcome } from './operation';
import { getRunContext, type RunContext } from './runContext';
import { maskSecrets } from './secrets';

const log = getLogger('sas-audit');

export const DEFAULT_AUDIT_DIR = 'test-results/sas-audit';
export const DEFAULT_AUDIT_KEEP_RUNS = 20;

/**
 * One JSON line per privileged action, written for a security reviewer: who (run id, correlation id), what (driver, operation, kind,
 * target), where (environment, host), and how it ended (ok / denied / error, duration). No secrets: every record passes through the
 * shared logger's redaction (sensitive keys, tokens, `password=...`) and through the known-secret masker before it is written.
 */
export interface AuditRecord {
  /** ISO time the record was written. */
  time: string;
  runId: string;
  correlationId: string;
  driver: string;
  environment: string;
  operation: string;
  kind: OperationKind;
  /** The SAS object(s) concerned (a name or path). */
  target?: string;
  host?: string;
  outcome: OperationOutcome;
  durationMs?: number;
  /** For `denied`: the policy rule. For `error`: the failure in one line. */
  reason?: string;
  /** Set when an explicit override allowed it, e.g. `outside-namespace`, with the stated reason in `reason`. */
  override?: string;
  /** Short facts such as `{ exitCode: 0 }`. */
  detail?: Record<string, unknown>;
}

function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  return value;
}

export type AuditEntry = Omit<AuditRecord, 'time' | 'runId' | 'correlationId'>;

/** The audit log could not be written. Privileged work must not go on unaudited, so this is an error, not a warning. */
export class AuditUnavailable extends AdapterError {
  constructor(file: string, cause: unknown) {
    super(
      'sas-audit',
      'write',
      `the audit log ${file} cannot be written (${cause instanceof Error ? cause.message : String(cause)}). No privileged action runs without an audit record. ` +
        `Fix the folder permissions or point SAS_AUDIT_FILE at a writable file.`,
    );
    this.name = 'AuditUnavailable';
    Object.setPrototypeOf(this, AuditUnavailable.prototype);
  }
}

export interface AuditLogOptions {
  /** The file; default SAS_AUDIT_FILE, else `test-results/sas-audit/audit-<runId>.jsonl`. */
  file?: string;
  run?: RunContext;
  env?: ConfigReader;
  /** Runs kept in the default folder (default SAS_AUDIT_KEEP_RUNS = 20). */
  keepRuns?: number;
  now?: () => Date;
}

/**
 * The default file for a run: one file per run (`audit-<runId>.jsonl`), so a run's records stay together and old runs can be rotated.
 * SAS_AUDIT_FILE overrides it with one fixed file. Note that Playwright empties `test-results` at the start of a run: to keep audit
 * records across runs, point SAS_AUDIT_FILE outside it (or collect the folder as a CI artifact).
 */
export function defaultAuditFile(run: RunContext, env: ConfigReader = loadEnv()): string {
  const configured = env.getOptional('SAS_AUDIT_FILE');
  return path.resolve(configured ?? path.join(DEFAULT_AUDIT_DIR, `audit-${run.runId}.jsonl`));
}

export class AuditLog {
  readonly file: string;
  private readonly run: RunContext;
  private readonly env: ConfigReader;
  private readonly keepRuns: number;
  private readonly now: () => Date;
  private readonly rotating: boolean;
  private prepared = false;

  constructor(options: AuditLogOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.run = options.run ?? getRunContext();
    this.file = path.resolve(options.file ?? defaultAuditFile(this.run, this.env));
    this.rotating = options.file === undefined && this.env.getOptional('SAS_AUDIT_FILE') === undefined;
    this.keepRuns = options.keepRuns ?? this.env.getInt('SAS_AUDIT_KEEP_RUNS', DEFAULT_AUDIT_KEEP_RUNS);
    if (this.keepRuns < 1) throw new Error(`SAS_AUDIT_KEEP_RUNS must be 1 or more (found ${this.keepRuns})`);
    this.now = options.now ?? (() => new Date());
  }

  /** Creates the folder and the file (mode 0600) and rotates old runs. Throws AuditUnavailable: call before a privileged action starts. */
  ensureWritable(): void {
    if (this.prepared) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.closeSync(fs.openSync(this.file, 'a', 0o600));
    } catch (error) {
      throw new AuditUnavailable(this.file, error);
    }
    this.prepared = true;
    if (this.rotating) this.rotate();
  }

  /** Keeps the newest `keepRuns` run files in the default folder (by modification time); never the current one. */
  private rotate(): void {
    try {
      const dir = path.dirname(this.file);
      const files = fs
        .readdirSync(dir)
        .filter((name) => /^audit-[A-Za-z0-9]+\.jsonl$/.test(name))
        .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(this.keepRuns)) {
        if (path.join(dir, old.name) !== this.file) fs.rmSync(path.join(dir, old.name), { force: true });
      }
    } catch (error) {
      log.warn(`[sas-audit] could not rotate old audit files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Writes one record. Throws AuditUnavailable when it cannot. Returns the record as written (redacted). */
  append(entry: AuditEntry): AuditRecord {
    this.ensureWritable();
    const raw: AuditRecord = {
      time: this.now().toISOString(),
      runId: this.run.runId,
      correlationId: this.run.correlationId,
      ...entry,
    };
    const safe = maskDeep(redact(raw)) as AuditRecord;
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new AuditUnavailable(this.file, error);
    }
    return safe;
  }
}

export interface AuditFilter {
  runId?: string;
  driver?: string;
  outcome?: OperationOutcome;
  environment?: string;
  kind?: OperationKind;
}

/**
 * Reads an audit file for a test or a report. A line that is not valid JSON throws with its line number: a gate that trusts the
 * list must not silently skip a damaged record.
 */
export function readAudit(file: string, filter: AuditFilter = {}): AuditRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: AuditRecord[] = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (!line.trim()) return;
      let record: AuditRecord;
      try {
        record = JSON.parse(line) as AuditRecord;
      } catch {
        throw new Error(`${file} line ${index + 1} is not valid JSON - the audit log is damaged`);
      }
      const keep = (Object.keys(filter) as Array<keyof AuditFilter>).every((key) => filter[key] === undefined || record[key] === filter[key]);
      if (keep) out.push(record);
    });
  return out;
}
