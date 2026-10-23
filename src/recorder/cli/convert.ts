#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { csvUtils } from '@automation/referenced-automation-utils';
import { RecordingFormatError, parseRecording, RECORDING_EXTENSION } from '../format';
import { convertRecording, DEFAULT_TAG, DEFAULT_TEST_IMPORT, hasAssertion, type ConvertOptions, type FixtureChoice } from '../generator';

export const CONVERT_USAGE = `sas-desktop-to-playwright - turn a recording of SAS Management Console / SAS Enterprise Guide into a Playwright test

Record first, then convert (inside this repo, after npm run build; note the -- before the arguments):

  node dist/recorder/cli/record.js --app eg --out recordings/run_project.sasrec.json
  node dist/recorder/cli/convert.js recordings/run_project.sasrec.json --expect-text "NOTE: " --out tests/desktop-generated

From a project that depends on this package the commands are linked into node_modules/.bin:

  npx sas-desktop-record --app eg --out recordings/run_project.sasrec.json
  npx sas-desktop-to-playwright recordings/run_project.sasrec.json --expect-text "NOTE: "

Usage:
  sas-desktop-to-playwright <file.sasrec.json | folder> [options]

Options:
  --out <file.ts|folder>   Where to write the spec(s): a .ts file name, or a folder (created if needed). Default: tests/desktop-generated.
  --test-import <module>   Module the spec imports desktopTest (as test) and desktopExpect (as expect) from. Default: ${DEFAULT_TEST_IMPORT}.
                           Point it at your own base test (a relative path) to add your project's fixtures.
  --desktop-import <mod>   Module that exports DesktopApp, DesktopLocator and WindowLocator by those names (for example ../../src/desktop).
                           Default: they are taken from the \`desktop\` namespace the package root exports.
  --tag <tag>              Tag added to the test title. Default: ${DEFAULT_TAG}.
  --name <text>            Base name of the test title, the pages file and the data file. Default: the recording's file name.
  --inline                 Write locators and values where they are used. By default the test starts with CONSTANTS (every typed value; secrets
                           as environment getters) and LOCATORS (every window and control, named once) and the steps only refer to them, so a
                           changed input or screen is one edit at the top. Ignored with --page-objects.
  --page-objects           One class per window or dialog, written to <out>/pages/<Name>Pages.ts (CONSTANTS and LOCATORS at its top),
                           and a test that uses them.
  --data                   Make every typed literal a column of <name>.data.csv and run one test per row (the first row holds what was recorded).
  --expect-text <text>     An assertion: at the end this text must be on the screen (in the main window). Repeatable.
  --expect-window <regex>  An assertion: at the end a window whose title matches this (case-insensitive) must be open.
                           Without --expect-text or --expect-window a converted test has NO assertion (a recording only performs steps): it ends
                           with a TODO and a guard that FAILS the test until you add one.
  --fixture <auto|app|loggedOn>
                           The fixture the test asks for. app: smcApp / egApp - the program launched, NOT logged on (a recording that includes the
                           logon). loggedOn: smcLoggedOn / egLoggedOn - logged on first. auto (default): app when the recording contains the logon
                           dialog or a password was typed, loggedOn when it does not.
  --allow-no-assertion     Leave the failing guard out (the TODO comment and the header note stay). For examples and spikes.
  --no-line-comments       Do not add "// event N" trace comments.
  --strict                 Exit 1 if anything needs a human: a TODO(manual) step, a control the recording only knows by screen position, or no
                           assertion option. Notes about what the converter did on purpose (a secret replaced by an environment read) do not count.
  -h, --help

A recording never contains a password: the converted test reads secrets from the environment (SAS_PASSWORD, SAS_PIN, SAS_OTP, SAS_TOKEN, ...).
NOT VERIFIED against the real programs: see docs/RECORD_AND_PLAY.md.
`;

interface Options extends ConvertOptions {
  input: string;
  out: string;
  strict: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { input: '', out: '', strict: false, expectText: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--out') opts.out = value();
    else if (arg === '--test-import') opts.testImport = value();
    else if (arg === '--desktop-import') opts.desktopImport = value();
    else if (arg === '--tag') opts.tag = value();
    else if (arg === '--name') opts.name = value();
    else if (arg === '--inline') opts.inline = true;
    else if (arg === '--page-objects') opts.pageObjects = true;
    else if (arg === '--data') opts.data = true;
    else if (arg === '--expect-text') (opts.expectText as string[]).push(value());
    else if (arg === '--expect-window') {
      opts.expectWindow = value();
      try {
        new RegExp(opts.expectWindow);
      } catch {
        throw new Error(`--expect-window must be a regular expression (found "${opts.expectWindow}")`);
      }
    } else if (arg === '--fixture') {
      const fixture = value();
      if (fixture !== 'auto' && fixture !== 'app' && fixture !== 'loggedOn') throw new Error(`--fixture must be auto, app or loggedOn (found "${fixture}")`);
      opts.fixture = fixture as FixtureChoice;
    } else if (arg === '--allow-no-assertion') opts.allowNoAssertion = true;
    else if (arg === '--no-line-comments') opts.lineComments = false;
    else if (arg === '--strict') opts.strict = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!opts.input) opts.input = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!opts.input) throw new Error('missing the recording (a .sasrec.json file or a folder of them)');
  if (opts.data && opts.inline) throw new Error('--data cannot be combined with --inline (the typed values have to live in the CSV file and CONSTANTS)');
  return opts;
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const stdio: CliIo = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) };

