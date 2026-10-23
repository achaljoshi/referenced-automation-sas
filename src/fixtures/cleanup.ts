import { CleanupFailed, CleanupRegistry, type CleanupReport } from '../core';
import type { CleanupFailureMode } from './settings';

/**
 * The per-test clean-up registry. Register what a test creates in SAS - at the moment it is created - with how to undo it; the
 * undo runs after the test, pass or fail, newest first, one at a time (see `CleanupRegistry`).
 *
 * The fixtures run it TWICE in effect: the app fixtures flush it just before they close their program (an undo may need the program
 * open), and the `cleanup` fixture flushes it again at its own teardown. `flush()` is memoised so the undo runs once and both callers
 * see the same report - a failure is never lost because the first caller was not the one who reports.
 */
export class FixtureCleanup extends CleanupRegistry {
  private flushed?: Promise<CleanupReport>;

  flush(): Promise<CleanupReport> {
    this.flushed ??= this.run();
    return this.flushed;
  }
}

export interface CleanupTestInfo {
  annotations: Array<{ type: string; description?: string }>;
}

/**
 * What a clean-up that left objects behind does to its test: every one becomes a test annotation, and unless the mode is `warn`
 * (SAS_CLEANUP_FAILURE=warn) the test FAILS with the list - a leftover object in a shared SAS system is a defect, not a log line.
 */
export function surfaceCleanupFailures(report: CleanupReport, testInfo: CleanupTestInfo, mode: CleanupFailureMode, runId: string): void {
  if (report.ok) return;
  for (const failed of report.failed) testInfo.annotations.push({ type: 'sas-cleanup-failed', description: `${failed.type} "${failed.name}": ${failed.status}${failed.error ? ` - ${failed.error}` : ''}` });
  if (mode !== 'warn') throw new CleanupFailed(report, runId);
}
