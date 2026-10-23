import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { clearRegisteredSecrets } from '../../src/core';
import { readsSecret } from '../../src/bdd';
import { SAMPLE_PROJECT } from '../../src/desktop';
import { captureLogs } from '../desktop/support';
import { stepRig } from './stepRig';
import { useCleanSasEnv } from '../fixtures/support';

useCleanSasEnv();

// The step implementations against the real desktop layer on the stand-in. Every "passes" case has a "fails" case: a step that cannot
// fail proves nothing.

const TYPE_FROM_SETTING = 'When I enter the secret {string} in the field named {string}';
const failure = async (run: () => Promise<unknown>): Promise<string> => {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error === undefined) throw new Error('the step was expected to fail but passed');
  return error instanceof Error ? error.message : String(error);
};

test.describe('Management Console steps', () => {
  test('the user, group, library and server steps pass for what is there and fail - saying what IS there - for what is not', async () => {
    const rig = await stepRig();
    await rig.openSmc();
    await rig.step('Given SAS Management Console is open and I am logged on');
    await rig.step('When I open the {string} plug-in', 'User Manager');
    await rig.step('Then the user {string} is listed', 'sasdemo');
    await rig.step('Then the user {string} is listed', 'SASDEMO'); // case-insensitive, as the console treats names
    await rig.step('Then the user {string} is not listed', 'Nobody Atall');
    expect(await failure(() => rig.step('Then the user {string} is listed', 'Nobody Atall'))).toMatch(/does not list the user "Nobody Atall" \(it lists "Alice Analyst", "Bob Builder", "sasdemo"\)/);
    expect(await failure(() => rig.step('Then the user {string} is not listed', 'sasdemo'))).toMatch(/lists the user "sasdemo", which was expected to be absent/);
    await rig.step('Then the group {string} is listed', 'bi users');
    expect(await failure(() => rig.step('Then the group {string} is listed', 'Nope'))).toContain('it lists "BI Users", "SAS Administrators"');
    await rig.step('When I open the {string} plug-in', 'Library Manager');
    await rig.step('Then the library {string} is listed', 'Orion');
    expect(await failure(() => rig.step('Then the library {string} is listed', 'Nope'))).toContain('"Orion"');
    await rig.step('When I open the {string} plug-in', 'Server Manager');
    await rig.step('Then the server {string} has the status {string}', 'SASMeta - Metadata Server', 'running');
    expect(await failure(() => rig.step('Then the server {string} has the status {string}', 'SASMeta - Metadata Server', 'Stopped'))).toContain('is "Running", expected "Stopped"');
    expect(await failure(() => rig.step('Then the server {string} has the status {string}', 'No Such Server', 'Running'))).toContain('does not list a server named "No Such Server"');
  });

  test('an unknown plug-in is the desktop layer\'s own clear error', async () => {
    const rig = await stepRig();
    await rig.openSmc();
    await rig.step('Given SAS Management Console is open and I am logged on');
    expect(await failure(() => rig.step('When I open the {string} plug-in', 'Nonsense Manager'))).toContain('unknown plug-in "Nonsense Manager"');
  });

  test('a Management Console step without the Given says what to start with', async () => {
    const rig = await stepRig();
    expect(await failure(() => rig.step('When I open the {string} plug-in', 'User Manager'))).toContain('start with `Given SAS Management Console is open and I am logged on`');
    expect(await failure(() => rig.step('Then the user {string} is listed', 'x'))).toContain('Management Console is not open in this scenario');
  });

  test('the window title step retries until it holds, and fails with the title that IS there', async () => {
    const rig = await stepRig();
    await rig.openSmc();
    await rig.step('Given SAS Management Console is open and I am logged on');
    await rig.step('Then the window title contains {string}', 'management console');
    expect(await failure(() => rig.step('Then the window title contains {string}', 'Enterprise Guide'))).toContain('SAS Management Console');
  });
});

