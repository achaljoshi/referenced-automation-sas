import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCorrelationId, getLogger, loadEnv, newCorrelationId, type ConfigReader } from '@automation/referenced-automation-utils';
import { ConfigurationError } from './errors';

const log = getLogger('sas-core');

/**
 * One run = one id. Everything a run creates in SAS lives under the run's test namespace (`AUTO_<runId>_...`), the audit log and the
 * evidence are filed under it, and the orphan sweeper removes leftovers by it.
 *
 * Playwright workers are separate processes. To make every worker of one run share the id, call `initRunContext()` once in the
 * Playwright config (or global setup): it writes SAS_RUN_ID into the environment, which the workers inherit. Without that, each
 * worker generates its own id - still safe (a smaller namespace each) but the run is no longer one unit.
 */

const RUN_ID_PATTERN = /^[A-Za-z0-9]{3,24}$/;
export const DEFAULT_NAMESPACE_PATTERN = 'AUTO_{runId}';
export const DEFAULT_EVIDENCE_DIR = 'test-results/sas-evidence';
export const DEFAULT_EVIDENCE_RETENTION_DAYS = 7;

/** `yyMMddHHmmss` (UTC) + 4 random hex digits: sortable, readable, alphanumeric only (no "_" so a name boundary is unambiguous). */
export function generateRunId(now: Date = new Date(), random: Buffer = crypto.randomBytes(2)): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp = `${p(now.getUTCFullYear() % 100)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${stamp}${random.toString('hex').slice(0, 4)}`;
}

/** The start time encoded in a generated run id (UTC); undefined for a custom id (for example a CI pipeline number). */
export function runIdTime(runId: string): Date | undefined {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})[0-9a-f]{4}$/.exec(runId);
  if (!m) return undefined;
  const [yy, mo, dd, hh, mi, ss] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The namespace prefix for a run: SAS_NAMESPACE_PATTERN with `{runId}` filled in (default `AUTO_{runId}` -> `AUTO_<runId>`). */
export function namespacePrefix(runId: string, pattern: string = DEFAULT_NAMESPACE_PATTERN): string {
  const parts = pattern.split('{runId}');
  if (parts.length !== 2) throw new ConfigurationError('namespace', `SAS_NAMESPACE_PATTERN "${pattern}" must contain {runId} exactly once`);
  const lead = (parts[0] as string).trim();
  if (lead.length < 3)
    throw new ConfigurationError('namespace', `SAS_NAMESPACE_PATTERN "${pattern}" must start with at least 3 literal characters before {runId} (an empty or tiny prefix would make every object "ours")`);
  if (!/^[A-Za-z0-9 _.-]*$/.test(pattern.replace('{runId}', ''))) throw new ConfigurationError('namespace', `SAS_NAMESPACE_PATTERN "${pattern}" may only contain letters, digits, space, "_", "." and "-"`);
  return pattern.replace('{runId}', runId);
}

/**
 * Is `target` (an object name, or a path with "/" or "\\" separators) inside the namespace? True when ANY segment starts with the
 * prefix followed by "_" or the end of the segment (so run `r1` does not own `AUTO_r12_x`). Comparison ignores case. A path that
 * climbs out with ".." is never inside; neither is an empty target.
 */
export function targetInNamespace(target: string, prefix: string): boolean {
  const segments = target.split(/[\\/]/).map((s) => s.trim()).filter((s) => s !== '');
  if (segments.length === 0 || segments.some((s) => s === '..' || s === '.')) return false;
  const wanted = prefix.toLowerCase();
  return segments.some((segment) => {
    const s = segment.toLowerCase();
    return s.startsWith(wanted) && (s.length === wanted.length || s[wanted.length] === '_');
  });
}

export interface RunContextOptions {
  runId?: string;
  env?: ConfigReader;
  now?: Date;
}

export type EvidenceMode = 'off' | 'failure' | 'on';

export class RunContext {
  readonly runId: string;
  readonly startedAt: Date;
  /** One id for the whole run. Inside a test the active correlation id (set by the fixtures) is used instead: see `correlationId`. */
  readonly runCorrelationId: string = newCorrelationId();
  readonly namespacePattern: string;
  private readonly env: ConfigReader;

  constructor(options: RunContextOptions = {}) {
    this.env = options.env ?? loadEnv();
    const runId = options.runId ?? this.env.getOptional('SAS_RUN_ID')?.trim() ?? generateRunId(options.now);
    if (!RUN_ID_PATTERN.test(runId))
      throw new ConfigurationError('run-context', `SAS_RUN_ID "${runId}" is not valid: 3 to 24 letters and digits only (no "_" or "-": the namespace boundary depends on it)`);
    this.runId = runId;
    this.startedAt = runIdTime(runId) ?? options.now ?? new Date();
    this.namespacePattern = this.env.get('SAS_NAMESPACE_PATTERN', DEFAULT_NAMESPACE_PATTERN);
    namespacePrefix(runId, this.namespacePattern); // validate now, not at the first mutating call
  }

