import { expect, test } from '@playwright/test';
import { decodeScript, detectKind, importEgScript, parseEgScript, type ImportOptions } from '../../src/recorder';
import { runGenerated, VIRTUAL_DESKTOP, VIRTUAL_TEST, type World } from './support/runGenerated';
import { typeCheck } from './support/typeCheck';

// ASSUMPTION (not checked against a script written by an installed Enterprise Guide): File > Schedule Project writes a VBScript of this shape, from SAS's
// documentation and community write-ups of running Enterprise Guide projects in batch. The tests below pin what the importer does with that shape and with
// the variations people make of it.

const SCHEDULE_VBS = `' Enterprise Guide project scheduling script (assumed shape)
Option Explicit
Dim app
Dim prjObject

Set app = CreateObject("SASEGObjectModel.Application.7.1")
' use the server profile the project needs
app.SetActiveProfile("Dev SAS Server")

Set prjObject = app.Open("C:\\Projects\\Sales.egp", "")
prjObject.Run
prjObject.Save
prjObject.Close
app.Quit
`;

const SCHEDULE_PS1 = `# Run an Enterprise Guide project (PowerShell form of the schedule script)
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject "SASEGObjectModel.Application.7.1"
$app.SetActiveProfile("Dev SAS Server")
$project = $app.Open("C:\\Projects\\Sales.egp", "")
[void]$project.Run()
$project.Save()
$project.Close()
$app.Quit()
`;

const base: ImportOptions = { testImport: VIRTUAL_TEST, desktopImport: VIRTUAL_DESKTOP, sourceName: 'scripts/Sales.vbs' };
const todoLines = (code: string) => code.split('\n').filter((l) => l.trim().startsWith('// TODO(manual'));