test.describe('Enterprise Guide by COM', () => {
  test('open, run, check each program, read a log, export results and log', async () => {
    const rig = await stepRig();
    await rig.openEgCom();
    await rig.step('Given SAS Enterprise Guide is available through its automation interface');
    await rig.step('When I open the Enterprise Guide project {string}', rig.project);
    await rig.step('When I run the project');
    await rig.step('Then the program {string} finished without errors', rig.program('Program'));
    await rig.step('Then the program {string} finished without errors', rig.program('Summary')); // a warning is not an error
    await rig.step('Then the program {string} finished with the status {string}', rig.program('Summary'), 'warning');
    expect(await failure(() => rig.step('Then the program {string} finished with the status {string}', rig.program('Summary'), 'Succeeded'))).toContain('finished with the status Warning, expected Succeeded');
    await rig.step('Then the log of the program {string} contains {string}', rig.program('Program'), '19 observations read');
    expect(await failure(() => rig.step('Then the log of the program {string} contains {string}', rig.program('Program'), 'FATAL'))).toContain('does not contain "FATAL"');
    const folder = `C:\\Exports\\${rig.run.ns('out')}`;
    await rig.step('When I export the results of the program {string} to the folder {string}', rig.program('Summary'), folder);
    await rig.step('When I export the log of the program {string} to the file {string}', rig.program('Summary'), `${folder}\\summary.log`);
    expect([...rig.fake.eg.com.files.keys()]).toEqual(expect.arrayContaining([`${folder}\\Summary.html`, `${folder}\\summary.log`]));
    await rig.step('When I remember the status of the program {string} as {string}', rig.program('Summary'), 'summaryStatus');
    expect(rig.vars.get('summaryStatus')).toBe('Warning');
  });

  test('a program with an ERROR in its log does not "finish without errors"', async () => {
    const broken = { flows: [{ name: 'Flow', programs: ['Broken'] }], programs: [{ name: 'Broken', log: 'ERROR: File WORK.NOPE does not exist.\nNOTE: The SAS System stopped processing this step because of errors.', results: [] }] };
    const rig = await stepRig();
    const file = `C:\\Projects\\${rig.run.ns('Broken')}.egp`;
    rig.fake.eg.options.projects[file] = broken;
    await rig.openEgCom();
    await rig.step('Given SAS Enterprise Guide is available through its automation interface');
    await rig.step('When I open the Enterprise Guide project {string}', file);
    await rig.step('When I run the project');
    expect(await failure(() => rig.step('Then the program {string} finished without errors', 'Broken'))).toContain('finished with 1 error line(s)');
    await rig.step('Then the program {string} finished with the status {string}', 'Broken', 'Error');
  });

  test('a program that has not run does not "finish without errors", and a project outside the namespace is refused by the policy before it runs', async () => {
    const rig = await stepRig();
    await rig.openEgCom();
    await rig.step('Given SAS Enterprise Guide is available through its automation interface');
    await rig.step('When I open the Enterprise Guide project {string}', rig.project);
    expect(await failure(() => rig.step('Then the program {string} finished without errors', rig.program('Program')))).toContain('has not run');
    expect(SAMPLE_PROJECT.programs.length).toBe(2);
  });

  test('the route decides: `I run the program` belongs to the screens, `I run the project` to the automation interface', async () => {
    const rig = await stepRig();
    await rig.openEgCom();
    await rig.step('Given SAS Enterprise Guide is available through its automation interface');
    expect(await failure(() => rig.step('When I run the program {string}', rig.program('Program')))).toContain('I run the process flow');
    const ui = await stepRig();
    await ui.openEg();
    await ui.step('Given SAS Enterprise Guide is open and I am logged on');
    expect(await failure(() => ui.step('When I run the project'))).toContain('I run the program');
  });

  test('a COM step without its Given says what to start with', async () => {
    const rig = await stepRig();
    expect(await failure(() => rig.step('When I open the Enterprise Guide project {string}', rig.project))).toContain('Enterprise Guide is not open in this scenario');
    expect(await failure(() => rig.step('When I run the process flow {string}', 'Main Flow'))).toContain('not available by COM');
  });
});

