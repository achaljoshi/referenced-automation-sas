import { AdapterError, isSensitiveKey, placeholders } from '@automation/referenced-automation-utils';
import type { BddSteps } from '@automation/referenced-automation-ui';
import { Credentials, LogonCooldownError, LogonRejectedError, registerSecret } from '../core';
import { desktopExpect as expect } from '../desktop';
import type { DesktopScenario } from '../fixtures/scenario';
import type { LogonHelper } from '../fixtures/logon';
import type { FixtureSettings } from '../fixtures/settings';
import type { DesktopApp, SasEnterpriseGuide, SasEnterpriseGuideUi, SasManagementConsole, SmcPlugin } from '../desktop';
import type { RunContext } from '../core';

/**
 * The business-readable step vocabulary for the SAS desktop programs. The step TEXTS are a public contract (features in other
 * repositories are written against them): `tests/bdd/vocabulary.spec.ts` fails when one changes.
 *
 * Library-agnostic: pass the Given / When / Then of your BDD tool (playwright-bdd's `createBdd(test)` gives them). The test the steps
 * run in must have the fixtures below - i.e. be built on `desktopTest` (src/fixtures); `features/steps/fixtures.ts` shows the setup.
 *
 *   Given SAS Management Console is open and I am logged on
 *   When I open the "User Manager" plug-in
 *   Then the user "sasdemo" is listed
 *
 *   Given SAS Enterprise Guide is available through its automation interface
 *   When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
 *   And I run the project
 *   Then the program "Program" finished without errors
 *
 * Order of preference, as everywhere in this repo: the COM route (`... available through its automation interface`) first, the
 * screens (`... is open and I am logged on`) only for tests about the screens. Every string understands `{{placeholders}}`
 * ({{random:alnum(6)}}, {{date:+7d}}, {{env:X}}, {{namespace}}, {{runId}}, a remembered {{name}}); a secret is typed with
 * `I enter the secret "SAS_PASSWORD" in the field named "Password:"` - the step gets the NAME of the setting and never echoes the value.
 * There is deliberately no "I wait N seconds": every step waits for what it needs.
 */

/** What the steps take from the test (the fixtures of `desktopTest`). */
export interface DesktopStepFixtures {
  smc: SasManagementConsole;
  smcLoggedOn: DesktopApp;
  eg: SasEnterpriseGuideUi;
  egLoggedOn: DesktopApp;
  egCom: SasEnterpriseGuide;
  desktopScenario: DesktopScenario;
  logon: LogonHelper;
  desktopSettings: FixtureSettings;
  runContext: RunContext;
  vars: placeholders.ScenarioVariables;
}

/** SAS_ASSERT_TIMEOUT_MS: how long an assertion step ("Then the window title contains ...") keeps re-checking before it fails (default 5 s). */
export const DEFAULT_ASSERT_TIMEOUT_MS = 5_000;
const within = (settings: FixtureSettings): { timeout: number } => ({ timeout: settings.env.getInt('SAS_ASSERT_TIMEOUT_MS', DEFAULT_ASSERT_TIMEOUT_MS) });

const interpolateAll = (vars: placeholders.ScenarioVariables, text: string): string => vars.interpolate(text);

