import * as fs from 'node:fs';
import * as path from 'node:path';
import { csvUtils } from '@automation/referenced-automation-utils';
import { expect, test } from '@playwright/test';
import { convertRecording, importEgScript, parseRecording, type ConvertOptions, type ConvertResult, type Recording } from '../../src/recorder';
import { repoRoot } from './support/examples';
import { ev, rec, step, target } from './support/recordings';
import { runGenerated, VIRTUAL_DESKTOP, VIRTUAL_TEST, type World } from './support/runGenerated';
import { typeCheck } from './support/typeCheck';
import { tempDir } from '../core/support';
import { captureLogs } from '../desktop/support';

// The tests the converter writes are RUN (in-process, against the stand-in desktop) and TYPE-CHECKED, in every shape it has. A wrong locator, a wrong
// value, a bad import or a type error in the generated text fails here. The committed generated tests run under the normal runner too
// (tests/desktop-generated); this covers every option, not only the committed ones.

const load = (name: string): Recording => parseRecording(fs.readFileSync(path.join(repoRoot, 'examples', `${name}.sasrec.json`), 'utf8'), name);
const smc = load('smc_create_user');
const eg = load('eg_run_project');
const base: ConvertOptions = { testImport: VIRTUAL_TEST, desktopImport: VIRTUAL_DESKTOP };

function files(result: ConvertResult): Record<string, string> {
  const out: Record<string, string> = {};
  if (result.pages) out[`./pages/${result.pages.fileName.replace(/\.ts$/, '')}`] = result.pages.code;
  return out;
}

test.describe('generated tests run against the fake desktop', () => {
  test('Management Console, the default shape: logs on from the environment, opens the User Manager, creates the user - and the user is there', async () => {
    const result = convertRecording(smc, { ...base, expectText: ['AUTO_demo_user'], name: 'smc_create_user' });
    let users: string[] = [];
    const { titles, configured } = await runGenerated(result.spec, { after: (w: World) => void (users = [...w.fake.smc.options.users]) });
    expect(titles).toEqual(['recorded: smc_create_user @sas-desktop']);
    expect(users).toContain('AUTO_demo_user');
    expect(configured).toEqual([{ retries: 0 }]); // the recording logs on: never retried
  });

  test('Enterprise Guide, every shape: flat, inline, page objects - each logs on, opens the project with Ctrl+O and runs the program', async () => {
    for (const options of [{}, { inline: true }, { pageObjects: true }] as ConvertOptions[]) {
      const result = convertRecording(eg, { ...base, ...options, expectText: ['PROCEDURE MEANS'], name: 'eg' });
      let ran: string[] = [];
      let opened: string | undefined;
      const { titles } = await runGenerated(result.spec, {
        files: files(result),
        after: (w) => {
          ran = [...w.fake.eg.ran];
          opened = w.fake.eg.openProjectPath;
        },
      });
      expect(titles, JSON.stringify(options)).toEqual(['recorded: eg @sas-desktop']);
      expect(ran, JSON.stringify(options)).toEqual(['program:Summary']);
      expect(opened).toBe('C:\\Projects\\Sales.egp');
    }
  });

  test('the data-driven shape runs once per row of the CSV file, with the values of that row', async () => {
    const result = convertRecording(eg, { ...base, pageObjects: true, data: true, expectText: ['NOTE: '], name: 'eg' });
    const dir = tempDir();
    // two rows: the recorded one, and one that runs the other program of the project
    fs.writeFileSync(path.join(dir, 'eg.data.csv'), csvUtils.toCsv([...(result.data?.rows ?? []), { ...(result.data?.rows[0] ?? {}), mainFlowListItem: 'Program' }]));
    const ran: string[][] = [];
    const { titles } = await runGenerated(result.spec, { files: files(result), dir, after: (w) => void ran.push([...w.fake.eg.ran]) });
    expect(titles).toEqual(['recorded: eg @sas-desktop [row 1]', 'recorded: eg @sas-desktop [row 2]']);
    expect(ran).toEqual([['program:Summary'], ['program:Program']]);
  });

  test('a missing column in the CSV fails with the column\'s name', async () => {
    const result = convertRecording(eg, { ...base, pageObjects: true, data: true, expectText: ['x'], name: 'eg' });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'eg.data.csv'), 'other\nvalue\n');
    await expect(runGenerated(result.spec, { files: files(result), dir })).rejects.toThrow(/eg\.data\.csv has no column "fileNameField" - add it/);
  });

  test('the package-root import style works too: desktopTest and desktopExpect flat, the desktop namespace for the types', async () => {
    const result = convertRecording(eg, { expectText: ['PROCEDURE MEANS'] });
    expect(result.spec).toContain("from '@automation/referenced-automation-sas';");
    const { titles } = await runGenerated(result.spec);
    expect(titles).toHaveLength(1);
  });

  test('NEGATIVE: the same test fails when the program does not have the control, and the failure says what is on the screen', async () => {
    const result = convertRecording(smc, { ...base, expectText: ['AUTO_demo_user'] });
    const failure = await runGenerated(result.spec, { extras: false }).catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/no control matched .*New User\.\.\./);
    expect((failure as Error).message).toContain('On the screen now');
  });

  test('with a wrong password the account sees exactly ONE rejected attempt - the generated test never sends it twice - and the password is in no log', async () => {
    const result = convertRecording(eg, { ...base, expectText: ['NOTE: '] });
    const wrong = 'not-the-password-1';
    let attempts: Array<{ user: string; accepted: boolean }> = [];
    const captured = await captureLogs(() => runGenerated(result.spec, { env: { SAS_PASSWORD: wrong }, after: (w) => void (attempts = [...w.fake.eg.attempts]) }));
    expect(attempts).toEqual([{ user: expect.any(String), accepted: false }]);
    expect(captured.lines.join('\n')).not.toContain(wrong);
    expect(captured.lines.join('\n')).toContain('REDACTED'); // the typed password was logged as masked, not skipped silently
    expect(JSON.stringify(captured.error ?? {})).not.toContain(wrong);
  });

  test('NEGATIVE: an assertion that is not true fails; a recording with no assertion fails with the guard', async () => {
    const wrongText = convertRecording(eg, { ...base, expectText: ['THIS TEXT IS NEVER ON THE SCREEN'] });
    await expect(runGenerated(wrongText.spec)).rejects.toThrow(/toExist|on the screen/);
    const guarded = convertRecording(eg, { ...base });
    await expect(runGenerated(guarded.spec)).rejects.toThrow(/add an assertion: TODO\(converter\): no assertion/);
    const allowed = convertRecording(eg, { ...base, allowNoAssertion: true });
    await expect(runGenerated(allowed.spec)).resolves.toMatchObject({ titles: [expect.stringContaining('@sas-desktop')] });
  });

  test('a dialog the recording dismissed is dismissed by its handler (and stays open without it)', async () => {
    const connect = ev.click(target('SAS Enterprise Guide', step.button('Connect', { automationId: 'ConnectButton' })));
    const handled = convertRecording(rec([ev.opened('SAS Enterprise Guide'), ev.dialog('Tip of the Day', 'Close'), connect], 'eg'), { ...base, expectText: ['Connected'] });
    const unhandled = convertRecording(rec([ev.opened('SAS Enterprise Guide'), connect], 'eg'), { ...base, expectText: ['Connected'] });
    expect(handled.fixtureName).toBe('egLoggedOn'); // no logon in the recording: the fixture logs on
    const tipOpen = async (source: string): Promise<boolean> => {
      let open = true;
      await runGenerated(source, { after: (w) => void (open = w.fake.desktop.windows.some((x) => x.name === 'Tip of the Day')) });
      return open;
    };
    expect(await tipOpen(handled.spec)).toBe(false);
    expect(await tipOpen(unhandled.spec)).toBe(true);
  });
});

