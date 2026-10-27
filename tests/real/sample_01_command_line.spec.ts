import { expect } from '@playwright/test';
import { desktopConfig } from '../../src/desktop';
import { PolicyViolation, readAudit } from '../../src/core';
import { sasTest as test } from '../../src/fixtures';
import { realTestsSkipReason } from '../support/realOptIn';

/**
 * SAMPLE 1 - the COMMAND LINE route (the first choice of this repo): run a program, let the safety policy judge it, read the audit log.
 * No window is involved, so this sample runs on Windows, macOS and Linux. It only READS: nothing is created, changed or run on SAS.
 *
 *     npm run test:real-samples
 *
 * It needs the run to be asked for on purpose (the real-system tests are opt-in: see tests/support/realOptIn.ts) and a declared SAS
 * environment (SAS_ENVIRONMENT, env/sas-environments.json). Settings - each one is explained in .env.example, section 12:
 *   SAS_TOOL_DIRS            the folders tools are run from; a bare tool name is looked up ONLY here, never on PATH
 *   SAS_SAMPLE_TOOL          the tool to run: a name inside SAS_TOOL_DIRS, or an absolute path. Pick a command that only prints something
 *                            (a version or help option of a SAS tool: NOT VERIFIED which options YOUR release has)
 *   SAS_SAMPLE_TOOL_ARGS     its arguments, separated by commas (so an argument cannot contain a comma): --version
 *   SAS_SAMPLE_TOOL_EXPECT   optional: a regular expression the output must match, case-insensitive
 *   SAS_SAMPLE_TOOL_EXIT     optional: the exit code that means success (default 0)
 *
 * Without SAS_SAMPLE_TOOL the test that runs a tool is SKIPPED with the reason - never silently passed. The other two need no tool.
 */
const skipReason = realTestsSkipReason({ realTests: process.env.SAS_REAL_TESTS, simulated: desktopConfig().simulator });
test.skip(skipReason !== undefined, skipReason ?? '');

test.describe('SAMPLE 1 - the command line @real-sample @sas-cli', () => {
  test('the tool folders are usable: they exist and nobody else can write into them @real-sample @sas-cli', async ({ sasProcess }) => {
    const health = await sasProcess.health();
    expect(health.ok, health.detail).toBe(true);
  });

  test('a read-only command runs through the policy gate and leaves one audit record @real-sample @sas-cli', async ({ sasProcess, safetyPolicy, runContext, desktopSettings }) => {
    const env = desktopSettings.env;
    const tool = env.getOptional('SAS_SAMPLE_TOOL');
    test.skip(tool === undefined, 'set SAS_SAMPLE_TOOL (and SAS_SAMPLE_TOOL_ARGS) to a command that only prints something, for example the version option of a SAS tool');
    const args = env.getList('SAS_SAMPLE_TOOL_ARGS', []);
    const success = env.getInt('SAS_SAMPLE_TOOL_EXIT', 0);

    // `kind: 'read'` tells the policy this changes nothing; `local: true` says it contacts no SAS host. The call is judged BEFORE it starts.
    const result = await sasProcess.run({ command: tool as string, args, kind: 'read', local: true, operation: 'sample:read' });

    expect(result.timedOut, 'the command ran longer than SAS_PROCESS_TIMEOUT_MS').toBe(false);
    expect(result.exitCode, `${result.commandLine}\n${result.stderr}`).toBe(success);
    const expected = env.getOptional('SAS_SAMPLE_TOOL_EXPECT');
    if (expected !== undefined) expect(`${result.stdout}\n${result.stderr}`).toMatch(new RegExp(expected, 'i'));

    // The audit log is what a reviewer reads: who ran what, where, with what outcome - and never a secret.
    const record = readAudit(safetyPolicy.audit.file, { runId: runContext.runId }).find((r) => r.operation === 'sample:read');
    expect(record, 'one audit record for the run').toBeDefined();
    expect(record).toMatchObject({ driver: 'sas-process', kind: 'read', outcome: success === 0 ? 'ok' : 'error' });
  });

  test('a change outside this run\'s own objects is refused before anything starts @real-sample @sas-cli', async ({ sasProcess, safetyPolicy, runContext, desktopSettings }) => {
    // A "destructive" call on an object the run did not create. The policy refuses it - in a production environment because nothing may change
    // there, elsewhere because the object is not named with this run's namespace (runContext.ns('...') = AUTO_<runId>_...). The tool never runs.
    const tool = desktopSettings.env.getOptional('SAS_SAMPLE_TOOL') ?? process.execPath;
    const attempt = sasProcess.run({ command: tool, kind: 'destructive', target: 'A Library Somebody Else Owns', local: true, operation: 'sample:delete' });
    await expect(attempt).rejects.toBeInstanceOf(PolicyViolation);
    const record = readAudit(safetyPolicy.audit.file, { runId: runContext.runId }).find((r) => r.operation === 'sample:delete');
    expect(record, 'a denied record').toMatchObject({ outcome: 'denied' });
    expect(runContext.ns('Anything')).toMatch(/^AUTO_/); // what the run MAY change starts like this
  });
});