/** True when a template reads a secret-looking setting (`{{env:SAS_PASSWORD}}`): the value is typed as a secret and never logged. */
export function readsSecret(template: string): boolean {
  return [...template.matchAll(/\{\{\s*env:([A-Za-z0-9_]+)/g)].some((match) => isSensitiveKey(match[1] as string));
}

function listing(items: readonly string[]): string {
  return items.length === 0 ? 'nothing' : items.map((i) => `"${i}"`).join(', ');
}

export function registerDesktopSteps({ Given, When, Then }: BddSteps): void {
  // ======================================================================================================= Given: open a program

  Given('SAS Management Console is open', async ({ smc, desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.smc = smc;
    desktopScenario.active = 'smc';
  });

  Given('SAS Management Console is open and I am logged on', async ({ smc, smcLoggedOn, desktopScenario }: DesktopStepFixtures) => {
    void smcLoggedOn; // asking for it is what logs the console on (through the logon guard) before the scenario starts
    desktopScenario.smc = smc;
    desktopScenario.active = 'smc';
  });

  Given('SAS Enterprise Guide is open', async ({ eg, desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.eg = eg;
    desktopScenario.active = 'eg';
    desktopScenario.route = 'ui';
  });

  Given('SAS Enterprise Guide is open and I am logged on', async ({ eg, egLoggedOn, desktopScenario }: DesktopStepFixtures) => {
    void egLoggedOn;
    desktopScenario.eg = eg;
    desktopScenario.active = 'eg';
    desktopScenario.route = 'ui';
  });

  Given('SAS Enterprise Guide is available through its automation interface', async ({ egCom, desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.com = egCom;
    desktopScenario.route = 'com';
  });

  Given('I make up the test object name {string} as {string}', async ({ runContext, vars }: DesktopStepFixtures, name: string, as: string) => {
    // inside the run's namespace (AUTO_<runId>_<name>-<random>): the only place a test may create or change anything
    vars.set(as, runContext.ns(`${interpolateAll(vars, name)}-${placeholders.randomValue('alnum(4)')}`));
  });

  // ======================================================================================================= When: logon

  When('I log on to SAS Management Console', async ({ smc, logon, desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.smc = smc;
    desktopScenario.active = 'smc';
    await logon.smc(smc);
  });

  When('I log on to SAS Enterprise Guide', async ({ eg, logon, desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.eg = eg;
    desktopScenario.active = 'eg';
    desktopScenario.route = 'ui';
    await logon.eg(eg);
  });

  // The wrong password is made up here and typed ONCE: the logon guard writes its marker and refuses the same logon afterwards.
  When('I try to log on to SAS Management Console with a wrong password', async ({ smc, logon, desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.smc = smc;
    desktopScenario.active = 'smc';
    const real = logon.credentialsFor('smc');
    const wrong = new Credentials({ application: 'smc', user: real.user, password: `wrong-${placeholders.randomValue('alnum(14)')}`, source: 'a made-up wrong password' });
    desktopScenario.wrongCredentials = wrong;
    desktopScenario.logon = {
      error: await logon.smc(smc, wrong).then(
        () => undefined,
        (error: unknown) => error ?? new Error('the logon failed'),
      ),
    };
  });

  // ======================================================================================================= When: Management Console

  When('I open the {string} plug-in', async ({ desktopScenario, vars }: DesktopStepFixtures, plugin: string) => {
    await desktopScenario.requireSmc().openPlugin(interpolateAll(vars, plugin) as SmcPlugin);
  });

  // ======================================================================================================= When: Enterprise Guide

  When('I open the Enterprise Guide project {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, project: string) => {
    const file = interpolateAll(vars, project);
    if (desktopScenario.route === 'com') await desktopScenario.requireEgCom().openProject(file);
    else await desktopScenario.requireEgUi().openProject(file);
  });

  When('I run the project', async ({ desktopScenario }: DesktopStepFixtures) => {
    if (desktopScenario.route !== 'com') throw new AdapterError('sas-steps', 'run', 'the screens run one program at a time: use `I run the program "<name>"`. `I run the project` belongs to the automation interface (`Given SAS Enterprise Guide is available through its automation interface`).');
    for (const status of await desktopScenario.requireEgCom().runProject()) desktopScenario.statuses.set(status.name, status);
  });

  When('I run the program {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string) => {
    const name = interpolateAll(vars, program);
    if (desktopScenario.route === 'com')
      throw new AdapterError('sas-steps', 'run', 'the automation interface runs a whole project (`I run the project`) or one process flow (`I run the process flow "<name>"`); `I run the program` belongs to the screens (`Given SAS Enterprise Guide is open and I am logged on`).');
    desktopScenario.runs.set(name, await desktopScenario.requireEgUi().runProgram(name));
  });

  When('I run the process flow {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, flow: string) => {
    const eg = desktopScenario.requireEgCom();
    await eg.runProcessFlow(interpolateAll(vars, flow));
    for (const status of await eg.programStatuses()) desktopScenario.statuses.set(status.name, status);
  });

  When('I export the results of the program {string} to the folder {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string, folder: string) => {
    await desktopScenario.requireEgCom().exportResults({ program: interpolateAll(vars, program), folder: interpolateAll(vars, folder) });
  });

  When('I export the log of the program {string} to the file {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string, file: string) => {
    await desktopScenario.requireEgCom().exportLog(interpolateAll(vars, program), interpolateAll(vars, file));
  });

  // ======================================================================================================= When: any window

  When('I switch to the window {string}', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, title: string) => {
    const wanted = interpolateAll(vars, title);
    await expect(desktopScenario.activeApp().window(wanted)).toExist(within(desktopSettings));
    desktopScenario.windowTitle = wanted;
  });

  When('I switch back to the main window', async ({ desktopScenario }: DesktopStepFixtures) => {
    desktopScenario.windowTitle = undefined;
  });

  When('I click the button named {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, name: string) => {
    await desktopScenario.currentWindow().getByRole('Button', { name: interpolateAll(vars, name), exact: true }).click();
  });

  When('I click the control named {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, name: string) => {
    await desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true }).click();
  });

  When('I click the control with the automation id {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, id: string) => {
    await desktopScenario.currentWindow().getByAutomationId(interpolateAll(vars, id)).click();
  });

  When('I enter {string} in the field named {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, value: string, name: string) => {
    await desktopScenario.currentWindow().getByRole('Edit', { name: interpolateAll(vars, name), exact: true }).fill(interpolateAll(vars, value), { secret: readsSecret(value) });
  });

  When('I enter {string} in the field with the automation id {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, value: string, id: string) => {
    await desktopScenario.currentWindow().getByAutomationId(interpolateAll(vars, id)).fill(interpolateAll(vars, value), { secret: readsSecret(value) });
  });

  // The step is given the NAME of a setting (SAS_PASSWORD), never a value; the value is registered with the masker and typed through a
  // flagged command, so it appears in no log, journal, error, step title or report.
  When('I enter the secret {string} in the field named {string}', async ({ desktopScenario, desktopSettings, vars }: DesktopStepFixtures, setting: string, name: string) => {
    const key = interpolateAll(vars, setting);
    if (placeholders.isForbiddenEnvName(key)) throw new AdapterError('sas-steps', 'secret', `"${key}" is a CI job credential: it is never typed into a program`);
    const value = desktopSettings.env.getOptional(key);
    if (value === undefined || value === '') throw new AdapterError('sas-steps', 'secret', `the setting ${key} is not set: put it in .env.<ENV>.local or a masked CI variable (the step needs the name of the setting, not the value)`);
    registerSecret(value);
    await desktopScenario.currentWindow().getByRole('Edit', { name: interpolateAll(vars, name), exact: true }).fill(value, { secret: true });
  });

  When('I select the item named {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, name: string) => {
    await desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true }).select();
  });

  When('I expand the item named {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, name: string) => {
    await desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true }).expand();
  });

  When('I press the keys {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, keys: string) => {
    await desktopScenario.currentWindow().press(interpolateAll(vars, keys));
  });

  // ======================================================================================================= When: remember

  When('I remember the text of the control named {string} as {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, name: string, as: string) => {
    vars.set(as, await desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true }).text());
  });

  When('I remember the title of the window as {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, as: string) => {
    vars.set(as, await desktopScenario.currentWindow().title());
  });

  When('I remember the status of the program {string} as {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string, as: string) => {
    const name = interpolateAll(vars, program);
    const status = desktopScenario.statuses.get(name) ?? (desktopScenario.route === 'com' ? await desktopScenario.requireEgCom().programStatus(name) : undefined);
    if (!status) throw new AdapterError('sas-steps', 'remember', `no status is known for the program "${name}": run it first`);
    vars.set(as, status.status);
  });

  // ======================================================================================================= Then: Management Console

  Then('the user {string} is listed', async ({ desktopScenario, vars }: DesktopStepFixtures, user: string) => {
    const name = interpolateAll(vars, user);
    const smc = desktopScenario.requireSmc();
    if ((await smc.findUser(name)) === undefined) throw new AdapterError('sas-steps', 'user', `the User Manager does not list the user "${name}" (it lists ${listing(await smc.listUsers())})`);
  });

  Then('the user {string} is not listed', async ({ desktopScenario, vars }: DesktopStepFixtures, user: string) => {
    const name = interpolateAll(vars, user);
    const found = await desktopScenario.requireSmc().findUser(name);
    if (found !== undefined) throw new AdapterError('sas-steps', 'user', `the User Manager lists the user "${found}", which was expected to be absent`);
  });

  Then('the group {string} is listed', async ({ desktopScenario, vars }: DesktopStepFixtures, group: string) => {
    const name = interpolateAll(vars, group);
    const groups = await desktopScenario.requireSmc().listGroups();
    if (!groups.some((g) => g.toLowerCase() === name.toLowerCase())) throw new AdapterError('sas-steps', 'group', `the User Manager does not list the group "${name}" (it lists ${listing(groups)})`);
  });

  Then('the library {string} is listed', async ({ desktopScenario, vars }: DesktopStepFixtures, library: string) => {
    const name = interpolateAll(vars, library);
    const libraries = await desktopScenario.requireSmc().listLibraries();
    if (!libraries.some((l) => l.toLowerCase() === name.toLowerCase())) throw new AdapterError('sas-steps', 'library', `the Data Library Manager does not list "${name}" (it lists ${listing(libraries)})`);
  });

  Then('the server {string} has the status {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, server: string, status: string) => {
    const name = interpolateAll(vars, server);
    const servers = await desktopScenario.requireSmc().serverStatus();
    const found = servers.find((s) => s.name === name);
    if (!found) throw new AdapterError('sas-steps', 'server', `the Server Manager does not list a server named "${name}" (it lists ${listing(servers.map((s) => s.name))})`);
    if (found.status.toLowerCase() !== interpolateAll(vars, status).toLowerCase()) throw new AdapterError('sas-steps', 'server', `the server "${name}" is "${found.status}", expected "${interpolateAll(vars, status)}"`);
  });

  // ======================================================================================================= Then: logon safety

  Then('the logon is rejected', async ({ desktopScenario }: DesktopStepFixtures) => {
    const outcome = desktopScenario.logon;
    if (!outcome) throw new AdapterError('sas-steps', 'logon', 'no logon was attempted in this scenario: use `I try to log on to SAS Management Console with a wrong password` first');
    if (!(outcome.error instanceof LogonRejectedError)) throw new AdapterError('sas-steps', 'logon', `the logon was expected to be rejected but ended with: ${outcome.error instanceof Error ? outcome.error.message.split('\n')[0] : 'no error'}`);
  });

  Then('the same logon is not attempted again', async ({ desktopScenario, logon, smc }: DesktopStepFixtures) => {
    const wrong = desktopScenario.wrongCredentials;
    if (!wrong) throw new AdapterError('sas-steps', 'logon', 'no rejected logon in this scenario');
    const again = await logon.smc(smc, wrong).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(again instanceof LogonCooldownError)) throw new AdapterError('sas-steps', 'logon', `a second attempt with the rejected credentials was expected to be refused by the logon guard, but: ${again instanceof Error ? again.message.split('\n')[0] : 'it was attempted'}`);
  });

  // ======================================================================================================= Then: Enterprise Guide

  const statusOf = async (scenario: DesktopScenario, program: string): Promise<{ status: string; errors: number; warnings: number }> => {
    const known = scenario.statuses.get(program);
    if (known) return known;
    const run = scenario.runs.get(program);
    if (run) return { status: run.errors > 0 ? 'Error' : run.warnings > 0 ? 'Warning' : 'Succeeded', errors: run.errors, warnings: run.warnings };
    if (scenario.route === 'com') return scenario.requireEgCom().programStatus(program);
    throw new AdapterError('sas-steps', 'program', `no result is known for the program "${program}": run it first (\`I run the project\` / \`I run the program "${program}"\`)`);
  };

  Then('the program {string} finished without errors', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string) => {
    const name = interpolateAll(vars, program);
    const result = await statusOf(desktopScenario, name);
    if (result.status === 'NotRun' || result.status === 'Unknown') throw new AdapterError('sas-steps', 'program', `the program "${name}" has not run (status ${result.status})`);
    if (result.errors > 0 || result.status === 'Error') throw new AdapterError('sas-steps', 'program', `the program "${name}" finished with ${result.errors} error line(s) (status ${result.status})`);
  });

  Then('the program {string} finished with the status {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string, status: string) => {
    const name = interpolateAll(vars, program);
    const result = await statusOf(desktopScenario, name);
    if (result.status.toLowerCase() !== interpolateAll(vars, status).toLowerCase()) throw new AdapterError('sas-steps', 'program', `the program "${name}" finished with the status ${result.status}, expected ${interpolateAll(vars, status)}`);
  });

  Then('the log of the program {string} contains {string}', async ({ desktopScenario, vars }: DesktopStepFixtures, program: string, text: string) => {
    const name = interpolateAll(vars, program);
    const wanted = interpolateAll(vars, text);
    const log = desktopScenario.route === 'com' ? await desktopScenario.requireEgCom().programLog(name) : (desktopScenario.runs.get(name)?.log ?? (await desktopScenario.requireEgUi().readLog()));
    if (!log.toLowerCase().includes(wanted.toLowerCase())) throw new AdapterError('sas-steps', 'log', `the log of "${name}" does not contain "${wanted}"`);
  });

  // ======================================================================================================= Then: any window

  Then('the window title contains {string}', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, text: string) => {
    await expect(desktopScenario.currentWindow()).toHaveTitle(interpolateAll(vars, text), within(desktopSettings));
  });

  Then('the window {string} is open', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, title: string) => {
    await expect(desktopScenario.activeApp().window(interpolateAll(vars, title))).toExist(within(desktopSettings));
  });

  Then('the window {string} is not open', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, title: string) => {
    await expect(desktopScenario.activeApp().window(interpolateAll(vars, title))).not.toExist(within(desktopSettings));
  });

  Then('the control named {string} is shown', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, name: string) => {
    await expect(desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true })).toExist(within(desktopSettings));
  });

  Then('the control named {string} is not shown', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, name: string) => {
    await expect(desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true })).not.toExist(within(desktopSettings));
  });

  Then('the control named {string} is enabled', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, name: string) => {
    await expect(desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true })).toBeEnabled(within(desktopSettings));
  });

  Then('the control named {string} contains the text {string}', async ({ desktopScenario, vars, desktopSettings }: DesktopStepFixtures, name: string, text: string) => {
    await expect(desktopScenario.currentWindow().getByName(interpolateAll(vars, name), { exact: true })).toContainText(interpolateAll(vars, text), within(desktopSettings));
  });
}