test.describe('generated tests compile', () => {
  test('every shape type-checks under the repository\'s strict TypeScript settings', () => {
    const virtualBase: ConvertOptions = { testImport: '../support/desktopTest', desktopImport: '../../../src/desktop' };
    const variants: Array<[string, Recording, ConvertOptions]> = [
      ['smc_flat', smc, { expectText: ['AUTO_demo_user'] }],
      ['eg_inline', eg, { inline: true, expectText: ['x'] }],
      ['eg_pages', eg, { pageObjects: true, expectText: ['x'] }],
      ['eg_data', eg, { pageObjects: true, data: true, expectText: ['x'] }],
      ['eg_flat_data', eg, { data: true, expectText: ['x'] }],
      ['eg_no_assertion', eg, {}],
      ['eg_window', eg, { expectWindow: 'Sales' }],
    ];
    const all: Record<string, string> = {};
    for (const [name, recording, options] of variants) {
      const result = convertRecording(recording, { ...virtualBase, ...options, name });
      all[`${name}.spec.ts`] = result.spec;
      if (result.pages) all[`pages/${result.pages.fileName}`] = result.pages.code;
    }
    expect(typeCheck(all)).toEqual([]);
  });

  test('so does the default import style: the package root (src/index.ts) exports desktopTest and desktopExpect flat, and the desktop namespace for the types', () => {
    const result = convertRecording(eg, { expectText: ['x'], name: 'root_style' });
    const pages = convertRecording(eg, { expectText: ['x'], pageObjects: true, name: 'root_pages' });
    const smcResult = convertRecording(smc, { expectText: ['x'], name: 'root_smc' });
    const eguide = importEgScript('Set app = CreateObject("SASEGObjectModel.Application.7.1")\nSet prj = app.Open("C:\\a.egp", "")\nprj.Run\napp.Quit', { name: 'root_import', sourceName: 'x.vbs' });
    const diagnostics = typeCheck({
      'root_style.spec.ts': result.spec,
      'root_smc.spec.ts': smcResult.spec,
      'root_pages.spec.ts': pages.spec,
      [`pages/${pages.pages?.fileName}`]: pages.pages?.code ?? '',
      'root_import.spec.ts': eguide.code,
    });
    expect(diagnostics).toEqual([]);
  });

  test('NEGATIVE: the type checker does catch a type error in generated text (so a clean result means something)', () => {
    const result = convertRecording(eg, { testImport: '../support/desktopTest', desktopImport: '../../../src/desktop', expectText: ['x'], name: 'broken' });
    const broken = result.spec.replace("({ egApp: app })", '({ egApp: app, nothere })');
    expect(typeCheck({ 'broken.spec.ts': broken }).join('\n')).toMatch(/nothere/);
  });
});
