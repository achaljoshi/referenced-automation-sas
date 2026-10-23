import { expect, test } from '@playwright/test';
import {
  FAKE_EG_PATH,
  FAKE_SMC_PATH,
  formatDoctor,
  formatInspection,
  formatWindows,
  inspectWindows,
  javaAccessBridgeHint,
  locatorFor,
  runDoctor,
  startFakeDesktop,
  windowPatternFor,
} from '../../src/desktop';
import { builtInspectCli, runNode } from './support';

// The inspect tool and the doctor, against the stand-in. NOT VERIFIED on a real desktop.

test.describe('locatorFor: a locator to paste, from the most stable property', () => {
  test('automation id first, then role + name, then name, then role + class, then role', () => {
    expect(locatorFor({ automationId: 'okBtn', name: 'OK', controlType: 'Button', className: 'JButton' })).toBe(".getByAutomationId('okBtn')");
    expect(locatorFor({ automationId: '', name: 'OK', controlType: 'Button', className: 'JButton' })).toBe(".getByRole('Button', { name: 'OK' })");
    expect(locatorFor({ automationId: '', name: 'OK', controlType: '', className: '' })).toBe(".getByName('OK')");
    expect(locatorFor({ automationId: '', name: '', controlType: 'Pane', className: 'JPanel' })).toBe(".getByRole('Pane').getByClassName('JPanel')");
    expect(locatorFor({ automationId: '', name: '', controlType: 'Pane', className: '' })).toBe(".getByRole('Pane')");
    expect(locatorFor({ automationId: '', name: '', controlType: '', className: '' })).toMatch(/no name, id or type/);
  });

  test('quotes and backslashes in names are escaped so the line pastes into code', () => {
    expect(locatorFor({ automationId: '', name: "Bob's \\ file", controlType: 'TreeItem', className: '' })).toBe(".getByRole('TreeItem', { name: 'Bob\\'s \\\\ file' })");
  });

  test('every locator printed finds exactly that control again', async () => {
    const fake = startFakeDesktop();
    const session = fake.session();
    const eg = await session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
    const inspected = await inspectWindows(session, /Enterprise Guide/);
    const node = inspected[0]?.nodes.find((n) => n.automationId === 'ConnectButton');
    expect(node).toBeDefined();
    expect(locatorFor(node!)).toBe(".getByAutomationId('ConnectButton')");
    expect((await eg.window(/Enterprise Guide/).getByAutomationId('ConnectButton').peek())?.name).toBe('Connect');
  });
});

test.describe('inspect output', () => {
  test('windows lists every window with its process; inspect prints every control with name, id, type, class and a locator, indented by depth', async () => {
    const fake = startFakeDesktop();
    const session = fake.session();
    await session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
    const windows = formatWindows(await session.listWindows());
    expect(windows).toMatch(/SEGuide\s+"SAS Enterprise Guide"/);
    const text = formatInspection(await inspectWindows(session, windowPatternFor('eg')));
    expect(text).toContain('WINDOW "SAS Enterprise Guide"  process SEGuide');
    expect(text).toMatch(/Button\s+name="Connect" id="ConnectButton" class=""\s+->\s+\.getByAutomationId\('ConnectButton'\)/);
    expect(text).toMatch(/^\s{2}Text\s+name="Welcome"/m);
  });

  test('a password field is marked and nothing it holds is printed; a disabled control is flagged', async () => {
    const fake = startFakeDesktop();
    const session = fake.session();
    const smc = await session.launch({ path: FAKE_SMC_PATH, windowTitle: /Connection/ });
    await smc.window(/Connection/).getByName('Dev Metadata Server').select();
    await smc.window(/Connection/).getByName('OK').click();
    await smc.window(/Log On/).getByName('User ID:').fill('sasdemo');
    await smc.window(/Log On/).getByName('Password:').fill('SuperSecret-123');
    const text = formatInspection(await inspectWindows(session, /Log On/));
    expect(text).not.toContain('SuperSecret-123');
    expect(text).not.toContain('sasdemo'); // field values are not part of the dump at all
    expect(text).toMatch(/Edit\s+name="Password:" id="passwordField".*PASSWORD FIELD - value never read/);
  });

  test('a window with nothing visible to UI Automation says it may be the Java Access Bridge', async () => {
    const fake = startFakeDesktop({ smc: { javaAccessBridge: false } });
    const session = fake.session();
    await session.launch({ path: FAKE_SMC_PATH, windowTitle: /./ });
    const text = formatInspection(await inspectWindows(session, windowPatternFor('smc')));
    expect(text).toMatch(/no controls visible to UI Automation.*Java Access Bridge.*doctor/);
  });

  test('no matching window is explained', async () => {
    const fake = startFakeDesktop();
    expect(formatInspection(await inspectWindows(fake.session(), /Nothing/))).toMatch(/No window matches/);
    expect(formatWindows([])).toMatch(/locked or disconnected/);
  });

  test('--app: smc and eg are shortcuts, anything else is a title pattern, a bad pattern is an error', () => {
    expect(windowPatternFor('smc').test('SAS Management Console')).toBe(true);
    expect(windowPatternFor('eg').test('Sales - SAS Enterprise Guide')).toBe(true);
    expect(windowPatternFor('^Log').test('log on')).toBe(true);
    expect(() => windowPatternFor('(')).toThrow(/--app must be/);
  });
});

