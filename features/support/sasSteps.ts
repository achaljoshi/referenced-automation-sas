import { AdapterError } from '@automation/referenced-automation-utils';
import type { BddSteps, TableLike } from '@automation/referenced-automation-ui';
import { DEFAULT_ASSERT_TIMEOUT_MS, type DesktopStepFixtures } from '../../src/bdd';
import { PolicyViolation, readAudit, type SafetyPolicy, type SasEnvironment } from '../../src/core';
import { desktopExpect as expect, type FakeSasDesktop } from '../../src/desktop';
import type { DesktopScenario, FixtureCleanup, FixtureSettings } from '../../src/fixtures';
import type { SasWorld } from './world';

/**
 * The steps of this repository that the shipped vocabulary (src/bdd/steps.ts) does not have. They exist where an old plain spec checked
 * something the vocabulary words more loosely - the vocabulary matches case-insensitively, these say "spelled exactly like that" and
 * compare as the spec did - or where a scenario needs to say what happens when the safety policy steps in. Every project of
 * features/ registers them next to `registerDesktopSteps`; the real-machine ones are in realSteps.ts.
 *
 * `tests/bdd/vocabulary.spec.ts` checks that no step here is ambiguous with the vocabulary, and that every sentence of every feature
 * finds exactly one step.
 */

/** What the steps take from the test, beyond the shipped vocabulary's fixtures. */
export interface SasStepFixtures extends DesktopStepFixtures {
  world: SasWorld;
  environment: SasEnvironment;
  safetyPolicy: SafetyPolicy;
  fakeDesktop: FakeSasDesktop | undefined;
  cleanup: FixtureCleanup;
}

/** SAS_ASSERT_TIMEOUT_MS, as for the vocabulary's own assertion steps. */
export const within = (settings: FixtureSettings): { timeout: number } => ({ timeout: settings.env.getInt('SAS_ASSERT_TIMEOUT_MS', DEFAULT_ASSERT_TIMEOUT_MS) });

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The data rows of a Gherkin table whose first row names the columns. */
const rowsOf = (table: TableLike): string[][] => table.raw().slice(1);

/** How a program ended - from the last COM run, the last screens run (the status the vocabulary derives from its log), or the object model itself. */
async function resultOf(scenario: DesktopScenario, program: string): Promise<{ status: string; errors: number; warnings: number }> {
  const known = scenario.statuses.get(program);
  if (known) return known;
  const run = scenario.runs.get(program);
  if (run) return { status: run.errors > 0 ? 'Error' : run.warnings > 0 ? 'Warning' : 'Succeeded', errors: run.errors, warnings: run.warnings };
  if (scenario.route === 'com') return scenario.requireEgCom().programStatus(program);
  throw new AdapterError('sas-steps', 'program', `no result is known for the program "${program}": run it first`);
}

/** What `I try to ...` ended with: the failure, or undefined when the attempt worked. */
const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error('the attempt failed'),
  );

function refusalOf(world: SasWorld): PolicyViolation {
  if (!world.attempt) throw new AdapterError('sas-steps', 'attempt', 'nothing was attempted in this scenario: use an `I try to ...` step first');
  expect(world.attempt.error, 'the attempt must be refused by the safety policy').toBeInstanceOf(PolicyViolation);
  return world.attempt.error as PolicyViolation;
}