test.describe('reading the script', () => {
  test('the schedule script becomes: connect, open, run, save, close - with the profile read from the environment', () => {
    const { steps, warnings } = parseEgScript(SCHEDULE_VBS, 'vbs');
    expect(steps.map((s) => s.kind)).toEqual(['connect', 'profile', 'open', 'run', 'save', 'close', 'quit']);
    expect(steps[0]).toMatchObject({ progId: 'SASEGObjectModel.Application.7.1', line: 6 });
    expect(steps[2]).toMatchObject({ path: { kind: 'literal', value: 'C:\\Projects\\Sales.egp' }, line: 10 });
    expect(warnings).toEqual([expect.objectContaining({ severity: 'info', message: expect.stringMatching(/the profile name identifies a server: it is read from SAS_EG_PROFILE/) })]);
    expect(JSON.stringify(warnings)).not.toContain('Dev SAS Server');
  });

  test('the PowerShell form reads the same', () => {
    expect(detectKind(SCHEDULE_PS1)).toBe('ps1');
    expect(detectKind(SCHEDULE_VBS)).toBe('vbs');
    expect(detectKind('x', 'a.ps1')).toBe('ps1');
    const { steps } = parseEgScript(SCHEDULE_PS1, 'ps1');
    expect(steps.map((s) => s.kind)).toEqual(['connect', 'profile', 'open', 'run', 'save', 'close', 'quit']);
  });

  test('variations: method calls with and without parentheses and Set, variables, joined text, one line with colons, continued lines, any case', () => {
    const script = `Dim folder, name
folder = "C:\\Projects\\"
name = "Sales"
Set app = CreateObject("SASEGObjectModel.Application.8.3"): app.SetActiveProfile "Dev SAS Server"
Set prj = app.Open(folder & name & ".egp", _
    "")
PRJ.RUN()
prj.save
app.Quit()`;
    const { steps, warnings } = parseEgScript(script, 'vbs');
    expect(steps.map((s) => s.kind)).toEqual(['connect', 'profile', 'open', 'run', 'save', 'quit']);
    expect(steps[2]).toMatchObject({ kind: 'open', path: { kind: 'literal', value: 'C:\\Projects\\Sales.egp' } });
    expect(warnings.filter((w) => w.severity === 'todo')).toEqual([]);
  });

  test('comments, block comments, rem lines and semicolons in PowerShell', () => {
    const script = `<# a block
comment with $app.Quit() in it #>
$app = New-Object -ComObject SASEGObjectModel.Application.7.1 # trailing comment
$app.SetActiveProfile('Dev SAS Server'); $p = $app.Open('C:\\Projects\\Sales.egp','')
$p.Run() # run it
$app.Quit()`;
    const { steps } = parseEgScript(script, 'ps1');
    expect(steps.map((s) => s.kind)).toEqual(['connect', 'profile', 'open', 'run', 'quit']);
    expect(parseEgScript("REM nothing\n' nothing\nSet app = CreateObject(\"SASEGObjectModel.Application.7.1\") ' the object\napp.Quit", 'vbs').steps.map((s) => s.kind)).toEqual(['connect', 'quit']);
  });

  test('one process flow by NAME is run; by index it is a TODO', () => {
    const named = parseEgScript(`Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet prj = app.Open("C:\\a.egp", "")\nprj.ContainerCollection.Item("Process Flow 1").Run\nprj.ContainerCollection.Item(0).Run`, 'vbs');
    expect(named.steps.map((s) => s.kind)).toEqual(['connect', 'open', 'runFlow', 'todo']);
    expect(named.steps[2]).toMatchObject({ name: { kind: 'literal', value: 'Process Flow 1' } });
    expect(named.steps[3]).toMatchObject({ kind: 'todo', reason: expect.stringMatching(/found by name/) });
  });

  test('a script encoded as UTF-16 (a byte order mark), UTF-8 with a mark, or plain text is read the same', () => {
    const text = 'Set app = CreateObject("SASEGObjectModel.Application.7.1")\r\napp.Quit\r\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const swapped = Buffer.from(Buffer.from(text, 'utf16le'));
    swapped.swap16();
    expect(decodeScript(utf16)).toBe(text);
    expect(decodeScript(Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]))).toBe(text);
    expect(decodeScript(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]))).toBe(text);
    expect(decodeScript(Buffer.from(text))).toBe(text);
  });
});