test.describe('doctor', () => {
  const ok = (report: Awaited<ReturnType<typeof runDoctor>>, name: RegExp) => report.checks.find((c) => name.test(c.name));

  test('a healthy desktop: every check passes, with the facts behind each', async () => {
    const fake = startFakeDesktop();
    const report = await runDoctor(fake.session(), { checkPaths: false });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'the bridge script is the one this version shipped',
      'the bridge starts and answers',
      'this is Windows with an interactive session',
      'the desktop is unlocked and connected',
      'UI Automation works',
      'the bridge is not elevated (or the programs are)',
      'COM allow-list',
      'Java Access Bridge (Management Console)',
      'Enterprise Guide COM object can be created',
    ]);
    expect(ok(report, /COM object/)?.detail).toMatch(/SASEGObjectModel\.Application\.8\.3 \(newest registered/);
    expect(formatDoctor(report)).toMatch(/All checks passed/);
    expect(formatDoctor(report)).toMatch(/NOT VERIFIED/);
    expect(fake.desktop.com.openHandles).toBe(0); // the probe object was released
  });

  test('a Java window that UI Automation cannot see: says exactly that, with jabswitch -enable and a restart', async () => {
    const fake = startFakeDesktop({ smc: { javaAccessBridge: false } });
    const session = fake.session();
    await session.launch({ path: FAKE_SMC_PATH, windowTitle: /./ });
    const report = await runDoctor(session, { checkPaths: false });
    const check = ok(report, /Java Access Bridge/)!;
    expect(check.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(check.detail).toMatch(/"SAS Management Console" \(sasmc, pid \d+\): a Java window whose UI Automation tree is empty - the symptom of a disabled Java Access Bridge/);
    expect(check.hint).toMatch(/jabswitch\.exe" -enable/);
    expect(check.hint).toMatch(/restart Management Console/);
    expect(formatDoctor(report)).toMatch(/FAIL .*Java Access Bridge/);
  });

  test('the same window with the bridge enabled passes', async () => {
    const fake = startFakeDesktop();
    const session = fake.session();
    await session.launch({ path: FAKE_SMC_PATH, windowTitle: /./ });
    expect(ok(await runDoctor(session, { checkPaths: false }), /Java Access Bridge/)).toMatchObject({ ok: true });
  });

  test('no Java window open and the bridge not enabled on this machine: a warning with the instructions, not a failure', async () => {
    const fake = startFakeDesktop({ accessBridge: false });
    const report = await runDoctor(fake.session(), { checkPaths: false });
    const check = ok(report, /Java Access Bridge/)!;
    expect(check).toMatchObject({ ok: true, warn: true });
    expect(check.hint).toMatch(/jabswitch/);
  });

  test('a locked desktop, a non-interactive session and a missing COM class are failures with a hint each', async () => {
    const fake = startFakeDesktop({ environment: { userInteractive: false }, eg: { comVersions: [] } });
    const real = fake.desktop.request.bind(fake.desktop);
    fake.desktop.request = async (c) => {
      const reply = await real(c);
      return c.op === 'environment' ? { ...(reply as object), desktopAccessible: false } : reply;
    };
    const report = await runDoctor(fake.session(), { checkPaths: false });
    expect(ok(report, /interactive session/)).toMatchObject({ ok: false });
    expect(ok(report, /unlocked and connected/)).toMatchObject({ ok: false });
    expect(ok(report, /unlocked and connected/)?.hint).toMatch(/SESSION_LOST/);
    expect(ok(report, /COM object/)).toMatchObject({ ok: false });
    expect(ok(report, /COM object/)?.hint).toMatch(/SysWOW64/);
    expect(report.ok).toBe(false);
  });

  test('program paths: unset ones warn, wrong ones fail, existing ones pass (the check of files is injectable)', async () => {
    const fake = startFakeDesktop();
    const config = { smcPath: 'C:\\sas\\sasmc.exe', egPath: undefined, comProgIds: ['SASEGObjectModel.Application.*'] } as never;
    const missing = await runDoctor(fake.session(), { config, exists: () => false });
    expect(ok(missing, /Management Console path/)).toMatchObject({ ok: false, detail: 'C:\\sas\\sasmc.exe' });
    expect(ok(missing, /Enterprise Guide path/)).toMatchObject({ ok: true, warn: true });
    const present = await runDoctor(fake.session(), { config, exists: () => true });
    expect(ok(present, /Management Console path/)).toMatchObject({ ok: true });
  });

  test('when the bridge does not answer the doctor stops there and says what to look at', async () => {
    const fake = startFakeDesktop();
    fake.desktop.request = async () => {
      throw new Error('spawn powershell.exe ENOENT');
    };
    const report = await runDoctor(fake.session(), { checkPaths: false });
    expect(report.ok).toBe(false);
    const last = report.checks.at(-1)!;
    expect(last.name).toBe('the bridge starts and answers');
    expect(last.hint).toMatch(/Windows PowerShell 5\.1/);
    expect(last.hint).toMatch(/SAS_DESKTOP_SCRIPT_DIR/);
  });

  test('the Java Access Bridge hint names the jabswitch it found, else where to look', () => {
    expect(javaAccessBridgeHint({ jabswitch: ['C:\\Java\\bin\\jabswitch.exe'] })).toContain('"C:\\Java\\bin\\jabswitch.exe" -enable');
    expect(javaAccessBridgeHint({ jabswitch: [] })).toMatch(/bin folder of the Java that Management Console uses/);
    expect(javaAccessBridgeHint()).toMatch(/restart/i);
  });
});

test.describe('the sas-desktop-inspect command (built stand-in, --simulator)', () => {
  test('--help and no arguments print the usage', () => {
    const help = runNode([builtInspectCli(), '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/sas-desktop-inspect doctor/);
    expect(help.stdout).toMatch(/inspect --app smc\|eg\|<regex>/);
    expect(runNode([builtInspectCli()]).status).toBe(1);
  });

  test('inspect --app smc prints the controls and ready-to-paste locators', () => {
    const run = runNode([builtInspectCli(), 'inspect', '--app', 'smc', '--simulator', '--depth', '4']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/WINDOW "Connection Profile"/);
    expect(run.stdout).toMatch(/ListItem\s+name="Dev Metadata Server".*getByRole\('ListItem', \{ name: 'Dev Metadata Server' \}\)/);
  });

  test('windows lists the simulator\'s windows', () => {
    const run = runNode([builtInspectCli(), 'windows', '--simulator']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/sasmc\s+"Connection Profile"/);
    expect(run.stdout).toMatch(/SEGuide\s+"SAS Enterprise Guide"/);
  });

  test('doctor against the simulator exits 0 and says NOT VERIFIED', () => {
    const run = runNode([builtInspectCli(), 'doctor', '--simulator']);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/OK .*the bridge script is the one this version shipped/);
    expect(run.stdout).toMatch(/NOT VERIFIED/);
  });

  test('bad arguments exit 2 with a message; an unknown command too', () => {
    expect(runNode([builtInspectCli(), 'inspect', '--simulator']).status).toBe(2);
    expect(runNode([builtInspectCli(), 'inspect', '--app', 'smc', '--depth', 'x', '--simulator']).status).toBe(2);
    const unknown = runNode([builtInspectCli(), 'frobnicate', '--simulator']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/unknown command "frobnicate"/);
  });

  test('--print-bridge says where the script is and the hash this version expects', () => {
    const run = runNode([builtInspectCli(), '--print-bridge']);
    expect(run.stdout).toMatch(/sas-desktop-bridge\.ps1/);
    expect(run.stdout).toMatch(/expected SHA-256: [0-9a-f]{64}/);
  });

  test('without --simulator on a machine that is not Windows, doctor fails with the reason instead of crashing', () => {
    const run = runNode([builtInspectCli(), 'doctor'], { SAS_DESKTOP_SIMULATOR: 'false' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Windows-only/);
  });
});