  /** `AUTO_<runId>` (or what SAS_NAMESPACE_PATTERN says). */
  get namespacePrefix(): string {
    return namespacePrefix(this.runId, this.namespacePattern);
  }

  /** `ns('Users')` -> `AUTO_<runId>_Users`. The name may not contain path separators or "..". */
  ns(name?: string): string {
    if (name === undefined || name === '') return this.namespacePrefix;
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) || name.includes('..'))
      throw new ConfigurationError('namespace', `ns("${name}"): a name may contain letters, digits, space, "_", "." and "-" only, and must start with a letter or digit (no path separators, no "..")`);
    return `${this.namespacePrefix}_${name}`;
  }

  isInNamespace(target: string): boolean {
    return targetInNamespace(target, this.namespacePrefix);
  }

  /** The active correlation id (set per test by the fixtures) or, outside a test, the run's own. */
  get correlationId(): string {
    return getCorrelationId() ?? this.runCorrelationId;
  }

  // ---------------------------------------------------------------------------------------------------- evidence

  /** SAS_EVIDENCE: off | failure (default) | on. Screenshots and dumps of admin screens can contain personal data, so the default is "only when a test fails". */
  get evidenceMode(): EvidenceMode {
    const value = this.env.get('SAS_EVIDENCE', 'failure').trim().toLowerCase();
    if (value !== 'off' && value !== 'failure' && value !== 'on') throw new ConfigurationError('evidence', `SAS_EVIDENCE "${value}" must be off, failure or on`);
    return value;
  }

  shouldCaptureEvidence(testFailed: boolean): boolean {
    const mode = this.evidenceMode;
    return mode === 'on' || (mode === 'failure' && testFailed);
  }

  /** `<SAS_EVIDENCE_DIR>/<runId>` (default `test-results/sas-evidence/<runId>`). Not created until a file is written. */
  get evidenceDir(): string {
    return path.resolve(this.env.get('SAS_EVIDENCE_DIR', DEFAULT_EVIDENCE_DIR), this.runId);
  }

  /**
   * A file path for one piece of evidence, always inside the run's evidence folder: the label is reduced to letters, digits, "." "_" "-"
   * (so a label can never climb out of the folder), the extension must be 1-5 letters or digits, and the name starts with a time
   * stamp so two files with one label do not collide. Creates the folder.
   */
  evidencePath(label: string, extension: string, now: Date = new Date()): string {
    if (!/^[A-Za-z0-9]{1,5}$/.test(extension)) throw new ConfigurationError('evidence', `evidence extension "${extension}" must be 1 to 5 letters or digits (no dot)`);
    const safe = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'evidence';
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
    fs.mkdirSync(this.evidenceDir, { recursive: true });
    const file = path.join(this.evidenceDir, `${stamp}-${safe}.${extension}`);
    if (path.relative(this.evidenceDir, file).startsWith('..')) throw new ConfigurationError('evidence', `evidence path escapes the evidence folder: ${file}`);
    return file;
  }

  /** SAS_EVIDENCE_RETENTION_DAYS: how long a run's evidence folder is kept (default 7; 0 = keep forever). */
  get evidenceRetentionDays(): number {
    const days = this.env.getInt('SAS_EVIDENCE_RETENTION_DAYS', DEFAULT_EVIDENCE_RETENTION_DAYS);
    if (days < 0) throw new ConfigurationError('evidence', `SAS_EVIDENCE_RETENTION_DAYS must be 0 (keep) or a number of days (found ${days})`);
    return days;
  }

  /**
   * Removes the evidence folders of OTHER runs older than the retention time (by last modification). Only direct sub-folders of the
   * evidence root whose name is a valid run id are touched; the current run's folder never is. Returns the folders removed.
   */
  pruneEvidence(now: number = Date.now()): string[] {
    const days = this.evidenceRetentionDays;
    const root = path.dirname(this.evidenceDir);
    if (days === 0 || !fs.existsSync(root)) return [];
    const removed: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === this.runId || !RUN_ID_PATTERN.test(entry.name)) continue;
      const folder = path.join(root, entry.name);
      if (now - fs.statSync(folder).mtimeMs > days * 86_400_000) {
        fs.rmSync(folder, { recursive: true, force: true });
        removed.push(folder);
      }
    }
    if (removed.length > 0) log.info(`[sas-core] removed ${removed.length} evidence folder(s) older than ${days} day(s)`);
    return removed;
  }
}

let current: RunContext | undefined;

/**
 * Creates the run context (once) and exports its id as SAS_RUN_ID so Playwright workers started afterwards share it. Call from
 * playwright.config.ts or a global setup. An id already in SAS_RUN_ID is kept.
 */
export function initRunContext(options: RunContextOptions = {}): RunContext {
  current = new RunContext(options);
  process.env.SAS_RUN_ID = current.runId;
  return current;
}

/** The process-wide run context; created on first use (see initRunContext for sharing it with workers). */
export function getRunContext(): RunContext {
  current ??= new RunContext();
  return current;
}

/** Forgets the process-wide context (tests). */
export function resetRunContext(): void {
  current = undefined;
}
