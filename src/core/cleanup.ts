import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv, scrubText, type ConfigReader } from '@automation/referenced-automation-utils';
import { getRunContext, type RunContext } from './runContext';
import { maskSecrets } from './secrets';
import { stateDir } from './stateDir';

const log = getLogger('sas-cleanup');

export const CREATED_OBJECTS_FILE = 'created-objects.jsonl';
export const DEFAULT_CLEANUP_TIMEOUT_MS = 60_000;
export const DEFAULT_CLEANUP_GRACE_MS = 10_000;

/**
 * The record of what a run created, written the moment it is created (so a crashed process still leaves a trail) and closed when the
 * object is removed. One JSON object per line in `.sas-state/created-objects.jsonl`:
 *   { "event": "created", "runId", "environment", "driver", "type", "name", "id"?, "test"?, "at" }
 *   { "event": "removed", ...same key..., "at", "reason"? }   - the clean-up undid it (or the sweeper did)
 *   { "event": "kept",    ...same key..., "at", "reason"? }   - deliberately left behind
 * An ORPHAN is a `created` line with no later `removed` or `kept` for the same runId + environment + type + name.
 */
export interface CreatedEvent {
  event: 'created' | 'removed' | 'kept';
  runId: string;
  environment: string;
  driver: string;
  /** What kind of object: 'folder', 'group', 'library', 'project'. */
  type: string;
  /** Its name or path - starts with the run's namespace prefix, which is how the sweeper finds it. */
  name: string;
  id?: string;
  test?: string;
  at: string;
  reason?: string;
}

export interface Orphan extends CreatedEvent {
  event: 'created';
  ageMs: number;
}

export function createdObjectsPath(dir: string = stateDir()): string {
  return path.resolve(dir, CREATED_OBJECTS_FILE);
}

function keyOf(e: Pick<CreatedEvent, 'runId' | 'environment' | 'type' | 'name'>): string {
  return `${e.runId}\u0000${e.environment}\u0000${e.type}\u0000${e.name}`;
}

function appendEvent(event: CreatedEvent, dir: string): void {
  const file = createdObjectsPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // names may come from test data: mask anything that looks like a credential before it is written
  fs.appendFileSync(file, `${JSON.stringify({ ...event, name: scrubText(event.name), ...(event.reason ? { reason: maskSecrets(event.reason).slice(0, 300) } : {}) })}\n`, { mode: 0o600 });
}

/** Writes a `created` line (used by the registry; a driver that creates objects outside a registry may call it directly). */
export function recordCreated(event: Omit<CreatedEvent, 'event' | 'at'>, dir: string = stateDir(), now: number = Date.now()): void {
  appendEvent({ ...event, event: 'created', at: new Date(now).toISOString() }, dir);
}

/** Closes an orphan: the object was removed (by the clean-up or by the sweeper) or deliberately kept. */
export function recordClosed(event: Omit<CreatedEvent, 'event' | 'at'>, how: 'removed' | 'kept', dir: string = stateDir(), now: number = Date.now()): void {
  appendEvent({ ...event, event: how, at: new Date(now).toISOString() }, dir);
}

/** Every event in the file, in order. A line that is not valid JSON throws with its line number: skipping it would hide an orphan from a sweeper that trusts the list. */
export function readCreatedEvents(dir: string = stateDir()): CreatedEvent[] {
  const file = createdObjectsPath(dir);
  if (!fs.existsSync(file)) return [];
  const out: CreatedEvent[] = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (!line.trim()) return;
      try {
        out.push(JSON.parse(line) as CreatedEvent);
      } catch {
        throw new Error(`${file} line ${index + 1} is not valid JSON - the created-objects list is damaged, so it cannot be used to sweep`);
      }
    });
  return out;
}

/**
 * Objects created more than `olderThanMs` ago that were never removed or kept - oldest first. A sweeper removes them (checking each
 * name still carries its run's namespace prefix) and then calls `recordClosed(orphan, 'removed')`.
 */
