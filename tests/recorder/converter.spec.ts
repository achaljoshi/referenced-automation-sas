import { expect, test } from '@playwright/test';
import { convertRecording, hasAssertion, NO_ASSERTION_TODO, type ConvertOptions } from '../../src/recorder';
import { ev, rec, step, target } from './support/recordings';

const MAIN = 'SAS Enterprise Guide';
const main = (...path: Parameters<typeof target>[1][]) => target(MAIN, ...path);
const logonWindow = 'SAS Logon';
const user = target(logonWindow, step.edit('User ID:', { automationId: 'userIdField' }));
const pass = target(logonWindow, step.edit('Password:', { automationId: 'passwordField' }));
const logonOk = target(logonWindow, step.button('OK'));
const run = main(step.button('Run', { automationId: 'RunButton' }));

const typedSecret = 'hunter2-Zq9!';
const convert = (events: Parameters<typeof rec>[0], options: ConvertOptions = {}, app = 'eg') => convertRecording(rec(events, app), { expectText: ['Done'], ...options });
const steps = (spec: string) => spec.split('\n').filter((l) => /^\s+(await|app\.onDialog|\/\/ TODO)/.test(l));

test.describe('the shape of a generated test (the default)', () => {
  const result = convert([ev.opened(MAIN), ev.text(user, 'sasdemo'), ev.click(run), ev.click(main(step.button('Stop')))], { sourceName: 'recordings/x.sasrec.json' });
  const { spec } = result;

  test('starts with the imports, then CONSTANTS, then LOCATORS, then the header, then the test - and the steps only refer to them', () => {
    const at = (text: string) => spec.indexOf(text);
    expect(at("import { desktopTest as test, desktopExpect as expect } from '@automation/referenced-automation-sas';")).toBe(0);
    expect(at('const CONSTANTS = {')).toBeGreaterThan(0);
    expect(at('const LOCATORS = {')).toBeGreaterThan(at('const CONSTANTS = {'));
    expect(at('/**\n * Converted from')).toBeGreaterThan(at('const LOCATORS = {'));
    expect(at("test('recorded:")).toBeGreaterThan(at('/**\n * Converted from'));
    const body = steps(spec).filter((l) => !l.includes('expect(')).join('\n');
    expect(body).toContain('LOCATORS.');
    expect(body).toContain('CONSTANTS.inputs.');
    expect(body).not.toMatch(/'sasdemo'|getBy|app\.window/); // no id, name or typed value is left in a step
  });

  test('every control is named once, in LOCATORS, with its window; steps are numbered after the events they came from', () => {
    expect(spec).toContain("mainWindow: (app: DesktopApp): WindowLocator => app.window(/^SAS Enterprise Guide$/i),");
    expect(spec).toContain("runButton: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByAutomationId('RunButton').orElse(LOCATORS.mainWindow(app).getByRole('Button', { name: 'Run' })),");
    expect(spec.match(/runButton:/g)).toHaveLength(1);
    expect(spec).toContain('await LOCATORS.runButton(app).click(); // event 3');
    expect(result.windows).toEqual(['sasLogonWindow', 'mainWindow']); // in the order the steps use them
  });

  test('the header names the recording, what it reads, the session, and that nothing waits', () => {
    expect(spec).toContain(' * Converted from recordings/x.sasrec.json by sas-desktop-to-playwright.');
    expect(spec).toContain(' * Review before committing:');
    expect(spec).toMatch(/ \* {2}- reads SAS_USER from the environment/);
    expect(spec).toContain(' *  - no waits are needed: every step waits for its control to exist and for the program to go idle');
    expect(spec).toContain(' *  - session: egLoggedOn (the recording has no logon)');
  });

  test('the test is tagged and titled; the fixture is destructured as app', () => {
    expect(spec).toContain("test('recorded: x @sas-desktop', async ({ egLoggedOn: app }) => {");
    expect(convert([ev.click(run)], { tag: '@nightly', name: 'My flow' }).spec).toContain("test('recorded: My flow @nightly'");
  });

  test('the type imports are the namespace of the package root by default, flat names with --desktop-import, none when inline', () => {
    expect(spec).toContain("import type { desktop } from '@automation/referenced-automation-sas';\ntype DesktopApp = desktop.DesktopApp;\ntype DesktopLocator = desktop.DesktopLocator;\ntype WindowLocator = desktop.WindowLocator;");
    const flat = convert([ev.click(run)], { desktopImport: '../../src/desktop', testImport: './support/sasTest' }).spec;
    expect(flat).toContain("import type { DesktopApp, DesktopLocator, WindowLocator } from '../../src/desktop';");
    expect(flat).toContain("from './support/sasTest';");
    expect(convert([ev.click(run)], { inline: true }).spec).not.toContain('import type');
  });

  test('no sleeps, in any shape', () => {
    for (const options of [{}, { inline: true }, { pageObjects: true }, { data: true }]) {
      const out = convert([ev.text(user, 'x'), ev.click(run)], options);
      for (const code of [out.spec, out.pages?.code ?? '']) expect(code).not.toMatch(/waitForTimeout|setTimeout|sleep\(|Thread|networkidle/i);
    }
  });
});

test.describe('values and secrets', () => {
  test('typed values are CONSTANTS, named after their control; the same value into the same control is one entry, another value another', () => {
    const { spec } = convert([ev.text(main(step.edit('Name:')), 'alpha'), ev.text(main(step.edit('Name:')), 'alpha'), ev.text(main(step.edit('Name:')), 'beta')]);
    expect(spec).toContain("nameField: 'alpha',");
    expect(spec).toContain("nameField2: 'beta',");
    expect(spec.match(/nameField: 'alpha'/g)).toHaveLength(1);
    expect(steps(spec).filter((l) => l.includes('CONSTANTS.inputs.nameField)'))).toHaveLength(2);
    expect(spec).toContain("expected: {\n    doneText: 'Done',");
  });

  test('an empty value is written as an empty string (not a constant)', () => {
    const { spec } = convert([ev.text(main(step.edit('Name:')), '')]);
    expect(spec).toContain(".fill('')");
    expect(spec).not.toContain('inputs: {');
  });

  test('a SECRET is read from the environment by its kind and is never written, in any shape', () => {
    for (const [kind, variable] of [['password', 'SAS_PASSWORD'], ['pin', 'SAS_PIN'], ['otp', 'SAS_OTP'], ['token', 'SAS_TOKEN'], ['secret', 'SAS_SECRET'], ['key', 'SAS_API_KEY']] as const) {
      for (const options of [{}, { inline: true }, { pageObjects: true }, { pageObjects: true, data: true }]) {
        const result = convert([ev.secret(main(step.edit('Field')), 'blur', kind)], options);
        const all = [result.spec, result.pages?.code ?? ''].join('\n');
        expect(all, `${kind} ${JSON.stringify(options)}`).toContain(`env.get('${variable}')`);
        expect(result.envVars).toEqual([variable]);
        expect(all).not.toContain(typedSecret);
        expect(JSON.stringify(result.data ?? {})).not.toContain('Field');
      }
    }
    const { spec } = convert([ev.secret(pass, 'enter')]);
    expect(spec).toContain('get passwordField() {\n      return env.get(\'SAS_PASSWORD\');\n    },');
    expect(spec).toContain("fill(CONSTANTS.inputs.passwordField, { secret: true }); // event 1");
    expect(spec).toContain("press('{ENTER}')");
    expect(spec).toContain('const env = loadEnv();');
    expect(spec).toContain("import { loadEnv } from '@automation/referenced-automation-utils';");
  });

  test('a secret entry the bridge did not label gets the kind its field name says, and password when nothing says', () => {
    expect(convert([ev.secret(main(step.edit('Your PIN')))]).envVars).toEqual(['SAS_PIN']);
    expect(convert([ev.secret(main(step.edit('Whatever')))]).envVars).toEqual(['SAS_PASSWORD']);
  });

  test('no environment, no env: a test that reads nothing does not import loadEnv', () => {
    const { spec, envVars } = convert([ev.click(run)]);
    expect(envVars).toEqual([]);
    expect(spec).not.toContain('loadEnv');
  });

  test('the user ID in a logon window is read from SAS_USER (nothing personal is stored); another "Name" field is a plain value', () => {
    const { spec, envVars } = convert([ev.opened(logonWindow), ev.text(user, 'ajoshi')]);
    expect(envVars).toEqual(['SAS_USER']);
    expect(spec).not.toContain('ajoshi');
    expect(convert([ev.text(main(step.edit('User ID:')), 'plain')]).spec).toContain("userIdField: 'plain'");
  });

  test('the profile chosen in a profile dialog is read from the program\'s profile variable; for an unknown program it is a plain value', () => {
    const list = target('Select Profile', step.list('Profiles'));
    expect(convert([ev.select(list, 'Dev SAS Server')], {}, 'eg')).toMatchObject({ envVars: ['SAS_EG_PROFILE'] });
    expect(convert([ev.select(list, 'Dev Metadata Server')], {}, 'smc')).toMatchObject({ envVars: ['SAS_SMC_PROFILE'] });
    const unknown = convert([ev.select(list, 'Dev')], {}, 'Other Program');
    expect(unknown.envVars).toEqual([]);
    expect(unknown.spec).toContain("profilesListItem: 'Dev'");
    expect(convert([ev.select(list, 'Dev SAS Server')], {}, 'eg').spec).not.toContain('Dev SAS Server');
  });

  test('strings with quotes, backslashes and line breaks are escaped so they cannot break the generated code', () => {
    const { spec } = convert([ev.text(main(step.edit('Path:')), "C:\\temp\\it's\nnext")]);
    expect(spec).toContain("pathField: 'C:\\\\temp\\\\it\\'s\\nnext',");
  });
});

test.describe('the session fixture', () => {
  const logonEvents = [ev.opened('Select Profile'), ev.select(target('Select Profile', step.list('Profiles')), 'Dev'), ev.opened(logonWindow), ev.secret(pass), ev.click(logonOk)];

  test('auto: a recording without a logon asks for the logged-on fixture, one with a logon dialog or a typed password asks for the one that is not', () => {
    expect(convert([ev.click(run)]).fixtureName).toBe('egLoggedOn');
    expect(convert([ev.click(run)], {}, 'smc').fixtureName).toBe('smcLoggedOn');
    expect(convert(logonEvents).fixtureName).toBe('egApp');
    expect(convert([ev.opened(logonWindow), ev.click(logonOk)]).fixtureName).toBe('egApp'); // the dialog alone
    expect(convert([ev.secret(pass), ev.click(run)]).fixtureName).toBe('egApp'); // the password alone
    expect(convert([ev.secret(main(step.edit('New PIN'))), ev.click(run)]).fixtureName).toBe('egLoggedOn'); // a PIN changed inside the program is not a logon
    expect(convert([ev.dialog('SAS Logon', 'OK')]).logon).toBe(true);
    expect(convert(logonEvents, {}, 'smc').fixtureName).toBe('smcApp');
  });

  test('a recording that logs on runs the logon once and switches retries off: a rejected password is never sent twice', () => {
    const { spec, logon } = convert(logonEvents);
    expect(logon).toBe(true);
    expect(spec).toContain('test.describe.configure({ retries: 0 });');
    expect(spec).toContain('never retried');
    expect(spec).toContain('({ egApp: app })');
    expect(convert([ev.click(run)]).spec).not.toContain('retries');
  });

  test('--fixture overrides; a wrong choice is a TODO, a harmless one a note', () => {
    expect(convert([ev.click(run)], { fixture: 'app' }).fixtureName).toBe('egApp');
    expect(convert([ev.click(run)], { fixture: 'app' }).warnings).toContainEqual(expect.objectContaining({ severity: 'info', message: expect.stringMatching(/no logon.*not logged on/) }));
    const wrong = convert(logonEvents, { fixture: 'loggedOn' });
    expect(wrong.fixtureName).toBe('egLoggedOn');
    expect(wrong.warnings).toContainEqual(expect.objectContaining({ severity: 'todo', message: expect.stringMatching(/logs on itself/) }));
    expect(wrong.todos).toBe(1);
  });

  test('a program the framework has no fixture for is a TODO that names the fixtures the test asks for', () => {
    const result = convert([ev.click(run)], {}, 'Data Integration Studio');
    expect(result.fixtureName).toBe('dataIntegrationStudioLoggedOn');
    expect(result.todos).toBe(1);
    expect(result.warnings[0]?.message).toMatch(/no fixture for: the test asks for dataIntegrationStudioApp \/ dataIntegrationStudioLoggedOn/);
  });
});

test.describe('assertions (until there is one, the test fails)', () => {
  const events = [ev.click(run)];

  test('without any: a TODO, a guard that throws, a note in the header, and `expect` kept used', () => {
    const { spec, hasAssertion: has } = convertRecording(rec(events), {});
    expect(has).toBe(false);
    expect(spec).toContain(`// ${NO_ASSERTION_TODO}`);
    expect(spec).toContain(`throw new Error('add an assertion: ${NO_ASSERTION_TODO}');`);
    expect(spec).toContain(' *  - NO ASSERTION:');
    expect(spec).toContain('It ends with a guard that fails until you add one.');
    expect(spec).toContain('void expect;');
    expect(spec.indexOf('click(); // event 1')).toBeLessThan(spec.indexOf('throw new Error'));
  });

  test('--allow-no-assertion keeps the TODO and the note but not the guard', () => {
    const { spec } = convertRecording(rec(events), { allowNoAssertion: true });
    expect(spec).toContain('TODO(converter): no assertion');
    expect(spec).not.toContain('throw new Error');
    expect(spec).toContain('Add one.');
  });

  test('--expect-text and --expect-window write the assertion instead: no TODO, no guard', () => {
    const { spec, hasAssertion: has } = convertRecording(rec(events), { expectText: ['PROCEDURE MEANS', 'NOTE: '], expectWindow: 'Sales' });
    expect(has).toBe(true);
    expect(spec).not.toContain('TODO(converter)');
    expect(spec).not.toContain('throw new Error');
    expect(spec).toContain('await expect(LOCATORS.mainWindow(app).getByText(CONSTANTS.expected.procedureMeansText).first()).toExist();');
    expect(spec).toContain("expected: {\n    procedureMeansText: 'PROCEDURE MEANS',\n    noteText: 'NOTE: ',");
    expect(spec).toContain('await expect(app.window(/Sales/i)).toExist();');
    expect(hasAssertion({})).toBe(false);
    expect(hasAssertion({ expectWindow: 'x' })).toBe(true);
  });

  test('the text is looked for in the main window - the one still open at the end - not in a dialog that closed', () => {
    const { spec } = convert([ev.opened(MAIN), ev.opened('Notice', { owned: true }), ev.click(main(step.button('Go'))), ev.closed('Notice')], { expectText: ['Done'] });
    expect(spec).toContain('LOCATORS.mainWindow(app).getByText(CONSTANTS.expected.doneText)');
  });

  test('a pattern that is not a regular expression is refused now, not when the test runs', () => {
    expect(() => convertRecording(rec(events), { expectWindow: '(' })).toThrow();
  });
});

test.describe('what the converter cannot do is a TODO(manual) that names the event', () => {
  test('a control known only by a screen position: the step is a comment, the warning is a todo, --strict will count it', () => {
    const blind = { ...main({ controlType: 'Pane' }), fallbackPoint: { x: 212, y: 340 } };
    const result = convert([ev.click(run), ev.click(blind), ev.text(blind, 'x'), ev.select(blind, 'a'), ev.toggle(blind, true), ev.expand(blind), ev.doubleClick(blind)]);
    const todos = result.spec.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('// TODO(manual'));
    expect(todos).toHaveLength(6);
    expect(todos[0]).toBe('// TODO(manual, event 2): click on Pane in window "SAS Enterprise Guide" - the recording only has a screen position (212, 340) in the window.');
    expect(result.spec).toContain('//   Find the control with sas-desktop-inspect');
    expect(result.todos).toBe(6);
    expect(result.warnings.filter((w) => w.severity === 'todo').map((w) => w.event)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(steps(result.spec).filter((l) => l.startsWith('  await'))).toHaveLength(2); // the Run click and the assertion
  });

  test('a chord SendKeys cannot send, and an ambiguous control, are TODOs too', () => {
    const win = convert([ev.key('Win+R', MAIN)]);
    expect(win.spec).toContain('// TODO(manual, event 1): press Win+R - SendKeys cannot send that chord.');
    const ambiguous = convert([ev.click({ ...main(step.button('OK')), unique: { nameAndType: false } })]);
    expect(ambiguous.todos).toBe(1);
    expect(ambiguous.spec).toMatch(/event 1: .*matches more than one control/);
  });

  test('a locator that is only a class and a position is listed as a note (not a TODO), so it can be reviewed', () => {
    const result = convert([ev.click(main({ controlType: 'Edit', className: 'JTextField', index: 3 }))]);
    expect(result.todos).toBe(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({ event: 1, severity: 'info', message: expect.stringMatching(/class and position only/) }));
    expect(result.spec).toContain(".locator({ controlType: 'Edit', className: 'JTextField' }).nth(3)");
    expect(result.spec).toContain(' *  - event 1: found by class and position only');
  });
});

test.describe('each kind of step', () => {
  const list = main(step.list('Process Flow'));
  const tree = main({ controlType: 'Tree', name: 'Navigation' });
  const out = convert([
    ev.click(run),
    ev.doubleClick(main(step.item('Summary'))),
    ev.rightClick(main(step.item('Summary'))),
    ev.select(list, 'Program', 'Summary'),
    ev.select(tree, 'Users'),
    ev.toggle(main(step.check('Open results')), true),
    ev.toggle(main(step.check('Open results')), false),
    ev.expand(main(step.node('Environment'))),
    ev.collapse(main(step.node('Environment'))),
    ev.key('Ctrl+S', MAIN),
    ev.key('F5', MAIN),
    ev.key('Alt+F4', MAIN),
    ev.key('Escape', MAIN, run),
    ev.menu(MAIN, 'File', 'Open'),
  ]).spec;

  test('click, double click, right click', () => {
    expect(out).toContain('await LOCATORS.runButton(app).click(); // event 1');
    expect(out).toContain('await LOCATORS.summaryItem(app).doubleClick(); // event 2');
    expect(out).toContain('await LOCATORS.summaryItem(app).rightClick(); // event 3');
  });

  test('selecting in a list, tree, tab strip: the item role by the container, more than one item adds to the selection', () => {
    expect(out).toContain("await LOCATORS.processFlowList(app).getByRole('ListItem', { name: CONSTANTS.inputs.processFlowListItem }).select(); // event 4");
    expect(out).toContain("await LOCATORS.processFlowList(app).getByRole('ListItem', { name: CONSTANTS.inputs.processFlowListItem2 }).select({ add: true }); // event 4");
    expect(out).toContain("processFlowListItem: 'Program',");
    expect(out).toContain("processFlowListItem2: 'Summary',");
    expect(out).toContain("await LOCATORS.navigationTree(app).getByRole('TreeItem', { name: CONSTANTS.inputs.navigationTreeItem }).select(); // event 5");
    const unknown = convert([ev.select(main({ controlType: 'Custom', name: 'Things' }), 'One')]).spec;
    expect(unknown).toContain(".getByName(CONSTANTS.inputs.thingsItem).select();");
  });

  test('toggles are setChecked with the state, expand and collapse are themselves', () => {
    expect(out).toContain('await LOCATORS.openResultsCheckbox(app).setChecked(true); // event 6');
    expect(out).toContain('await LOCATORS.openResultsCheckbox(app).setChecked(false); // event 7');
    expect(out).toContain('await LOCATORS.environmentNode(app).expand(); // event 8');
    expect(out).toContain('await LOCATORS.environmentNode(app).collapse(); // event 9');
  });

  test('keys are SendKeys syntax: shortcuts on the window, named keys on the control that had the focus when there was one', () => {
    expect(out).toContain("await LOCATORS.mainWindow(app).press('^s'); // event 10");
    expect(out).toContain("await LOCATORS.mainWindow(app).press('{F5}'); // event 11");
    expect(out).toContain("await LOCATORS.mainWindow(app).press('%{F4}'); // event 12");
    expect(out).toContain("await LOCATORS.runButton(app).press('{ESC}'); // event 13");
  });

  test('a menu path is one click per item, found by name; the note says popups may need checking once', () => {
    expect(out).toContain("await LOCATORS.fileMenu(app).click(); // event 14");
    expect(out).toContain("await LOCATORS.openMenu(app).click(); // event 14");
    expect(out).toContain("fileMenu: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app).getByRole('MenuItem', { name: 'File' }),");
    expect(out).toContain('menu items are looked for inside the window');
  });
});

test.describe('names and windows', () => {
  test('a document name in front of the product name is the same window: one locator for "SAS Enterprise Guide" and "Sales - SAS Enterprise Guide"', () => {
    const { spec, windows } = convert([ev.opened(MAIN), ev.click(run), ev.click(target('Sales - SAS Enterprise Guide', step.button('Stop')))]);
    expect(windows).toEqual(['mainWindow']);
    expect(spec).toContain('app.window(/^(.+ - )?SAS Enterprise Guide$/i)');
    expect(spec).not.toContain('Sales - SAS');
  });

  test('two controls with the same name in different windows get different keys; the same control twice shares one', () => {
    const { spec } = convert([ev.click(target('First', step.button('OK'))), ev.click(target('Second', step.button('OK'))), ev.click(target('Second', step.button('OK'))), ev.click(target('Third', step.button('OK')))]);
    expect(spec).toContain('okButton: (app: DesktopApp): DesktopLocator => LOCATORS.mainWindow(app)'); // the first window of the recording is the main one
    expect(spec).toContain('secondOkButton: (app: DesktopApp): DesktopLocator => LOCATORS.secondWindow(app)');
    expect(spec).toContain('thirdOkButton:');
    expect(spec.match(/secondOkButton:/g)).toHaveLength(1);
    expect(steps(spec).filter((l) => l.includes('secondOkButton'))).toHaveLength(2);
  });

  test('a control named by punctuation or digits only, or with no name, still gets a usable key', () => {
    const { spec } = convert([ev.click(main({ controlType: 'Button', name: '...' })), ev.click(main({ controlType: 'Edit', className: 'JTextField', index: 4 })), ev.click(main({ controlType: 'Button', automationId: '1148' }))]);
    expect(spec).toContain('  button0: (app');
    expect(spec).toContain('  edit4: (app');
    expect(spec).toContain('  _1148Button: (app');
  });

  test('reserved words and the names the file uses itself cannot become keys', () => {
    const { spec } = convert([ev.click(main({ name: 'Default' })), ev.click(main({ name: 'Data' })), ev.click(main({ name: 'window' }))]);
    expect(spec).toContain('default_: (app');
    expect(spec).toContain('data_: (app');
    expect(spec).toContain('window_: (app');

  });
});

test.describe('dialogs the recording dismissed', () => {
  const events = [ev.opened(MAIN), ev.dialog('Tip of the Day', 'Close'), ev.click(run), ev.dialog('Tip of the Day', 'Close')];

  test('are handlers registered at the top of the test, once each, with the title and the button in CONSTANTS', () => {
    const { spec } = convert(events);
    const body = steps(spec);
    expect(body[0]).toBe("  app.onDialog(CONSTANTS.dialogs.tipOfTheDay.title, (dialog) => dialog.getByRole('Button', { name: CONSTANTS.dialogs.tipOfTheDay.button }).click(), { name: 'tipOfTheDay' });");
    expect(spec).toContain("tipOfTheDay: { title: /^Tip of the Day$/i, button: 'Close' },");
    expect(spec).toContain('tipOfTheDay2: { title: /^Tip of the Day$/i, button: \'Close\' },');
    expect(body.filter((l) => l.includes('onDialog'))).toHaveLength(2);
    expect(body.indexOf(body.find((l) => l.includes('runButton')) as string)).toBeGreaterThan(1);
    expect(spec).toContain(' *  - event 2: the "Tip of the Day" dialog is handled by a handler registered at the top of the test (button "Close")');
  });

  test('inline, the handler carries its own regular expression and button', () => {
    expect(convert(events, { inline: true }).spec).toContain("app.onDialog(/^Tip of the Day$/i, (dialog) => dialog.getByRole('Button', { name: 'Close' }).click(), { name: 'tipOfTheDay' });");
  });
});

test.describe('--inline', () => {
  test('writes locators and values where they are used: no CONSTANTS, no LOCATORS', () => {
    const { spec } = convert([ev.text(user, 'x'), ev.secret(pass), ev.select(target('Select Profile', step.list('Profiles')), 'Dev SAS Server'), ev.click(run), ev.key('Ctrl+O', MAIN)], { inline: true });
    expect(spec).not.toContain('CONSTANTS');
    expect(spec).not.toContain('LOCATORS');
    expect(spec).toContain("await app.window(/^SAS Logon$/i).getByAutomationId('userIdField').orElse(app.window(/^SAS Logon$/i).getByRole('Edit', { name: 'User ID:' })).fill(env.get('SAS_USER')); // event 1");
    expect(spec).toContain("fill(env.get('SAS_PASSWORD'), { secret: true })");
    expect(spec).toContain(".select(); // event 3");
    expect(spec).toContain("await app.window(/^SAS Enterprise Guide$/i).press('^o'); // event 5");
    expect(spec).toContain("fill(env.get('SAS_USER'))");
  });

  test('cannot be combined with --data', () => {
    expect(() => convertRecording(rec([ev.click(run)]), { inline: true, data: true })).toThrow(/--data needs the CONSTANTS/);
  });
});

test.describe('--page-objects', () => {
  const events = [ev.opened(MAIN), ev.text(user, 'ajoshi'), ev.click(logonOk), ev.click(run), ev.dialog('Tip of the Day', 'Close'), ev.key('Ctrl+S', MAIN)];
  const result = convert(events, { pageObjects: true, sourceName: 'x/y.sasrec.json' });

  test('writes a pages file with CONSTANTS, LOCATORS and one class per window, and a test that only uses them', () => {
    expect(result.pages?.fileName).toBe('YPages.ts');
    const pages = result.pages?.code ?? '';
    expect(pages.indexOf('export const CONSTANTS')).toBeLessThan(pages.indexOf('export const LOCATORS'));
    expect(pages.indexOf('export const LOCATORS')).toBeLessThan(pages.indexOf('export class'));
    expect(result.pages?.classes).toEqual(['SasLogonPage', 'MainPage']);
    expect(pages).toContain('export class SasLogonPage {\n  constructor(readonly app: DesktopApp) {}');
    expect(pages).toContain('get userIdField(): DesktopLocator {\n    return LOCATORS.userIdField(this.app);\n  }');
    expect(pages).toContain('async waitUntilDisplayed(timeout?: number): Promise<SasLogonPage> {');
    expect(result.spec).toContain("import { CONSTANTS, SasLogonPage, MainPage } from './pages/YPages';");
    expect(result.spec).toContain('const sasLogonPage = new SasLogonPage(app);');
    expect(result.spec).toContain('await sasLogonPage.userIdField.fill(CONSTANTS.inputs.userIdField); // event 2');
    expect(result.spec).toContain("await mainPage.window.press('^s'); // event 6");
    expect(steps(result.spec).filter((l) => l.includes('await') && !l.includes('expect(')).join('\n')).not.toMatch(/LOCATORS|getBy/);
    expect(result.spec).toContain('(page-object mode)');
    expect(result.spec).toContain('./pages/YPages.ts: change them there');
  });

  test('the test imports only what it uses; the pages file brings its own env and types; handlers go through CONSTANTS', () => {
    const pages = result.pages?.code ?? '';
    expect(pages).toContain("import { loadEnv } from '@automation/referenced-automation-utils';");
    expect(pages).toContain('const env = loadEnv();');
    expect(result.spec).not.toContain('loadEnv');
    expect(result.spec).toContain('app.onDialog(CONSTANTS.dialogs.tipOfTheDay.title');
    expect(pages).toContain("tipOfTheDay: { title: /^Tip of the Day$/i, button: 'Close' },");
    const noConstants = convertRecording(rec([ev.click(run)]), { pageObjects: true, expectWindow: 'x' });
    expect(noConstants.spec).toContain("import { MainPage } from './pages/");
  });

  test('--desktop-import is re-based for the pages file, which sits one folder below the test', () => {
    const rebased = convert(events, { pageObjects: true, sourceName: 'x/y.sasrec.json', desktopImport: '../../src/desktop' });
    expect(rebased.pages?.code).toContain("from '../../../src/desktop';");
    expect(convert(events, { pageObjects: true, desktopImport: '@org/desktop' }).pages?.code).toContain("from '@org/desktop';");
    expect(convert(events, { pageObjects: true, desktopImport: './desktop' }).pages?.code).toContain("from '../desktop';");
  });
});

test.describe('--data', () => {
  const events = [ev.text(user, 'ajoshi'), ev.text(main(step.edit('Name:')), 'Alice'), ev.text(main(step.edit('Name:')), 'Bob'), ev.secret(pass), ev.select(main(step.list('Flows')), 'Main'), ev.click(run)];

  test('every typed literal is a column of the data file (the recorded values in the first row); secrets and the user are not', () => {
    for (const pageObjects of [false, true]) {
      const result = convert(events, { data: true, pageObjects, name: 'flow' });
      expect(result.data).toEqual({ fileName: 'flow.data.csv', rows: [{ nameField: 'Alice', nameField2: 'Bob', flowsListItem: 'Main' }] });
      const all = [result.spec, result.pages?.code ?? ''].join('\n');
      expect(all).not.toContain('Alice');
      expect(all).not.toContain('ajoshi');
      expect(all).toContain("field(data, 'nameField2')");
      expect(all).toContain("csvUtils.parseCsvFile(path.join(__dirname, 'flow.data.csv'))");
      expect(result.spec).toContain('for (const [index, data] of rows.entries()) {');
      expect(result.spec).toContain('recorded: flow @sas-desktop [row ${index + 1}]');
      expect(result.spec).toContain('one test runs per row of flow.data.csv');
      expect(result.spec).toMatch(/import \{ csvUtils(, loadEnv)? \} from '@automation\/referenced-automation-utils';/);
    }
  });

  test('a missing column fails with its name, not a silent undefined', () => {
    expect(convert(events, { data: true }).spec).toContain('has no column "${column}" - add it');
  });
});

test.describe('line comments', () => {
  test('can be switched off', () => {
    expect(convert([ev.click(run)], { lineComments: false }).spec).not.toContain('// event');
    expect(convert([ev.click(run)]).spec).toContain('// event 1');
  });
});

test('events that are only information (window opened, closed, activated) make no step', () => {
  const { spec } = convert([ev.opened(MAIN), { type: 'windowActivated', title: MAIN }, ev.closed('Other')]);
  expect(steps(spec).filter((l) => l.startsWith('  await'))).toHaveLength(1); // only the assertion
});
