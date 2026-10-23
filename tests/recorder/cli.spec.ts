import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { runConvertCli, runImportCli, runRecordCli, startFakeDesktopForTests } from './support/cli';
import { builtCli } from './support/built';
import { repoRoot } from './support/examples';
import { tempDir } from '../core/support';
import { withEnv } from '../desktop/support';

const eg = path.join(repoRoot, 'examples', 'eg_run_project.sasrec.json');
const smc = path.join(repoRoot, 'examples', 'smc_create_user.sasrec.json');

const SCHEDULE = 'Set app = CreateObject("SASEGObjectModel.Application.7.1")\napp.SetActiveProfile("Dev SAS Server")\nSet prj = app.Open("C:\\Projects\\Sales.egp", "")\nprj.Run\napp.Quit\n';

test.describe('sas-desktop-to-playwright', () => {
  test('--help prints the usage; no arguments, an unknown option, a missing file and a bad value are usage errors (exit 2) that say so', () => {
    const help = runConvertCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('sas-desktop-to-playwright - turn a recording of SAS Management Console / SAS Enterprise Guide into a Playwright test');
    for (const flag of ['--out', '--test-import', '--desktop-import', '--tag', '--name', '--inline', '--page-objects', '--data', '--expect-text', '--expect-window', '--fixture', '--allow-no-assertion', '--strict']) expect(help.out, flag).toContain(flag);
    expect(help.out).toContain('node dist/recorder/cli/record.js');
    expect(help.out).toContain('npx sas-desktop-record');
    expect(runConvertCli([])).toMatchObject({ code: 2, err: expect.stringContaining('missing the recording') });
    expect(runConvertCli([eg, '--nope'])).toMatchObject({ code: 2, err: expect.stringContaining('unknown option --nope') });
    expect(runConvertCli(['no/such/file.sasrec.json'])).toMatchObject({ code: 2, err: expect.stringContaining('does not exist') });
    expect(runConvertCli([eg, '--fixture', 'maybe'])).toMatchObject({ code: 2, err: expect.stringContaining('--fixture must be auto, app or loggedOn') });
    expect(runConvertCli([eg, '--expect-window', '('])).toMatchObject({ code: 2, err: expect.stringContaining('--expect-window must be a regular expression') });
    expect(runConvertCli([eg, '--out'])).toMatchObject({ code: 2, err: expect.stringContaining('--out needs a value') });
    expect(runConvertCli([eg, '--data', '--inline'])).toMatchObject({ code: 2, err: expect.stringContaining('--data cannot be combined with --inline') });
  });

  test('converts a recording into <out>/<name>.spec.ts and says what it did; what the file reads is listed; the password is nowhere', () => {
    const out = tempDir();
    const result = runConvertCli([eg, '--out', out, '--expect-text', 'PROCEDURE MEANS']);
    expect(result.code).toBe(0);
    const specFile = path.join(out, 'eg_run_project.spec.ts');
    expect(fs.existsSync(specFile)).toBe(true);
    const spec = fs.readFileSync(specFile, 'utf8');
    expect(spec).toContain("test('recorded: eg_run_project @sas-desktop'");
    expect(spec).toContain('from examples/eg_run_project.sasrec.json'.replace('from ', 'Converted from '));
    expect(result.out).toContain(`${path.relative(process.cwd(), eg)}  ->  ${specFile}`);
    expect(result.out).toContain('reads from the environment: SAS_EG_PROFILE, SAS_USER, SAS_PASSWORD');
    expect(result.out).toContain('session fixture: egApp (the recording contains the logon; it runs once and is never retried)');
    expect(result.out).toContain('event 2: the "Tip of the Day" dialog is handled by a handler registered at the top of the test');
    expect(result.out).not.toContain('no assertion');
    expect(fs.readFileSync(eg, 'utf8')).not.toContain('Orion123');
    expect(result.out + result.err + spec).not.toContain('Orion123');
  });

  test('--out may name a .ts file; --page-objects writes pages/ next to it; --data writes the CSV and says how many columns; the options are passed on', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'flow.spec.ts');
    const result = runConvertCli([eg, '--out', file, '--page-objects', '--data', '--expect-window', 'Sales', '--tag', '@nightly', '--test-import', './support/sasTest', '--desktop-import', '../src/desktop', '--name', 'flow']);
    expect(result.code).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'nested', 'pages', 'FlowPages.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'nested', 'flow.data.csv'), 'utf8')).toMatch(/^fileNameField,mainFlowListItem\r?\nC:\\Projects\\Sales\.egp,Summary/);
    expect(result.out).toMatch(/pages: .*FlowPages\.ts \(4 class\(es\): MainPage, SelectProfilePage, SasLogonPage, OpenPage\)/);
    expect(result.out).toMatch(/data: .*flow\.data\.csv \(2 column\(s\); add a row per case\)/);
    const spec = fs.readFileSync(file, 'utf8');
    expect(spec).toContain("from './support/sasTest'");
    expect(spec).toContain('@nightly');
    expect(fs.readFileSync(path.join(dir, 'nested', 'pages', 'FlowPages.ts'), 'utf8')).toContain("from '../../../src/desktop'".replace('../../../', '../../'));
  });

  test('a folder converts every .sasrec.json in it; --name needs a single recording', () => {
    const input = tempDir();
    fs.copyFileSync(eg, path.join(input, 'a.sasrec.json'));
    fs.copyFileSync(smc, path.join(input, 'b.sasrec.json'));
    fs.writeFileSync(path.join(input, 'notes.txt'), 'not a recording');
    const out = tempDir();
    expect(runConvertCli([input, '--out', out, '--expect-text', 'x']).code).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['a.spec.ts', 'b.spec.ts']);
    expect(runConvertCli([input, '--name', 'x'])).toMatchObject({ code: 2, err: expect.stringContaining('--name names one test') });
    expect(runConvertCli([tempDir()])).toMatchObject({ code: 2, err: expect.stringContaining('no .sasrec.json files') });
  });

  test('a file that is not a valid recording is refused with its problems (exit 1) and nothing is written', () => {
    const dir = tempDir();
    const bad = path.join(dir, 'bad.sasrec.json');
    fs.writeFileSync(bad, JSON.stringify({ version: 2, app: 'eg', startedAt: 'x', tool: 'y', events: [] }));
    const out = path.join(dir, 'out');
    const result = runConvertCli([bad, '--out', out]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('is not a valid recording (2 problems)');
    expect(result.err).toContain('this tool reads version 1 (the file is version 2)');
    expect(fs.existsSync(out)).toBe(false);
    const leaky = JSON.parse(fs.readFileSync(eg, 'utf8'));
    leaky.events.find((e: { secret?: boolean }) => e.secret).value = 'hunter2-Zq9!';
    delete leaky.events.find((e: { value?: string }) => e.value === 'hunter2-Zq9!').secret;
    fs.writeFileSync(path.join(dir, 'leaky.sasrec.json'), JSON.stringify(leaky));
    const refused = runConvertCli([path.join(dir, 'leaky.sasrec.json'), '--out', out]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/looks like a password field .* but a value was recorded/);
    expect(refused.err).not.toContain('hunter2-Zq9!');
  });

  test('--strict: exit 1 when a human is needed (no assertion, a TODO step), 0 when nothing is; without --strict the exit is 0 either way', () => {
    const out = tempDir();
    expect(runConvertCli([eg, '--out', out, '--strict'])).toMatchObject({ code: 1, err: expect.stringContaining('1 item(s) need attention (--strict).') });
    expect(runConvertCli([eg, '--out', out, '--strict', '--allow-no-assertion']).code).toBe(1); // allowing it to pass is not asserting something
    expect(runConvertCli([eg, '--out', out, '--strict', '--expect-text', 'NOTE: ']).code).toBe(0);
    const noAssertion = runConvertCli([eg, '--out', out]);
    expect(noAssertion.code).toBe(0);
    expect(noAssertion.out).toContain('no assertion: the test fails until you add one (use --expect-text or --expect-window to generate it)');
    expect(runConvertCli([eg, '--out', out, '--allow-no-assertion']).out).toContain('no assertion: add one (TODO in the file)');
    // a recording with a control known only by a screen position
    const blind = JSON.parse(fs.readFileSync(eg, 'utf8'));
    blind.events.push({ type: 'click', t: blind.events[blind.events.length - 1].t, target: { window: { titlePattern: '^SAS Enterprise Guide$' }, path: [{ controlType: 'Pane' }], fallbackPoint: { x: 10, y: 20 } } });
    const file = path.join(tempDir(), 'blind.sasrec.json');
    fs.writeFileSync(file, JSON.stringify(blind));
    const strict = runConvertCli([file, '--out', out, '--strict', '--expect-text', 'x']);
    expect(strict.code).toBe(1);
    expect(strict.out).toMatch(/TODO event \d+: click on Pane in window "SAS Enterprise Guide": the recording only has a screen position \(10, 20\) in the window/);
    expect(runConvertCli([file, '--out', out, '--expect-text', 'x']).code).toBe(0);
  });

  test('the same through the real command (node, a separate process)', () => {
    const out = tempDir();
    const ok = spawnSync(process.execPath, [builtCli('convert'), eg, '--out', out, '--expect-text', 'NOTE: ', '--strict'], { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false' } });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('eg_run_project.spec.ts');
    expect(fs.existsSync(path.join(out, 'eg_run_project.spec.ts'))).toBe(true);
    const strict = spawnSync(process.execPath, [builtCli('convert'), eg, '--out', out, '--strict'], { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false' } });
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('--strict');
    expect(spawnSync(process.execPath, [builtCli('convert'), '--help'], { encoding: 'utf8' }).stdout).toContain('Usage:');
  });
});

test.describe('sas-eg-import-script', () => {
  test('--help; usage errors; converts a .vbs and a .ps1; --strict', () => {
    const help = runImportCli(['-h']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('sas-eg-import-script - turn the script of File > Schedule Project into a test');
    expect(runImportCli([])).toMatchObject({ code: 2, err: expect.stringContaining('missing the script') });
    expect(runImportCli(['--bogus', 'x'])).toMatchObject({ code: 2, err: expect.stringContaining('unknown option --bogus') });
    expect(runImportCli(['nope.vbs'])).toMatchObject({ code: 2, err: expect.stringContaining('does not exist') });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'Sales.vbs'), SCHEDULE);
    fs.writeFileSync(path.join(dir, 'Other.ps1'), '$app = New-Object -ComObject SASEGObjectModel.Application.8.3\n$p = $app.Open("C:\\a.egp", "")\n$p.Run()\n$app.Quit()\n');
    const out = path.join(dir, 'out');
    const result = runImportCli([path.join(dir, 'Sales.vbs'), '--out', out, '--strict']);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(out, 'Sales.spec.ts'), 'utf8')).toContain("test('eg schedule script: Sales @sas-desktop'");
    expect(result.out).toContain('reads from the environment: SAS_EG_PROGID, SAS_EG_PROFILE');
    expect(result.out).not.toContain('Dev SAS Server');
    const folder = runImportCli([dir, '--out', out]);
    expect(folder.code).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['Other.spec.ts', 'Sales.spec.ts']);
    expect(runImportCli([dir, '--name', 'x'])).toMatchObject({ code: 2 });
    fs.writeFileSync(path.join(dir, 'Odd.vbs'), 'Set app = CreateObject("SASEGObjectModel.Application.7.1")\nOn Error Resume Next\napp.Quit');
    const strict = runImportCli([path.join(dir, 'Odd.vbs'), '--out', out, '--strict']);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('TODO script line 2: On Error Resume Next');
    expect(strict.out).toContain('no assertion: the script runs nothing, so the test fails until you add one');
    expect(runImportCli([path.join(dir, 'Odd.vbs'), '--out', out]).code).toBe(0);
  });

  test('the same through the real command', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'Sales.vbs'), SCHEDULE);
    const run = spawnSync(process.execPath, [builtCli('importScript'), path.join(dir, 'Sales.vbs'), '--out', dir, '--strict'], { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false' } });
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'Sales.spec.ts'))).toBe(true);
  });
});