export function findOrphans(olderThanMs: number, options: { dir?: string; now?: number } = {}): Orphan[] {
  const now = options.now ?? Date.now();
  const open = new Map<string, CreatedEvent>();
  for (const event of readCreatedEvents(options.dir)) {
    if (event.event === 'created') open.set(keyOf(event), event);
    else open.delete(keyOf(event));
  }
  return [...open.values()]
    .map((event) => ({ ...event, event: 'created' as const, ageMs: now - Date.parse(event.at) }))
    .filter((orphan) => orphan.ageMs >= olderThanMs)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Orphans grouped by run id, so a sweeper can handle one run's namespace at a time. */
export function orphansByRun(orphans: readonly Orphan[]): Map<string, Orphan[]> {
  const groups = new Map<string, Orphan[]>();
  for (const orphan of orphans) groups.set(orphan.runId, [...(groups.get(orphan.runId) ?? []), orphan]);
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------- registry

export interface CleanupContext {
  /** Aborted when the undo runs out of time: stop working in SAS and return - the next clean-up waits for you to finish. */
  signal: AbortSignal;
}

export interface CleanupEntry {
  type: string;
  name: string;
  id?: string;
  /** Defaults to the registry's driver. */
  driver?: string;
  /** Undoes the creation. Throw to report a failure. */
  undo: (context: CleanupContext) => Promise<void> | void;
}

export type CleanupStatus = 'removed' | 'failed' | 'timeout' | 'not-attempted';

export interface CleanupResult {
  type: string;
  name: string;
  id?: string;
  status: CleanupStatus;
  error?: string;
  durationMs: number;
}

export interface CleanupReport {
  ok: boolean;
  results: CleanupResult[];
  failed: CleanupResult[];
}

/** Clean-up left objects behind. Lists each, and how to remove it by hand. Not swallowed: the test that created them fails. */
export class CleanupFailed extends AdapterError {
  constructor(readonly report: CleanupReport, runId: string) {
    super(
      'sas-cleanup',
      'cleanup',
      `${report.failed.length} object(s) could not be removed and are left in SAS (recorded as orphans in ${CREATED_OBJECTS_FILE}):\n` +
        report.failed.map((r) => `  - ${r.type} "${r.name}": ${r.status}${r.error ? ` - ${r.error}` : ''}`).join('\n') +
        `\nRemove them by hand (they all start with the run's namespace, run id ${runId}) or let the orphan sweeper do it.`,
    );
    this.name = 'CleanupFailed';
    Object.setPrototypeOf(this, CleanupFailed.prototype);
  }
}

export interface CleanupRegistryOptions {
  environment: string;
  driver?: string;
  run?: RunContext;
  env?: ConfigReader;
  /** Folder of the orphan record; default SAS_STATE_DIR. `false` writes no record (tests of the ordering alone). */
  stateDir?: string | false;
  testName?: string;
  /** Longest one undo may run before it is asked to stop (default SAS_CLEANUP_TIMEOUT_MS = 60 s). */
  timeoutMs?: number;
  /** How long an undo that was asked to stop gets to actually finish (default SAS_CLEANUP_GRACE_MS = 10 s). */
  graceMs?: number;
}

interface Registered extends CleanupEntry {
  status: 'pending' | CleanupStatus;
}

/**
 * What one test created in SAS, so it is undone even when the test fails. Register at the moment of creation; run after the test
 * (pass or fail). Undo runs newest first, ONE AT A TIME (two undos working in the same desktop session would corrupt each other),
 * each with a time limit and an abort signal. A failure does not stop the rest, and is reported, not swallowed. An undo that does not
 * finish even after the grace time gets the remaining ones marked `not-attempted` - they are not started while something is still
 * working in SAS. Everything not removed stays in the orphan record.
 */
export class CleanupRegistry {
  private readonly entries: Registered[] = [];
  private readonly run_: RunContext;
  private readonly dir: string | false;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private running: Promise<CleanupReport> | undefined;

  constructor(private readonly options: CleanupRegistryOptions) {
    const env = options.env ?? loadEnv();
    this.run_ = options.run ?? getRunContext();
    this.dir = options.stateDir ?? stateDir(env);
    this.timeoutMs = options.timeoutMs ?? env.getInt('SAS_CLEANUP_TIMEOUT_MS', DEFAULT_CLEANUP_TIMEOUT_MS);
    this.graceMs = options.graceMs ?? env.getInt('SAS_CLEANUP_GRACE_MS', DEFAULT_CLEANUP_GRACE_MS);
    if (this.timeoutMs < 1 || this.graceMs < 0) throw new Error('SAS_CLEANUP_TIMEOUT_MS must be 1 or more and SAS_CLEANUP_GRACE_MS 0 or more');
  }

  private identity(entry: CleanupEntry): Omit<CreatedEvent, 'event' | 'at'> {
    return {
      runId: this.run_.runId,
      environment: this.options.environment,
      driver: entry.driver ?? this.options.driver ?? 'sas',
      type: entry.type,
      name: entry.name,
      ...(entry.id ? { id: entry.id } : {}),
      ...(this.options.testName ? { test: this.options.testName } : {}),
    };
  }

  /** Registers an undo for something that was just created, and writes the `created` line of the orphan record. */
  register(entry: CleanupEntry): void {
    this.entries.push({ ...entry, status: 'pending' });
    if (this.dir !== false) recordCreated(this.identity(entry), this.dir);
    log.info(`[sas-cleanup] registered cleanup of ${entry.type} "${entry.name}"`);
  }

  get pending(): readonly { type: string; name: string }[] {
    return this.entries.filter((e) => e.status === 'pending').map(({ type, name }) => ({ type, name }));
  }

  /** Undoes everything registered, newest first. Never throws for an undo failure: look at the report, or use `runAndThrow`. */
  run(): Promise<CleanupReport> {
    this.running ??= this.execute().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** `run()`, then throws CleanupFailed when anything was left behind. */
  async runAndThrow(): Promise<CleanupReport> {
    const report = await this.run();
    if (!report.ok) throw new CleanupFailed(report, this.run_.runId);
    return report;
  }

  private async execute(): Promise<CleanupReport> {
    const results: CleanupResult[] = [];
    let stuck: string | undefined;
    for (const entry of [...this.entries].reverse()) {
      if (entry.status !== 'pending') continue;
      const label = `${entry.type} "${entry.name}"`;
      if (stuck) {
        entry.status = 'not-attempted';
        results.push({ type: entry.type, name: entry.name, id: entry.id, status: 'not-attempted', error: `not attempted: the cleanup of ${stuck} is still running in SAS`, durationMs: 0 });
        log.warn(`[sas-cleanup] skipped the cleanup of ${label}: the cleanup of ${stuck} is still running`);
        continue;
      }
      const startedAt = Date.now();
      const controller = new AbortController();
      const settled = Promise.resolve()
        .then(() => entry.undo({ signal: controller.signal }))
        .then(
          () => undefined as unknown,
          (error: unknown) => ({ error }),
        );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      });
      const first = await Promise.race([settled, timeout]);
      if (timer) clearTimeout(timer);
      const durationMs = () => Date.now() - startedAt;
      if (first === 'timeout') {
        controller.abort(new Error(`cleanup of ${label} ran out of time (${this.timeoutMs} ms)`));
        let graceTimer: NodeJS.Timeout | undefined;
        const finished = await Promise.race([
          settled.then(() => true),
          new Promise<boolean>((resolve) => {
            graceTimer = setTimeout(() => resolve(false), this.graceMs);
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (!finished) stuck = label;
        entry.status = 'timeout';
        results.push({ type: entry.type, name: entry.name, id: entry.id, status: 'timeout', error: `ran out of time after ${this.timeoutMs} ms${finished ? '' : ' and did not stop when asked'}`, durationMs: durationMs() });
        log.error(`[sas-cleanup] cleanup of ${label} timed out`);
        continue;
      }
      if (first !== undefined) {
        const message = maskSecrets((first as { error: unknown }).error instanceof Error ? ((first as { error: Error }).error.message) : String((first as { error: unknown }).error)).slice(0, 500);
        entry.status = 'failed';
        results.push({ type: entry.type, name: entry.name, id: entry.id, status: 'failed', error: message, durationMs: durationMs() });
        log.error(`[sas-cleanup] cleanup of ${label} FAILED: ${message}`);
        continue;
      }
      entry.status = 'removed';
      if (this.dir !== false) recordClosed(this.identity(entry), 'removed', this.dir);
      results.push({ type: entry.type, name: entry.name, id: entry.id, status: 'removed', durationMs: durationMs() });
      log.info(`[sas-cleanup] removed ${label}`);
    }
    const failed = results.filter((r) => r.status !== 'removed');
    return { ok: failed.length === 0, results, failed };
  }
}