test.describe('what cannot be converted is a TODO(manual) with its script line', () => {
  const script = `Set app = CreateObject("SASEGObjectModel.Application.7.1")
Set fso = CreateObject("Scripting.FileSystemObject")
On Error Resume Next
app.Visible = True
Set prj = app.Open("C:\\Projects\\Sales.egp", "")
prj.SaveAs "C:\\Projects\\Copy.egp"
prj.Run
If prj.Name = "x" Then
    prj.Save
End If
Set other = SomeObject.Open("a")
app.Quit`;
  const result = importEgScript(script, base);

  test('each such line is a comment with its reason, a warning marked todo, and counted', () => {
    const todos = todoLines(result.code);
    expect(todos.map((l) => l.trim())).toEqual(
      expect.arrayContaining([
        '// TODO(manual, script line 2): Set fso = CreateObject("Scripting.FileSystemObject")',
        '// TODO(manual, script line 3): On Error Resume Next',
        '// TODO(manual, script line 6): prj.SaveAs "C:\\Projects\\Copy.egp"',
      ]),
    );
    expect(result.warnings.filter((w) => w.severity === 'todo').map((w) => w.event)).toEqual([2, 3, 6, 8, 9, 10, 11]);
    expect(result.todos).toBe(7);
    expect(result.code).toMatch(/\/\/ {3}only the Enterprise Guide object model \(SASEGObjectModel.Application.x.y\) is supported, not Scripting.FileSystemObject/);
    expect(result.code).toMatch(/On Error Resume Next swallows errors/);
    expect(result.code).toMatch(/Project.SaveAs has no equivalent in the driver \(it supports Run, Save, Close\)/);
    expect(result.code).toContain(' *  - script line 3: On Error Resume Next - On Error Resume Next swallows errors');
  });

  test('control flow is never converted: a step inside an If, a loop or a Try is a TODO, not an unconditional step', () => {
    const vbs = parseEgScript(
      `Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet prj = app.Open("C:\\a.egp", "")\nIf Weekday(Now) = 1 Then\n  prj.Run\nElse\n  prj.Save\nEnd If\nFor i = 1 To 3\n  prj.Run\nNext\nprj.Close\nIf x Then prj.Save`,
      'vbs',
    );
    expect(vbs.steps.map((s) => s.kind)).toEqual(['connect', 'open', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'close', 'todo']);
    const ps = parseEgScript(`$app = New-Object -ComObject SASEGObjectModel.Application.7.1\n$p = $app.Open('C:\\a.egp', '')\nif ($env:RUN) {\n  $p.Run()\n} else {\n  $p.Save()\n}\ntry {\n  $p.Close()\n} catch {\n  $app.Quit()\n}\n$p.Save()`, 'ps1');
    expect(ps.steps.map((s) => s.kind)).toEqual(['connect', 'open', ...Array.from({ length: 10 }, () => 'todo'), 'save']);
    expect(ps.steps.filter((s) => s.kind === 'todo' && /control flow/.test(s.reason))).toHaveLength(10);
  });

  test('what it did understand is still converted, in order', () => {
    expect(result.code).toContain("await eg.openProject(CONSTANTS.project); // script line 5");
    expect(result.code.indexOf('openProject')).toBeLessThan(result.code.indexOf('runProject'));
    expect(result.code).toContain('statuses = await eg.runProject(); // script line 7');
  });

  test('a script that never creates the Enterprise Guide object is flagged', () => {
    const none = importEgScript('prj.Run', base);
    expect(none.warnings.map((w) => w.message).join('\n')).toMatch(/never creates the Enterprise Guide object/);
    expect(none.todos).toBeGreaterThanOrEqual(2);
  });
});

test.describe('secrets and profiles', () => {
  test('the profile is read from SAS_EG_PROFILE and the object model version is a default of SAS_EG_PROGID: neither the profile name nor a password is in the test', () => {
    const { code, envVars } = importEgScript(SCHEDULE_VBS, base);
    expect(code).not.toContain('Dev SAS Server');
    expect(envVars.sort()).toEqual(['SAS_EG_PROFILE', 'SAS_EG_PROGID']);
    expect(code).toContain("get progId() {\n    return env.get('SAS_EG_PROGID', 'SASEGObjectModel.Application.7.1');\n  },");
    expect(code).toContain("get profile() {\n    return env.get('SAS_EG_PROFILE');\n  },");
    expect(code).toContain("await VIRTUAL.connect".replace('await VIRTUAL.connect', "await SasEnterpriseGuide.connect(desktopSession, { progId: CONSTANTS.progId, profile: CONSTANTS.profile })"));
  });

  test('a variable named like a secret loses its literal wherever it is used - also in a TODO line that is copied into the file', () => {
    const typedSecret = 'hunter2-Zq9!';
    const script = `Set app = CreateObject("SASEGObjectModel.Application.7.1")
password = "${typedSecret}"
pin = "4711"
Set prj = app.Open("C:\\a.egp", "")
Set conn = SomeObject.Connect("srv", "bob", password)
prj.Run`;
    const result = importEgScript(script, base);
    expect(result.code).not.toContain(typedSecret);
    expect(result.code).not.toContain('4711');
    expect(JSON.stringify(result.warnings)).not.toContain(typedSecret);
    expect(result.warnings.map((w) => w.message).join('\n')).toMatch(/"password" looks like a password: its literal was dropped/);
    expect(result.code).toContain('SomeObject.Connect("[REDACTED]", "[REDACTED]", password)');
  });

  test('in PowerShell too: $password and a secret-looking variable', () => {
    const typedSecret = 'hunter2-Zq9!';
    const script = `$app = New-Object -ComObject SASEGObjectModel.Application.7.1
$password = '${typedSecret}'
$p = $app.Open('C:\\a.egp', '')
$p.Run()
Write-Host "pw is $password"`;
    const result = importEgScript(script, { ...base, sourceName: 'x.ps1' });
    expect(result.code).not.toContain(typedSecret);
    expect(result.warnings.some((w) => /console output is not carried over/.test(w.message))).toBe(true);
  });

  test('the user name and the paths are not secrets: the project path stays, as a constant', () => {
    expect(importEgScript(SCHEDULE_VBS, base).code).toContain("project: 'C:\\\\Projects\\\\Sales.egp',");
  });
});