test.describe('sas-desktop-record', () => {
  const dir = () => tempDir();
  const actions = (file: string) => {
    const probe = startFakeDesktopForTests();
    const account = probe.eg.options.accounts[0] as { user: string; password: string };
    fs.writeFileSync(
      file,
      JSON.stringify([
        { do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } },
        { do: 'select', window: '^Select Profile$', find: 'Dev SAS Server' },
        { do: 'click', window: '^Select Profile$', find: { name: 'OK', controlType: 'Button' } },
        { do: 'type', window: '^SAS Logon$', find: { automationId: 'userIdField' }, text: account.user },
        { do: 'type', window: '^SAS Logon$', find: { automationId: 'passwordField' }, text: account.password, commit: 'enter' },
        { do: 'click', window: '^SAS Logon$', find: { name: 'OK', controlType: 'Button' } },
      ]),
    );
    return account;
  };

  test('--help; and every wrong use is a usage error that says what to do', async () => {
    const help = await runRecordCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('sas-desktop-record - record what you do in SAS Management Console or SAS Enterprise Guide');
    for (const flag of ['--app', '--out', '--stop-key', '--mode', '--secret-pattern', '--poll-ms', '--force', '--simulator', '--simulate']) expect(help.out, flag).toContain(flag);
    expect(help.out).toContain('nothing typed into a password field is ever recorded');
    expect(help.out).toContain('NOT VERIFIED');
    expect(await runRecordCli([])).toMatchObject({ code: 2, err: expect.stringContaining('--app is required') });
    expect(await runRecordCli(['--app', 'eg', '--simulator'])).toMatchObject({ code: 2, err: expect.stringContaining('--simulator has no user to record: give --simulate') });
    expect(await runRecordCli(['--app', 'eg', '--simulate', 'x.json'])).toMatchObject({ code: 2, err: expect.stringContaining('--simulate only works with --simulator') });
    expect(await runRecordCli(['--app', 'eg', '--mode', 'turbo'])).toMatchObject({ code: 2, err: expect.stringContaining('--mode must be full or uia') });
    expect(await runRecordCli(['--app', 'eg', '--secret-pattern', '('])).toMatchObject({ code: 2, err: expect.stringContaining('not a valid regular expression') });
    expect(await runRecordCli(['--app', 'eg', '--poll-ms', '3'])).toMatchObject({ code: 2, err: expect.stringContaining('--poll-ms must be a whole number of at least 20') });
    expect(await runRecordCli(['--app', 'eg', '--wat'])).toMatchObject({ code: 2, err: expect.stringContaining('unknown option --wat') });
    expect(await runRecordCli(['--app', 'eg', '--simulator', '--simulate', 'no/such/actions.json'])).toMatchObject({ code: 2, err: expect.stringContaining('--simulate no/such/actions.json:') });
  });

  test('records the scripted session in the stand-in, writes the file, prints the summary and the reminder - and no password anywhere', async () => {
    const d = dir();
    const simulate = path.join(d, 'actions.json');
    const account = actions(simulate);
    const out = path.join(d, 'recordings', 'logon.sasrec.json');
    const result = await runRecordCli(['--app', 'eg', '--out', out, '--simulator', '--simulate', simulate]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Recording eg (SEGuide, 1 window(s) open).');
    expect(result.out).toContain('The stand-in desktop performs the simulated user actions now.');
    expect(result.out).toContain(`Recorded ${out}:`);
    expect(result.out).toMatch(/passwords: nothing typed into a password field was kept - 1 entry\(ies\) are marked secret \(no value\); \d+ key press\(es\) in such fields were thrown away/);
    expect(result.out).toContain('Next: sas-desktop-to-playwright');
    const text = fs.readFileSync(out, 'utf8');
    expect(text).not.toContain(account.password);
    expect(result.out + result.err).not.toContain(account.password);
    expect(JSON.parse(text)).toMatchObject({ version: 1, app: 'eg', stats: { secretEntries: 1, secretKeysDiscarded: account.password.length } });
    // and the converter accepts it
    expect(runConvertCli([out, '--out', d, '--expect-text', 'x']).code).toBe(0);
  });

  test('will not overwrite a recording unless told to; the default file name is in SAS_RECORDER_DIR', async () => {
    const d = dir();
    const simulate = path.join(d, 'actions.json');
    actions(simulate);
    const out = path.join(d, 'x.sasrec.json');
    expect((await runRecordCli(['--app', 'eg', '--out', out, '--simulator', '--simulate', simulate])).code).toBe(0);
    const again = await runRecordCli(['--app', 'eg', '--out', out, '--simulator', '--simulate', simulate]);
    expect(again.code).toBe(2);
    expect(again.err).toContain('already exists: choose another name, or overwrite it on purpose with --force');
    expect((await runRecordCli(['--app', 'eg', '--out', out, '--simulator', '--simulate', simulate, '--force'])).code).toBe(0);
    expect(await runRecordCli(['--app', 'eg', '--out', path.join(d, 'wrong.txt'), '--simulator', '--simulate', simulate])).toMatchObject({ code: 2, err: expect.stringContaining('--out must end in .sasrec.json') });
    const byDefault = await withEnv({ SAS_RECORDER_DIR: path.join(d, 'default') }, () => runRecordCli(['--app', 'eg', '--simulator', '--simulate', simulate]));
    expect(byDefault.code).toBe(0);
    expect(fs.readdirSync(path.join(d, 'default'))[0]).toMatch(/^eg-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.sasrec\.json$/);
  });

  test('against a real system the environment must be declared: an unknown one is refused before anything starts, and nothing is written', async () => {
    const d = dir();
    const environments = path.join(d, 'environments.json');
    fs.writeFileSync(environments, JSON.stringify({ environments: { dev: { kind: 'nonprod', hosts: ['sasmeta.dev.example.com'] }, prod: { kind: 'prod', hosts: ['sasmeta.example.com'] } } }));
    const out = path.join(d, 'x.sasrec.json');
    const audit = path.join(d, 'audit.jsonl');
    const env = { SAS_ENVIRONMENTS_FILE: environments, SAS_AUDIT_FILE: audit };
    const unknown = await withEnv({ ...env, SAS_ENVIRONMENT: 'mystery' }, () => runRecordCli(['--app', 'eg', '--out', out]));
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('environment "mystery" is not declared');
    const prod = await withEnv({ ...env, SAS_ENVIRONMENT: 'prod', SAS_ALLOW_PROD_READS: undefined }, () => runRecordCli(['--app', 'eg', '--out', out]));
    expect(prod.code).toBe(1);
    expect(prod.err).toContain('production environment and reads there are switched off');
    expect(fs.existsSync(out)).toBe(false);
    // a declared non-production environment passes the gate (and then needs Windows: on this machine the bridge cannot start)
    const dev = await withEnv({ ...env, SAS_ENVIRONMENT: 'dev', SAS_DESKTOP_SIMULATOR: undefined }, () => runRecordCli(['--app', 'eg', '--out', out]));
    expect(dev.out).toContain('environment: dev (allowed)');
    expect(fs.readFileSync(audit, 'utf8')).toContain('"operation":"record"');
  });

  test('the same through the real command (node, a separate process)', () => {
    const d = dir();
    const simulate = path.join(d, 'actions.json');
    actions(simulate);
    const out = path.join(d, 'x.sasrec.json');
    const run = spawnSync(process.execPath, [builtCli('record'), '--app', 'eg', '--out', out, '--simulator', '--simulate', simulate], { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Recorded');
    expect(fs.existsSync(out)).toBe(true);
    const failed = spawnSync(process.execPath, [builtCli('record'), '--app', 'eg'], { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false' } });
    // no --out is fine (a default name is used), but against a real system the environment must be declared / Windows must be there: it stops with a reason, exit 1
    expect(failed.status).toBe(1);
    expect(failed.stderr.length).toBeGreaterThan(10);
  });
});
