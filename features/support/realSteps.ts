import type { TestInfo } from '@playwright/test';
import type { BddSteps } from '@automation/referenced-automation-ui';
import { readAudit } from '../../src/core';
import { desktopExpect as expect } from '../../src/desktop';
import { sampleProjectPath } from '../../src/fixtures';
import type { ProcessDriver } from '../../src/process';
import type { SasStepFixtures } from './sasSteps';

/**
 * The steps of the scenarios meant for a machine with SAS (features/real): what they look at comes from the SAS_SAMPLE_* settings, and
 * a scenario whose setting is not there is SKIPPED with the reason - never silently passed. Everything they do only READS.
 */

/** What these steps take from the test, beyond the shared ones. */
export interface RealStepFixtures extends SasStepFixtures {
  sasProcess: ProcessDriver;
  $testInfo: TestInfo;
}

const UNSET_TOOL = 'set SAS_SAMPLE_TOOL (and SAS_SAMPLE_TOOL_ARGS) to a command that only prints something, for example the version option of a SAS tool';
const UNSET_PROJECT = 'set SAS_SAMPLE_EG_PROJECT to the full path of an existing project (for example C:\\Projects\\Sales.egp)';

export function registerRealSteps({ Given, When, Then }: BddSteps): void {
  // ======================================================================================================= Given

  Given('a command that only prints something is configured', async ({ desktopSettings, world, $testInfo }: RealStepFixtures) => {
    const env = desktopSettings.env;
    const tool = env.getOptional('SAS_SAMPLE_TOOL');
    $testInfo.skip(tool === undefined, UNSET_TOOL);
    world.sample = { tool: tool as string, args: env.getList('SAS_SAMPLE_TOOL_ARGS', []), successExit: env.getInt('SAS_SAMPLE_TOOL_EXIT', 0), expected: env.getOptional('SAS_SAMPLE_TOOL_EXPECT') };
  });

  Given('an existing Enterprise Guide project to look at is remembered as {string}', async ({ desktopSettings, fakeDesktop, runContext, vars, $testInfo }: RealStepFixtures, as: string) => {
    const project = desktopSettings.env.getOptional('SAS_SAMPLE_EG_PROJECT') ?? (fakeDesktop ? sampleProjectPath(runContext) : undefined);
    $testInfo.skip(project === undefined, UNSET_PROJECT);
    vars.set(as, project as string);
  });

  // ======================================================================================================= When

  // `kind: 'read'` tells the policy this changes nothing; `local: true` says it contacts no SAS host. The call is judged BEFORE it starts.
  When('I run the sample command as the read-only operation {string}', async ({ sasProcess, world, vars }: RealStepFixtures, operation: string) => {
    if (!world.sample) throw new Error('no sample command is configured in this scenario: start with `Given a command that only prints something is configured`');
    world.command = await sasProcess.run({ command: world.sample.tool, args: world.sample.args, kind: 'read', local: true, operation: vars.interpolate(operation) });
  });

  // A "destructive" call on an object the run did not create: the policy refuses it - in a production environment because nothing may change
  // there, elsewhere because the object is not named with this run's namespace. The tool never runs.
  When('I try to run a command that deletes {string} as the operation {string}', async ({ desktopSettings, sasProcess, world, vars }: RealStepFixtures, target: string, operation: string) => {
    const tool = desktopSettings.env.getOptional('SAS_SAMPLE_TOOL') ?? process.execPath;
    const attempt = sasProcess.run({ command: tool, kind: 'destructive', target: vars.interpolate(target), local: true, operation: vars.interpolate(operation) });
    world.attempt = {
      error: await attempt.then(
        () => undefined,
        (error: unknown) => error ?? new Error('the attempt failed'),
      ),
    };
  });

  // ======================================================================================================= Then

  Then('the tool folders exist and nobody else can write into them', async ({ sasProcess }: RealStepFixtures) => {
    const health = await sasProcess.health();
    expect(health.ok, health.detail).toBe(true);
  });

  Then('the sample command finished in time with the exit code it is expected to end with', async ({ world }: RealStepFixtures) => {
    const { command, sample } = world;
    if (!command || !sample) throw new Error('the sample command was not run in this scenario');
    expect(command.timedOut, 'the command ran longer than SAS_PROCESS_TIMEOUT_MS').toBe(false);
    expect(command.exitCode, `${command.commandLine}\n${command.stderr}`).toBe(sample.successExit);
  });

  Then('the output of the sample command matches the expected pattern, when one is set', async ({ world }: RealStepFixtures) => {
    const { command, sample } = world;
    if (!command || !sample) throw new Error('the sample command was not run in this scenario');
    if (sample.expected !== undefined) expect(`${command.stdout}\n${command.stderr}`).toMatch(new RegExp(sample.expected, 'i'));
  });

  // The audit log is what a reviewer reads: who ran what, where, with what outcome - and never a secret.
  Then('the audit log holds a record of the sample command as the read-only operation {string}', async ({ safetyPolicy, runContext, world, vars }: RealStepFixtures, operation: string) => {
    const wanted = vars.interpolate(operation);
    const record = readAudit(safetyPolicy.audit.file, { runId: runContext.runId }).find((r) => r.operation === wanted);
    expect(record, 'one audit record for the run').toBeDefined();
    expect(record).toMatchObject({ driver: 'sas-process', kind: 'read', outcome: world.sample?.successExit === 0 ? 'ok' : 'error' });
  });

  Then('the audit log holds a denied record of the operation {string}', async ({ safetyPolicy, runContext, vars }: RealStepFixtures, operation: string) => {
    const wanted = vars.interpolate(operation);
    const record = readAudit(safetyPolicy.audit.file, { runId: runContext.runId }).find((r) => r.operation === wanted);
    expect(record, 'a denied record').toMatchObject({ outcome: 'denied' });
  });

  Then('the names this run may change start with {string}', async ({ runContext }: RealStepFixtures, prefix: string) => {
    expect(runContext.ns('Anything').startsWith(prefix), `${runContext.ns('Anything')} starts with ${prefix}`).toBe(true); // what the run MAY change starts like this
  });

  Then('the User Manager lists the sample user when one is known', async ({ desktopScenario, desktopSettings, fakeDesktop }: RealStepFixtures) => {
    const wanted = desktopSettings.env.getOptional('SAS_SAMPLE_SMC_USER') ?? (fakeDesktop ? 'sasdemo' : undefined);
    if (wanted !== undefined) expect(await desktopScenario.requireSmc().findUser(wanted)).toBe(wanted);
  });
}
