import { PolicyViolation, readAudit } from '../../src/core';
import { sampleProjectPath } from '../../src/fixtures';
import { expect, test } from './support/exampleTest';

/**
 * EXAMPLE 4 - what the safety policy does when a test steps outside its rules. Every step of every driver passes the policy and leaves
 * a line in the audit log; a refusal changes nothing in SAS. Read docs/SECURITY.md for the rules.
 *
 *     npm run try:simulator -- 04_
 *
 * The settings it relies on (all in .env.example):
 *   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  the declared environment and its kind: nonprod, or prod (read-only by construction)
 *   SAS_ALLOW_OUTSIDE_NAMESPACE, SAS_ALLOW_OUTSIDE_NAMESPACE_REASON  the deliberate, logged exception to "only change what you created"
 *   SAS_NAMESPACE_PATTERN   how the run's namespace is named (AUTO_{runId} by default)
 *   SAS_AUDIT_FILE          where the audit log is written (test-results/sas-audit/audit-<runId>.jsonl by default)
 */

test.describe('EXAMPLE 4 - the safety policy', () => {
  test('running a project that is not named with the run namespace is refused, and the refusal is audited @sas-desktop @eg-com @example', async ({ egCom, runContext, safetyPolicy, fakeDesktop }) => {
    // A project that exists under its own name (the stand-in's default sample): opening it is a read, so it is allowed ...
    const own = 'C:\\Projects\\Sales.egp';
    expect(await egCom.openProject(own)).toBe('Sales.egp');

    // ... but RUNNING it is an update, and it is not inside this run's namespace (AUTO_<runId>_...): refused BEFORE anything runs.
    const refusal = (await egCom.runProject().catch((error: unknown) => error)) as PolicyViolation;
    expect(refusal).toBeInstanceOf(PolicyViolation);
    expect(refusal.rule).toBe('outside-namespace');
    expect(refusal.message).toContain('How to proceed');
    expect(fakeDesktop?.eg.ran).not.toContain(`project:${own}`); // nothing ran in the program

    // The audit log says so: who (run id, correlation id), what, where, and how it ended.
    const denied = readAudit(safetyPolicy.audit.file, { outcome: 'denied', runId: runContext.runId }).filter((r) => r.operation === 'runProject' && r.target === own);
    expect(denied.map((r) => r.reason)).toEqual(['outside-namespace']);

    // The same project, inside the namespace, runs.
    await egCom.openProject(sampleProjectPath(runContext));
    expect((await egCom.runProject()).length).toBeGreaterThan(0);
  });
});
