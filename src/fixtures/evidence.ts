import { getLogger } from '@automation/referenced-automation-utils';
import { maskSecrets, type RunContext } from '../core';
import type { DesktopSession, JournalEntry } from '../desktop';

const log = getLogger('sas-fixtures');

/** The part of Playwright's TestInfo the evidence code uses (so it can be tested with a plain object). */
export interface EvidenceTestInfo {
  title: string;
  status?: string;
  expectedStatus: string;
  attach(name: string, options: { body?: string; path?: string; contentType: string }): Promise<void>;
}

/** Did the test end badly (it failed, timed out or was interrupted)? A skipped test is not a failure. */
export function testFailed(testInfo: Pick<EvidenceTestInfo, 'status' | 'expectedStatus'>): boolean {
  return testInfo.status !== undefined && testInfo.status !== 'skipped' && testInfo.status !== testInfo.expectedStatus;
}

/** The step journal lines since `since` (epoch ms), masked: what the test did in the desktop, how long each step took and whether it worked. */
export function journalText(entries: readonly JournalEntry[], since: number): string {
  return entries
    .filter((entry) => entry.at >= since)
    .map((entry) => maskSecrets(`${entry.ok ? 'ok    ' : 'FAILED'} ${String(entry.ms).padStart(5)} ms  ${entry.label}  ${entry.target}${entry.error ? `\n          ${entry.error}` : ''}`))
    .join('\n');
}

export interface TestEvidenceOptions {
  session: DesktopSession;
  run: RunContext;
  testInfo: EvidenceTestInfo;
  /** When the test started (epoch ms): the step journal is cut here. */
  startedAt?: number;
}

/**
 * What the report gets about the desktop, decided by the run's evidence setting (SAS_EVIDENCE):
 *   off      nothing automatic (evidence a test asks for with `app.evidence(...)` is always taken)
 *   failure  (default) a screenshot, the step journal and any locator drift - only when the test failed
 *   on       the same, after every test
 *   steps    `failure`, plus a screenshot after every step that may change something (taken by the desktop session)
 * Screenshots go under `<SAS_EVIDENCE_DIR>/<runId>/` (the run's own folder; other runs' folders are pruned after
 * SAS_EVIDENCE_RETENTION_DAYS) and the bridge paints password fields black before it takes one. Capturing never throws: it must not
 * hide the real failure.
 */
export class TestEvidence {
  private done?: Promise<string[]>;
  private readonly startedAt: number;
  private readonly driftBefore: number;

  constructor(private readonly options: TestEvidenceOptions) {
    this.startedAt = options.startedAt ?? Date.now();
    this.driftBefore = options.session.driftItems.length;
  }

  /** Takes the evidence once (later calls return the same files). Returns the screenshot files written. */
  capture(): Promise<string[]> {
    this.done ??= this.take();
    return this.done;
  }

  private async take(): Promise<string[]> {
    const { session, run, testInfo } = this.options;
    const failed = testFailed(testInfo);
    if (testInfo.status === 'skipped' || !run.shouldCaptureEvidence(failed)) return [];
    const files: string[] = [];
    try {
      const label = `${testInfo.title}${failed ? ' FAILED' : ''}`;
      files.push(await session.evidence(label));
    } catch (error) {
      log.warn(`[sas-fixtures] could not take a screenshot of the desktop: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    try {
      if (failed) {
        const steps = journalText(session.journal, this.startedAt);
        if (steps) await testInfo.attach('desktop-steps', { body: steps, contentType: 'text/plain' });
        const drift = session.driftItems.slice(this.driftBefore);
        if (drift.length > 0)
          await testInfo.attach('desktop-locator-drift', { body: drift.map((d) => `${d.expected}\n  now found via ${d.usedFallback}: ${d.found}`).join('\n'), contentType: 'text/plain' });
      }
    } catch (error) {
      log.warn(`[sas-fixtures] could not attach the step journal: ${error instanceof Error ? error.message : String(error)}`);
    }
    return files;
  }
}