test.describe('the generated test', () => {
  const { code } = importEgScript(SCHEDULE_VBS, base);

  test('is a test that connects, does what the script did, asserts that no program ended with an error, and quits in a finally block', () => {
    expect(code).toContain("test('eg schedule script: Sales @sas-desktop', async ({ desktopSession }) => {");
    expect(code).toContain('const eg = await SasEnterpriseGuide.connect(desktopSession, { progId: CONSTANTS.progId, profile: CONSTANTS.profile });');
    expect(code).toContain('  try {');
    expect(code).toContain('let statuses = await eg.runProject(); // script line 11');
    expect(code).toContain('await eg.saveProject(); // script line 12');
    expect(code).toContain('await eg.closeProject(); // script line 13');
    expect(code).toContain("const failed = statuses.filter((s) => ['Error'].includes(s.status));");
    expect(code).toContain("expect(failed.map((s) => `${s.name}: ${s.status}`), 'programs that ended with errors').toEqual([]);");
    expect(code.indexOf('  } finally {\n    await eg.quit();')).toBeGreaterThan(code.indexOf('statuses'));
    expect(code.match(/eg\.quit\(\)/g)).toHaveLength(1); // the script's own Quit is covered by the one in finally
    expect(code).toContain('NOT been checked against your installation');
    expect(code).toContain('quit() is in a finally block');
  });

  test('--fail-on-warnings, the session fixture, the tag and the imports can be chosen; the package-root style needs no desktopImport', () => {
    const custom = importEgScript(SCHEDULE_VBS, { sourceName: 'a/b.vbs', failOnWarnings: true, sessionFixture: 'session', tag: '@nightly', name: 'Nightly' });
    expect(custom.code).toContain("['Error', 'Warning'].includes(s.status)");
    expect(custom.code).toContain("async ({ session }) => {");
    expect(custom.code).toContain("'eg schedule script: Nightly @nightly'");
    expect(custom.code).toContain("import { desktop } from '@automation/referenced-automation-sas';");
    expect(custom.code).toContain('desktop.SasEnterpriseGuide.connect(session,');
    expect(custom.code).toContain("import { desktopTest as test, desktopExpect as expect } from '@automation/referenced-automation-sas';");
  });

  test('a script that runs nothing has no program status to check: the guard fails until an assertion is added (the same rule as for recordings)', () => {
    const idle = importEgScript('Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet prj = app.Open("C:\\a.egp", "")\napp.Quit', base);
    expect(idle.hasAssertion).toBe(false);
    expect(idle.code).toContain('TODO(converter): no assertion');
    expect(idle.code).toContain("throw new Error('add an assertion");
    expect(idle.todos).toBe(1);
    const allowed = importEgScript('Set app = CreateObject("SASEGObjectModel.Application.7.1")\napp.Quit', { ...base, allowNoAssertion: true });
    expect(allowed.code).not.toContain('throw new Error');
  });

  test('a process flow run reads the program statuses afterwards, and two projects get two constants', () => {
    const result = importEgScript(`Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet a = app.Open("C:\\a.egp", "")\na.ContainerCollection.Item("Main Flow").Run\nSet b = app.Open("C:\\b.egp", "")\nb.Run`, base);
    expect(result.code).toContain("await eg.runProcessFlow(CONSTANTS.processFlow);");
    expect(result.code).toContain('let statuses = await eg.programStatuses();');
    expect(result.code).toContain("project: 'C:\\\\a.egp',");
    expect(result.code).toContain("project2: 'C:\\\\b.egp',");
    expect(result.code).toContain('statuses = await eg.runProject();');
  });

  test('type-checks under the repository\'s strict settings', () => {
    const virtual: ImportOptions = { testImport: '../support/desktopTest', desktopImport: '../../../src/desktop', sourceName: 'x.vbs' };
    const files: Record<string, string> = {
      'sales_vbs.spec.ts': importEgScript(SCHEDULE_VBS, virtual).code,
      'sales_ps1.spec.ts': importEgScript(SCHEDULE_PS1, { ...virtual, sourceName: 'x.ps1' }).code,
      'idle.spec.ts': importEgScript('Set app = CreateObject("SASEGObjectModel.Application.7.1")\napp.Quit', virtual).code,
      'flow.spec.ts': importEgScript('Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet a = app.Open("C:\\a.egp", "")\na.ContainerCollection.Item("Main Flow").Run', virtual).code,
    };
    expect(typeCheck(files)).toEqual([]);
  });
});