export function registerSasSteps({ Given, When, Then }: BddSteps): void {
  // ======================================================================================================= Given

  Given('the selected SAS environment is a production one', async ({ environment }: SasStepFixtures) => {
    expect(environment.kind).toBe('prod');
  });

  // Say once what to do about a dialog that may appear in front of any step, instead of `if (dialog exists)` everywhere.
  Given('Enterprise Guide closes the {string} dialog whenever one appears', async ({ desktopScenario, vars }: SasStepFixtures, title: string) => {
    const wanted = vars.interpolate(title);
    desktopScenario.requireEgUi().app.onDialog(new RegExp(escapeRegExp(wanted), 'i'), (dialog) => dialog.getByRole('Button', { name: 'Close' }).click(), { name: wanted.toLowerCase() });
  });

  // ======================================================================================================= When

  When('I open the Enterprise Guide project {string} and remember its name as {string}', async ({ desktopScenario, vars }: SasStepFixtures, project: string, as: string) => {
    vars.set(as, await desktopScenario.requireEgCom().openProject(vars.interpolate(project)));
  });

  // It CREATES files, so the folder is registered the moment it exists: `cleanup` undoes it after the scenario, pass or fail.
  When('I export the results of the program {string} to the folder {string} and clean it up afterwards', async ({ desktopScenario, vars, world, cleanup, fakeDesktop }: SasStepFixtures, program: string, folder: string) => {
    const target = vars.interpolate(folder);
    const written = await desktopScenario.requireEgCom().exportResults({ program: vars.interpolate(program), folder: target });
    world.written = written;
    cleanup.register({
      type: 'folder',
      name: target,
      undo: () => {
        for (const file of written) fakeDesktop?.eg.com.files.delete(file);
      },
    });
  });

  When('I save the project', async ({ desktopScenario }: SasStepFixtures) => {
    await desktopScenario.requireEgCom().saveProject();
  });

  When('I close the project', async ({ desktopScenario }: SasStepFixtures) => {
    await desktopScenario.requireEgCom().closeProject();
  });

  When('I add a screenshot called {string} to the report', async ({ desktopScenario, vars }: SasStepFixtures, label: string) => {
    await desktopScenario.activeApp().evidence(vars.interpolate(label));
  });

  // The attempt is made and its outcome kept: the Then steps say what the safety policy did with it.
  When('I try to run the project', async ({ desktopScenario, world }: SasStepFixtures) => {
    world.attempt = { error: await caught(desktopScenario.requireEgCom().runProject()) };
  });

  When('I try to click the tab named {string}', async ({ desktopScenario, vars, world }: SasStepFixtures, name: string) => {
    world.attempt = { error: await caught(desktopScenario.requireSmc().mainWindow.getByRole('TabItem', { name: vars.interpolate(name) }).click()) };
  });

  // ======================================================================================================= Then: the screens

  Then('the navigation tree is shown', async ({ desktopScenario, desktopSettings }: SasStepFixtures) => {
    await expect(desktopScenario.requireSmc().mainWindow.getByRole('Tree')).toExist(within(desktopSettings)); // empty to UI Automation = the Java Access Bridge is not enabled
  });

  Then('the tab {string} is shown', async ({ desktopScenario, vars, desktopSettings }: SasStepFixtures, name: string) => {
    await expect(desktopScenario.requireSmc().mainWindow.getByRole('TabItem', { name: vars.interpolate(name) })).toExist(within(desktopSettings));
  });

  Then('the window title matches the pattern {string}', async ({ desktopScenario, vars, desktopSettings }: SasStepFixtures, pattern: string) => {
    await expect(desktopScenario.currentWindow()).toHaveTitle(new RegExp(vars.interpolate(pattern)), within(desktopSettings));
  });

  Then('a window whose title contains {string} is open', async ({ desktopScenario, vars, desktopSettings }: SasStepFixtures, text: string) => {
    await expect(desktopScenario.activeApp().window(new RegExp(escapeRegExp(vars.interpolate(text))))).toExist(within(desktopSettings));
  });

  Then('Enterprise Guide shows that it is connected', async ({ desktopScenario, desktopSettings }: SasStepFixtures) => {
    await expect(desktopScenario.requireEgUi().mainWindow.getByName(/^Connected to/)).toExist(within(desktopSettings));
  });

  // What was asked for is looked for the way a person would: the controls are named, and a miss says what IS on the screen.
  Then('looking for the control named {string} fails and says what is on the screen', async ({ desktopScenario, vars }: SasStepFixtures, name: string) => {
    const failure = await expect(desktopScenario.currentWindow().getByName(vars.interpolate(name))).toExist({ timeout: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure, 'the missing control must fail the assertion').toBeDefined();
    expect(failure?.message).toContain('On the screen now'); // + the controls, and "Closest to ..." for a near-miss such as "Add Users"
  });

  Then('the User Manager lists the user {string} spelled exactly like that', async ({ desktopScenario, vars }: SasStepFixtures, user: string) => {
    const smc = desktopScenario.requireSmc();
    const name = vars.interpolate(user);
    expect(await smc.findUser(name)).toBe(name);
    expect(await smc.listUsers()).toContain(name);
  });

  Then('the User Manager lists the group {string} spelled exactly like that', async ({ desktopScenario, vars }: SasStepFixtures, group: string) => {
    expect(await desktopScenario.requireSmc().listGroups()).toContain(vars.interpolate(group));
  });

  Then('the User Manager lists at least one user', async ({ desktopScenario }: SasStepFixtures) => {
    expect((await desktopScenario.requireSmc().listUsers()).length, 'the User Manager lists at least one user').toBeGreaterThan(0);
  });

  // ======================================================================================================= Then: Enterprise Guide

  Then('the object model answers with a version', async ({ desktopScenario }: SasStepFixtures) => {
    expect(await desktopScenario.requireEgCom().version()).not.toBe('');
  });

  Then('the project holds exactly these items:', async ({ desktopScenario, vars }: SasStepFixtures, table: TableLike) => {
    const items = (await desktopScenario.requireEgCom().listItems()).map((item) => `${item.kind}:${item.name}`);
    expect(items).toEqual(rowsOf(table).map(([kind, name]) => `${vars.interpolate(kind ?? '')}:${vars.interpolate(name ?? '')}`));
  });

  Then('the project holds at least one process flow or program', async ({ desktopScenario }: SasStepFixtures) => {
    expect((await desktopScenario.requireEgCom().listItems()).length, 'the project has at least one process flow or program').toBeGreaterThan(0);
  });

  Then('the run reported at least one program', async ({ desktopScenario }: SasStepFixtures) => {
    expect(desktopScenario.statuses.size).toBeGreaterThan(0);
  });

  Then('the program {string} ended with the status {string}, {int} errors and {int} warnings', async ({ desktopScenario, vars }: SasStepFixtures, program: string, status: string, errors: number, warnings: number) => {
    expect(await resultOf(desktopScenario, vars.interpolate(program))).toMatchObject({ status: vars.interpolate(status), errors, warnings });
  });

  Then('the log of the program {string} contains the exact text {string}', async ({ desktopScenario, vars }: SasStepFixtures, program: string, text: string) => {
    const name = vars.interpolate(program);
    const log = desktopScenario.route === 'com' ? await desktopScenario.requireEgCom().programLog(name) : (desktopScenario.runs.get(name)?.log ?? (await desktopScenario.requireEgUi().readLog()));
    expect(log).toContain(vars.interpolate(text));
  });

  Then('the log shown on the screen is the log of the program {string}', async ({ desktopScenario, vars }: SasStepFixtures, program: string) => {
    const name = vars.interpolate(program);
    const run = desktopScenario.runs.get(name);
    if (!run) throw new AdapterError('sas-steps', 'log', `no run is known for the program "${name}": run it first with \`I run the program "${name}"\``);
    expect(await desktopScenario.requireEgUi().readLog()).toBe(run.log);
  });

  Then('these files were written:', async ({ world, vars }: SasStepFixtures, table: TableLike) => {
    expect(world.written).toEqual(rowsOf(table).map(([file]) => vars.interpolate(file ?? '')));
  });

  Then('the stand-in desktop holds the written files', async ({ world, fakeDesktop }: SasStepFixtures) => {
    expect([...(fakeDesktop?.eg.com.files.keys() ?? [])]).toEqual(expect.arrayContaining(world.written));
  });

  Then('nothing was run in Enterprise Guide for the project {string}', async ({ vars, fakeDesktop }: SasStepFixtures, project: string) => {
    expect(fakeDesktop?.eg.ran).not.toContain(`project:${vars.interpolate(project)}`);
  });

  // ======================================================================================================= Then: the safety policy

  Then('the safety policy refuses it', async ({ world }: SasStepFixtures) => {
    refusalOf(world);
  });

  Then('the safety policy refuses it with the rule {string}', async ({ world }: SasStepFixtures, rule: string) => {
    expect(refusalOf(world).rule).toBe(rule);
  });

  Then('the refusal explains how to proceed', async ({ world }: SasStepFixtures) => {
    expect(refusalOf(world).message).toContain('How to proceed');
  });

  // The audit log says who (run id), what, where, and how it ended; a refusal changes nothing in SAS but is always recorded.
  Then('the audit log records one denial of {string} on {string} with the reason {string}', async ({ safetyPolicy, runContext, vars }: SasStepFixtures, operation: string, target: string, reason: string) => {
    const wanted = vars.interpolate(target);
    const denied = readAudit(safetyPolicy.audit.file, { outcome: 'denied', runId: runContext.runId }).filter((r) => r.operation === operation && r.target === wanted);
    expect(denied.map((r) => r.reason)).toEqual([reason]);
  });

  Then('the audit log records a denied {string} in the environment {string}', async ({ safetyPolicy, runContext }: SasStepFixtures, operation: string, environment: string) => {
    expect(readAudit(safetyPolicy.audit.file, { runId: runContext.runId, outcome: 'denied', environment }).some((r) => r.operation === operation)).toBe(true);
  });

  // ======================================================================================================= Then: housekeeping

  // The programs a scenario started are closed at its end; closing is housekeeping, not a change, so it works in production too.
  Then('SAS Management Console, started by the scenario before, is no longer running', async ({ fakeDesktop }: SasStepFixtures) => {
    expect(fakeDesktop?.desktop.processes.some((p) => p.name === 'sasmc' && p.alive) ?? false).toBe(false);
  });
}