/** The converter as a function (the bin calls it with the process arguments). Returns the exit code: 0 done, 1 --strict found something or a recording is invalid, 2 usage. */
export function runConvertCli(argv: string[], io: CliIo = stdio): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.out(CONVERT_USAGE);
    return 0;
  }
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${CONVERT_USAGE}`);
    return 2;
  }
  let files: string[];
  try {
    files = fs.statSync(opts.input).isDirectory()
      ? fs
          .readdirSync(opts.input)
          .filter((f) => f.toLowerCase().endsWith(RECORDING_EXTENSION))
          .sort()
          .map((f) => path.join(opts.input, f))
      : [opts.input];
  } catch {
    io.err(`${opts.input} does not exist\n`);
    return 2;
  }
  if (files.length === 0) {
    io.err(`no ${RECORDING_EXTENSION} files in ${opts.input}\n`);
    return 2;
  }
  if (files.length > 1 && opts.name) {
    io.err('--name names one test: give one recording, not a folder\n');
    return 2;
  }
  const outDir = opts.out && !opts.out.endsWith('.ts') ? opts.out : opts.out ? path.dirname(opts.out) : 'tests/desktop-generated';
  let attention = 0;
  let failed = false;
  for (const file of files) {
    const base = path.basename(file).slice(0, -RECORDING_EXTENSION.length);
    const label = path.relative(process.cwd(), file).replace(/\\/g, '/');
    let recording;
    try {
      recording = parseRecording(fs.readFileSync(file, 'utf8'), label);
    } catch (error) {
      io.err(`${error instanceof RecordingFormatError ? error.message : (error as Error).message}\n`);
      failed = true;
      continue;
    }
    const { input: _input, out: _out, strict: _strict, ...conversion } = opts;
    void _input;
    void _out;
    void _strict;
    let result;
    try {
      result = convertRecording(recording, { ...conversion, sourceName: label, name: opts.name ?? base });
    } catch (error) {
      io.err(`${label}: ${(error as Error).message}\n`);
      failed = true;
      continue;
    }
    const specPath = files.length === 1 && opts.out.endsWith('.ts') ? opts.out : path.join(outDir, `${base}.spec.ts`);
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, result.spec);
    io.out(`${label}  ->  ${specPath}\n`);
    if (result.pages) {
      const pagesPath = path.join(path.dirname(specPath), 'pages', result.pages.fileName);
      fs.mkdirSync(path.dirname(pagesPath), { recursive: true });
      fs.writeFileSync(pagesPath, result.pages.code);
      io.out(`    pages: ${pagesPath} (${result.pages.classes.length} class(es): ${result.pages.classes.join(', ')})\n`);
    }
    if (result.data) {
      const dataPath = path.join(path.dirname(specPath), result.data.fileName);
      fs.writeFileSync(dataPath, csvUtils.toCsv(result.data.rows));
      io.out(`    data:  ${dataPath} (${Object.keys(result.data.rows[0] ?? {}).length} column(s); add a row per case)\n`);
    }
    if (result.envVars.length > 0) io.out(`    reads from the environment: ${result.envVars.join(', ')}\n`);
    io.out(`    session fixture: ${result.fixtureName}${result.logon ? ' (the recording contains the logon; it runs once and is never retried)' : ''}\n`);
    for (const warning of result.warnings) io.out(`    ${warning.severity === 'todo' ? 'TODO ' : ''}${warning.event !== undefined ? `event ${warning.event}: ` : ''}${warning.message}\n`);
    attention += result.todos;
    if (!hasAssertion(opts)) {
      attention += 1;
      io.out(`    no assertion: ${opts.allowNoAssertion ? 'add one (TODO in the file)' : 'the test fails until you add one (use --expect-text or --expect-window to generate it)'}\n`);
    }
  }
  if (failed) return 1;
  if (opts.strict && attention > 0) {
    io.err(`\n${attention} item(s) need attention (--strict).\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(runConvertCli(process.argv.slice(2)));