test.describe('the generated test runs against the stand-in Enterprise Guide object model', () => {
  const run = async (script: string, options: ImportOptions = {}) => {
    let world: World | undefined;
    await runGenerated(importEgScript(script, { ...base, ...options }).code, { after: (w) => void (world = w) });
    return (world as World).fake.eg;
  };

  test('the VBScript and the PowerShell script open, run and save the project on the profile, and Enterprise Guide is quit', async () => {
    for (const [script, sourceName] of [[SCHEDULE_VBS, 'x.vbs'], [SCHEDULE_PS1, 'x.ps1']] as const) {
      const eg = await run(script, { sourceName });
      expect(eg.com.activeProfile).toBe('Dev SAS Server');
      expect(eg.com.openedPaths).toEqual(['C:\\Projects\\Sales.egp']);
      expect(eg.com.saved).toEqual(['C:\\Projects\\Sales.egp']);
      expect(eg.ran).toEqual(['project:C:\\Projects\\Sales.egp', 'program:Program', 'program:Summary']);
      expect(eg.com.quitCalls).toBe(1);
    }
  });

  test('one process flow is run by name', async () => {
    const eg = await run(`Set app = CreateObject("SASEGObjectModel.Application.8.3")\nSet prj = app.Open("C:\\Projects\\Sales.egp", "")\nprj.ContainerCollection.Item("Main Flow").Run\napp.Quit`);
    expect(eg.ran).toEqual(['flow:Main Flow', 'program:Program', 'program:Summary']);
  });

  test('NEGATIVE: a program that ended with a warning passes by default and FAILS with --fail-on-warnings; one that cannot be opened fails and still quits', async () => {
    await expect(run(SCHEDULE_VBS, { failOnWarnings: true })).rejects.toThrow(/Summary: Warning/);
    let quits = -1;
    await expect(
      runGenerated(importEgScript('Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet prj = app.Open("C:\\Missing.egp", "")\nprj.Run', base).code, { after: (w) => void (quits = w.fake.eg.com.quitCalls) }),
    ).rejects.toThrow(/could not be opened/);
    expect(quits).toBe(1); // the finally block ran
  });

  test('a version of the object model that is not installed fails with the driver\'s message (and SAS_EG_PROGID can say which one to use)', async () => {
    await expect(run(SCHEDULE_VBS.replace('7.1', '2.0'))).rejects.toThrow(/not registered|Enterprise Guide|2\.0/);
  });
});