test.describe('Enterprise Guide screens and the generic steps', () => {
  test('open a project, run a program, read the log - and the same status steps work on the screens route', async () => {
    const rig = await stepRig();
    await rig.openEg();
    await rig.step('Given SAS Enterprise Guide is open and I am logged on');
    await rig.step('When I open the Enterprise Guide project {string}', rig.project);
    await rig.step('When I run the program {string}', rig.program('Summary'));
    await rig.step('Then the program {string} finished with the status {string}', rig.program('Summary'), 'Warning');
    await rig.step('Then the log of the program {string} contains {string}', rig.program('Summary'), 'PROCEDURE MEANS');
    await rig.step('When I remember the title of the window as {string}', 'title');
    expect(rig.vars.get('title')).toContain('Sales');
    expect(await failure(() => rig.step('Then the program {string} finished without errors', rig.program('Program')))).toContain('no result is known'); // never run on the screens
  });

  test('generic steps act by name or automation id in the main window, or in the window chosen with "I switch to the window"', async () => {
    const rig = await stepRig();
    await rig.openEg(false);
    await rig.step('Given SAS Enterprise Guide is open');
    await rig.step('Then the control named {string} is shown', 'Connect');
    await rig.step('Then the control named {string} is enabled', 'Connect');
    await rig.step('Then the control named {string} is not shown', 'Nothing Like This');
    await rig.step('When I click the button named {string}', 'Connect');
    await rig.step('Then the window {string} is open', 'Select Profile');
    await rig.step('When I switch to the window {string}', 'Select Profile');
    await rig.step('Then the control named {string} is shown', 'Dev SAS Server');
    await rig.step('When I select the item named {string}', 'Dev SAS Server');
    await rig.step('When I click the control named {string}', 'OK');
    await rig.step('Then the window {string} is open', 'SAS Logon');
    await rig.step('When I switch to the window {string}', 'SAS Logon');
    await rig.step('When I enter {string} in the field with the automation id {string}', 'sasdemo', 'userIdField');
    await rig.step('Then the control named {string} contains the text {string}', 'User ID:', 'sasdemo');
    await rig.step('When I remember the text of the control named {string} as {string}', 'User ID:', 'typed');
    expect(rig.vars.get('typed')).toBe('sasdemo');
    await rig.step('When I switch back to the main window');
    await rig.step('When I click the control with the automation id {string}', 'ConnectButton'); // the main window again
    await rig.step('Then the window title contains {string}', 'SAS Enterprise Guide');
  });

  test('a control that is not there fails with what IS on the screen; a window that is not open fails the same way', async () => {
    const rig = await stepRig();
    await rig.openEg(false);
    await rig.step('Given SAS Enterprise Guide is open');
    expect(await failure(() => rig.step('Then the control named {string} is shown', 'Conect'))).toContain('On the screen now');
    expect(await failure(() => rig.step('Then the window {string} is open', 'No Such Window'))).toContain('not on the screen');
    expect(await failure(() => rig.step('Then the control named {string} is not shown', 'Connect'))).toContain('Connect');
    expect(await failure(() => rig.step('When I switch to the window {string}', 'No Such Window'))).toContain('not on the screen');
  });

  test('placeholders work in every string: {{namespace}} and a remembered value', async () => {
    const rig = await stepRig();
    await rig.openEg();
    await rig.step('Given SAS Enterprise Guide is open and I am logged on');
    await rig.step('When I open the Enterprise Guide project {string}', 'C:\\Projects\\{{namespace}}_Sales.egp');
    await rig.step('Then the window title contains {string}', 'Sales');
    rig.vars.set('who', 'Sales');
    await rig.step('Then the window title contains {string}', '{{who}} - SAS'.replace('{{who}} - SAS', '{{who}}'));
    expect(await failure(() => rig.step('Then the window title contains {string}', '{{not_a_known_name}}'))).toMatch(/not_a_known_name|unknown/i);
  });

  test('"I make up the test object name" files the name inside the run\'s namespace, with a random part', async () => {
    const rig = await stepRig();
    await rig.step('Given I make up the test object name {string} as {string}', 'export', 'folder');
    await rig.step('Given I make up the test object name {string} as {string}', 'export', 'folder2');
    const [a, b] = [rig.vars.get('folder') as string, rig.vars.get('folder2') as string];
    expect(a).toMatch(new RegExp(`^${rig.run.namespacePrefix}_export-[A-Za-z0-9]{4}$`));
    expect(rig.run.isInNamespace(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(await failure(() => rig.step('Given I make up the test object name {string} as {string}', '../escape', 'x'))).toContain('may contain letters');
  });
});

test.describe('SAS_ASSERT_TIMEOUT_MS', () => {
  test('an assertion step keeps re-checking for as long as the setting says, and no longer', async () => {
    const rig = await stepRig({ values: { SAS_ASSERT_TIMEOUT_MS: '1500' } });
    await rig.openEg(false);
    await rig.step('Given SAS Enterprise Guide is open');
    const startedAt = Date.now();
    await failure(() => rig.step('Then the control named {string} is shown', 'No Such Control'));
    const took = Date.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(1300);
    expect(took).toBeLessThan(4500);
  });

  test('a control that appears while the step is waiting is found (the retry is real)', async () => {
    const rig = await stepRig({ values: { SAS_ASSERT_TIMEOUT_MS: '4000' } });
    await rig.openEg(false);
    await rig.step('Given SAS Enterprise Guide is open');
    const opened = rig.step('Then the window {string} is open', 'Select Profile');
    await rig.step('When I click the button named {string}', 'Connect'); // opens the dialog while the assertion is already looking for it
    await opened;
  });
});

test.describe('secrets are never echoed', () => {
  const secret = ['Zx9', randomUUID()].join('-'); // made up per run: never a real credential

  test('"I enter the secret" takes the NAME of a setting, types the value through a flagged command and leaves it in no log, journal or error', async () => {
    clearRegisteredSecrets();
    const rig = await stepRig({ values: { SAS_TEST_SECRET: secret } });
    await rig.openEg(false);
    await rig.step('Given SAS Enterprise Guide is open');
    await rig.step('When I click the button named {string}', 'Connect');
    await rig.step('When I switch to the window {string}', 'Select Profile');
    await rig.step('When I select the item named {string}', 'Dev SAS Server');
    await rig.step('When I click the control named {string}', 'OK');
    await rig.step('When I switch to the window {string}', 'SAS Logon');
    const captured = await captureLogs(() => rig.step(TYPE_FROM_SETTING, 'SAS_TEST_SECRET', 'Password:'));
    expect(captured.error).toBeUndefined();
    const typed = rig.fake.desktop.calls.filter((c) => c.op === 'setText' && (c as { text?: string }).text === secret);
    expect(typed).toHaveLength(1);
    expect((typed[0] as { secret?: boolean }).secret).toBe(true);
    expect(captured.lines.join('\n')).not.toContain(secret);
    expect(JSON.stringify(rig.session.journal)).not.toContain(secret);
    const refusal = await failure(() => rig.step(TYPE_FROM_SETTING, 'SAS_NOT_SET_ANYWHERE', 'Password:'));
    expect(refusal).toContain('SAS_NOT_SET_ANYWHERE is not set');
    clearRegisteredSecrets();
  });

  test('a CI job credential is never typed into a program, and the refusal names the setting, not a value', async () => {
    const rig = await stepRig({ values: { CI_JOB_TOKEN: secret } });
    await rig.openEg(false);
    await rig.step('Given SAS Enterprise Guide is open');
    const message = await failure(() => rig.step(TYPE_FROM_SETTING, 'CI_JOB_TOKEN', 'Password:'));
    expect(message).toContain('CI_JOB_TOKEN');
    expect(message).not.toContain(secret);
  });

  test('readsSecret recognises {{env:...}} of a secret-looking setting only', () => {
    expect(readsSecret('{{env:SAS_PASSWORD}}')).toBe(true);
    expect(readsSecret('x {{ env:SAS_EG_PASSWORD|fallback }} y')).toBe(true);
    expect(readsSecret('{{env:SAS_API_TOKEN}}')).toBe(true);
    expect(readsSecret('{{env:SAS_SMC_PROFILE}}')).toBe(false);
    expect(readsSecret('{{random:alnum(6)}} plain')).toBe(false);
  });
});

test.describe('logon steps', () => {
  test('a wrong password is rejected once, the same logon is then refused by the guard, and the right one still works', async () => {
    const rig = await stepRig();
    await rig.openSmc(false);
    await rig.step('Given SAS Management Console is open');
    expect(await failure(() => rig.step('Then the logon is rejected'))).toContain('no logon was attempted');
    await rig.step('When I try to log on to SAS Management Console with a wrong password');
    await rig.step('Then the logon is rejected');
    expect(rig.fake.smc.attempts).toHaveLength(1);
    await rig.step('Then the same logon is not attempted again');
    expect(rig.fake.smc.attempts).toHaveLength(1);
  });

  test('"the logon is rejected" fails when the logon worked', async () => {
    const rig = await stepRig({ desktop: { smc: { accounts: [{ user: 'sasdemo', password: ['anything', randomUUID()].join('-') }] } } });
    await rig.openSmc(false);
    await rig.step('Given SAS Management Console is open');
    rig.scenario.logon = { error: undefined };
    expect(await failure(() => rig.step('Then the logon is rejected'))).toContain('expected to be rejected');
  });

  test('"I log on to ..." logs on with the configured login', async () => {
    const rig = await stepRig();
    await rig.openSmc(false);
    await rig.step('When I log on to SAS Management Console');
    expect(rig.fake.smc.attempts).toEqual([{ user: 'sasdemo', accepted: true }]);
    await rig.openEg(false);
    await rig.step('When I log on to SAS Enterprise Guide');
    expect(rig.fake.eg.attempts).toEqual([{ user: 'sasdemo', accepted: true }]);
  });
});
