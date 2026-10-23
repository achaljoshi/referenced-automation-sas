import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * .env.example is the ONE authoritative reference for every setting, so it must never drift from the code: a variable the code reads
 * that .env.example does not list, or a variable it lists that nothing reads, fails this test - and so do a missing explanation, a secret
 * that is not marked as one, a default that is not the code's default, a README table that disagrees, and documentation that names a
 * setting that does not exist. (The scanner itself is tested at the end with made-up sources, so it cannot silently stop finding things.)
 */
const root = path.resolve(__dirname, '..');
const utils = path.join(root, 'node_modules/@automation/referenced-automation-utils/dist');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file: string) => fs.existsSync(path.join(root, file));

// ------------------------------------------------------------------------------------------------------------ the scanner

const READ_NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{2,}';
/** Quoted names that are error codes, not settings. */
const NOT_SETTINGS = new Set(['BRIDGE_EXITED']);

/** The environment variables a piece of source code reads. `SAS_${app}_USER` is the template `SAS_<APP>_USER`. */
export function namesRead(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(new RegExp(`\\.(?:get|getOptional|getBoolean|getInt|getList|has)\\(\\s*(['"\`])(${READ_NAME})\\1`, 'g'))) found.add(m[2] as string);
  for (const m of source.matchAll(/(['"`])((?:SAS|BRIDGE)_[A-Z0-9_]+)\1/g)) if (!NOT_SETTINGS.has(m[2] as string)) found.add(m[2] as string); // a quoted name, e.g. { user: 'SAS_USER' }
  for (const m of source.matchAll(new RegExp(`process\\.env\\.(${READ_NAME})\\b`, 'g'))) found.add(m[1] as string);
  for (const m of source.matchAll(new RegExp(`process\\.env\\[\\s*(['"])(${READ_NAME})\\1\\s*\\]`, 'g'))) found.add(m[2] as string);
  for (const m of source.matchAll(new RegExp(`baseUrlKey:\\s*'(${READ_NAME})'`, 'g'))) found.add(m[1] as string);
  if (/\.envName\b/.test(source)) found.add('ENV');
  if (/prefix\s*=\s*`SAS_\$\{[^}]*\}`/.test(source)) {
    found.add('SAS_<APP>_USER');
    found.add('SAS_<APP>_PASSWORD');
  }
  return [...found];
}

const LISTED_NAME = '[A-Z][A-Z0-9_<>]*';

/** The variables an env example file lists, active or commented out (`NAME=...` / `# NAME=...`), with the comment block above each. */
export function listed(text: string): Array<{ name: string; line: number; block: string[]; value: string }> {
  const lines = text.split(/\r?\n/);
  const variable = new RegExp(`^#?\\s?(${LISTED_NAME})=(.*)$`);
  const out: Array<{ name: string; line: number; block: string[]; value: string }> = [];
  lines.forEach((line, index) => {
    const m = variable.exec(line);
    if (!m) return;
    const block: string[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const above = lines[i] as string;
      if (!above.startsWith('#') || variable.test(above)) break;
      block.unshift(above);
    }
    out.push({ name: m[1] as string, line: index + 1, block, value: (m[2] as string).trim() });
  });
  return out;
}

/** What is wrong between the names the code reads, the names the example lists and the allowed pass-through names. */
export function drift(input: { readByCode: string[]; listed: string[]; readAnywhere: string[]; passThrough: string[]; ignore?: string[] }): { missing: string[]; unused: string[] } {
  const listedSet = new Set(input.listed);
  const ignore = new Set(input.ignore ?? []);
  const known = new Set([...input.readAnywhere, ...input.passThrough]);
  return {
    missing: [...new Set(input.readByCode)].filter((n) => !listedSet.has(n) && !ignore.has(n)).sort(),
    unused: [...listedSet].filter((n) => !known.has(n)).sort(),
  };
}

function walk(dir: string, accept: (file: string) => boolean): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, accept));
    else if (accept(rel)) out.push(rel);
  }
  return out;
}

const isCode = (file: string) => /\.(ts|js)$/.test(file) && !/\.d\.ts$/.test(file);
const scan = (files: string[]) => files.flatMap((file) => namesRead(read(file)));

/** Set by Playwright or by the CI system, never by a person: read by the code, never listed. */
const SET_BY_THE_TOOLS = ['TEST_WORKER_INDEX', 'CI'];

/** What the code of this repo (the package, the shared Playwright config call) reads - the part nobody may leave out of .env.example. */
const srcFiles = walk('src', isCode);
const readByCode = [...new Set(scan([...srcFiles, 'playwright.config.ts']))];
/** Everything this repo reads, tests, examples, features and scripts included. */
const readAnywhere = [...new Set([...readByCode, ...scan([...walk('tests', isCode).filter((f) => !f.endsWith('envDocs.spec.ts')), ...walk('features', isCode), ...walk('scripts', isCode)])])];

/**
 * Names that are read by something this repo uses, not by this repo's own code - each with where, and checked against that source
 * below (when it is installed), so a name the library stops reading shows up here too.
 */
const PASS_THROUGH: Record<string, { file: string; reason: string }> = {};
for (const name of ['RETRIES', 'MAX_FAILURES', 'TEST_TIMEOUT_MS', 'EXPECT_TIMEOUT_MS', 'GLOBAL_TIMEOUT_MS'])
  PASS_THROUGH[name] = { file: 'playwright/config.js', reason: 'the shared Playwright config (createPlaywrightConfig in referenced-automation-utils)' };
for (const name of ['LOG_LEVEL', 'LOG_TO_FILE', 'LOG_FILE', 'LOG_FILE_PER_WORKER']) PASS_THROUGH[name] = { file: 'logger/logger.js', reason: 'the shared logger in referenced-automation-utils' };
for (const name of ['REMOTE_ENABLED', 'REMOTE_RDP_HOST', 'REMOTE_RDP_PORT', 'REMOTE_RDP_USER', 'REMOTE_RDP_PASSWORD', 'REMOTE_RDP_DOMAIN', 'REMOTE_SHARE_DIR', 'REMOTE_AGENT_START', 'REMOTE_ALLOW'])
  PASS_THROUGH[name] = { file: 'remote/config.js', reason: 'SAS_DESKTOP_TRANSPORT=remote: the remote client in referenced-automation-utils (remoteConfigFromEnv)' };
/** The setup scripts read these from the shell (scripts/setup.sh and setup.bat). */
const SETUP_SCRIPTS = ['NPM_REGISTRY_URL', 'USE_LOCAL_PACKAGES'];

const example = listed(read('.env.example'));
const exampleNames = example.map((v) => v.name);
const passThrough = [...Object.keys(PASS_THROUGH), ...SETUP_SCRIPTS];
const blockOf = (name: string) => (example.find((v) => v.name === name)?.block ?? []).join('\n');
const isSecret = (variable: { block: string[] }) => variable.block.some((line) => /^# Secret:\s+YES/.test(line));

// -------------------------------------------------------------------------------------------------------------- the checks

test.describe('.env.example lists exactly what the code reads', () => {
  test('the scanner finds the settings the code is known to read (a scan that finds nothing would pass everything)', () => {
    for (const name of [
      'ENV', 'SAS_ENVIRONMENT', 'SAS_ENVIRONMENTS_FILE', 'SAS_ALLOW_PROD_READS', 'SAS_USER', 'SAS_PASSWORD', 'SAS_<APP>_USER', 'SAS_<APP>_PASSWORD', 'SAS_LOGON_FAILURE_COOLDOWN_MIN',
      'SAS_TOOL_DIRS', 'SAS_AUDIT_FILE', 'SAS_STATE_DIR', 'SAS_RUN_ID', 'SAS_DESKTOP_TRANSPORT', 'SAS_DESKTOP_SIMULATOR', 'SAS_SMC_PATH', 'SAS_EG_PROGID', 'SAS_PREFLIGHT', 'SAS_CLEANUP_FAILURE',
      'SAS_APP_MODE', 'SAS_ASSERT_TIMEOUT_MS', 'WORKERS', 'BRIDGE_JUNK', 'SAS_EVIDENCE',
    ])
      expect(readByCode, name).toContain(name);
    expect(readAnywhere).toEqual(expect.arrayContaining(['MIN_EXECUTED']));
    expect(readByCode.length).toBeGreaterThan(50);
    expect(srcFiles.length).toBeGreaterThan(40);
  });

  test('every variable read by src/ or playwright.config.ts is listed', () => {
    const { missing } = drift({ readByCode, listed: exampleNames, readAnywhere, passThrough, ignore: SET_BY_THE_TOOLS });
    expect(missing, `read by the code but missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  test('every variable listed is read by something (this repo, or a documented pass-through)', () => {
    const { unused } = drift({ readByCode, listed: exampleNames, readAnywhere, passThrough });
    expect(unused, `listed in .env.example but nothing reads it: ${unused.join(', ')} - remove it, or add it to PASS_THROUGH with where it is read`).toEqual([]);
  });

  test('a name is listed once', () => {
    expect(exampleNames.filter((name, i) => exampleNames.indexOf(name) !== i)).toEqual([]);
  });

  test('each pass-through name is still read by the library it comes from (when that library is installed)', () => {
    test.skip(!fs.existsSync(utils), 'referenced-automation-utils is not installed here');
    for (const [name, { file }] of Object.entries(PASS_THROUGH)) {
      const source = fs.readFileSync(path.join(utils, file), 'utf8');
      expect(source, `${name} is no longer read by ${file}`).toMatch(new RegExp(`['"\`]${name}['"\`]|process\\.env\\.${name}\\b`));
    }
    const setup = read('scripts/setup.sh') + read('scripts/setup.bat');
    for (const name of SETUP_SCRIPTS) expect(setup, `${name} is no longer read by the setup scripts`).toContain(name);
  });

  test('the code reads settings only through the shared config: no source file of this repo touches process.env, except the run id export and the child-process defaults', () => {
    // src/fixtures/index.ts: the stand-in's own login and profile names are published for the duration of a test (and put back) - see src/fixtures/standIn.ts
    const allowed: Record<string, number> = { 'src/core/runContext.ts': 1, 'src/process/processDriver.ts': 3, 'src/fixtures/index.ts': 1 };
    for (const file of srcFiles.filter((f) => f.endsWith('.ts'))) {
      const direct = [...read(file).matchAll(/process\.env\b/g)].length;
      expect(direct, `${file}: process.env used directly ${direct} time(s)`).toBe(allowed[file.replace(/\\/g, '/')] ?? 0);
    }
  });

  test('the committed environment files use only settings that exist (a typo such as SAS_SMC_PROFLE is silently ignored otherwise)', () => {
    for (const file of ['.env.dev', '.env.qa', '.env.stage', '.env.simulator']) {
      const names = listed(read(file)).map((v) => v.name);
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names) expect(exampleNames, `${file}: ${name} is not a setting this repo reads`).toContain(name);
      expect(read(file), `${file} is committed: no secret in it`).not.toMatch(/^(?:#\s*)?[A-Z_]*(PASSWORD|SECRET|TOKEN|API_KEY|PIN)\s*=\s*\S/m);
    }
  });

  test('the per-layer fragments are gone: .env.example is the only list, and nothing points at them', () => {
    expect(exists('env/core.example')).toBe(false);
    expect(exists('env/desktop.example')).toBe(false);
    const mentions: string[] = [];
    // (the recorder's own files - src/recorder, tests/recorder, docs/RECORD_AND_PLAY.md - have another owner: a stale pointer there is reported to them)
    const files = [...walk('src', isCode), ...walk('tests', isCode), ...walk('docs', (f) => f.endsWith('.md')), 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'examples/README.md', '.env.example'].filter(exists);
    for (const file of files) {
      if (file.endsWith('envDocs.spec.ts') || /(^|[\\/])(recorder|RECORD_AND_PLAY)/.test(file)) continue;
      if (/env\/(core|desktop)\.example/.test(read(file)) && file !== 'CHANGELOG.md') mentions.push(file);
    }
    expect(mentions, 'files that still point at a removed fragment').toEqual([]);
    // a fragment another layer keeps (the recorder's) may only list what .env.example lists as well
    for (const fragment of walk('env', (f) => /\.example$/.test(f))) for (const variable of listed(read(fragment))) expect(exampleNames, `${fragment}: ${variable.name} is not in .env.example`).toContain(variable.name);
  });
});

test.describe('each variable is explained', () => {
  const FIELDS = ['What:', 'Values:', 'Default:', 'Required:', 'Secret:', 'Find it:'];

  test('the comment block above every variable says what it is for, valid values, default, required, secret, and where to find it - in this order', () => {
    expect(example.length).toBeGreaterThan(70);
    for (const variable of example) {
      const block = variable.block.join('\n');
      const at = FIELDS.map((field) => block.indexOf(`# ${field}`));
      for (const [i, field] of FIELDS.entries()) expect(at[i], `.env.example line ${variable.line} (${variable.name}): no "${field}" above it`).toBeGreaterThanOrEqual(0);
      expect([...at].sort((a, b) => a - b), `${variable.name}: the fields are out of order`).toEqual(at);
    }
  });

  test('secrets are marked "Secret: YES", say where they belong, and carry no value in the committed example; nothing else is marked as one', () => {
    const secretNames = /(^|_)(PASSWORD|SECRET|TOKEN|PIN|OTP|API_KEY)(_|$)/;
    for (const variable of example) {
      const marked = isSecret(variable);
      expect(marked, `${variable.name}: Secret marking`).toBe(secretNames.test(variable.name) && !/_PATTERNS$/.test(variable.name)); // SAS_RECORDER_SECRET_PATTERNS names secrets, it is not one
      if (marked) {
        expect(variable.block.join('\n'), `${variable.name}: say where a secret belongs`).toMatch(/\.env\.<ENV>\.local|masked CI variable/);
        expect(variable.value, `${variable.name}: a secret has no value in a committed file`).toBe('');
      }
    }
    for (const name of ['SAS_PASSWORD', 'SAS_<APP>_PASSWORD', 'REMOTE_RDP_PASSWORD', 'SAS_PIN', 'SAS_API_KEY'])
      expect(example.find((v) => v.name === name)?.block.some((line) => /^# Secret:\s+YES/.test(line)), name).toBe(true);
  });

  test('optional variables are commented out: none is active with an empty value, and the assignment line is the variable it explains', () => {
    for (const variable of example) {
      const line = read('.env.example').split(/\r?\n/)[variable.line - 1] as string;
      if (!line.startsWith('#')) expect(variable.value, `${variable.name} is active with an empty value`).not.toBe('');
    }
  });

  test('every variable that takes a number says its unit; every boolean says true | false', () => {
    for (const name of example.map((v) => v.name).filter((n) => /_MS$/.test(n))) expect(blockOf(name), name).toMatch(/milliseconds/i);
    for (const name of ['SAS_ALLOW_PROD_READS', 'SAS_ALLOW_OUTSIDE_NAMESPACE', 'SAS_PREFLIGHT', 'SAS_DESKTOP_SIMULATOR', 'BRIDGE_JUNK', 'REMOTE_ENABLED']) expect(blockOf(name), name).toContain('true | false');
  });

  test('the defaults the example states are the defaults in the code', () => {
    const code = srcFiles.map(read).join('\n');
    const defaults: Array<{ name: string; shown: string; code: string }> = [
      { name: 'SAS_LOGON_FAILURE_COOLDOWN_MIN', shown: '15', code: 'DEFAULT_LOGON_COOLDOWN_MIN = 15' },
      { name: 'SAS_PROCESS_TIMEOUT_MS', shown: '120000', code: 'DEFAULT_PROCESS_TIMEOUT_MS = 120_000' },
      { name: 'SAS_PROCESS_MAX_OUTPUT_BYTES', shown: '1048576', code: 'DEFAULT_MAX_OUTPUT_BYTES = 1_048_576' },
      { name: 'SAS_CLEANUP_TIMEOUT_MS', shown: '60000', code: 'DEFAULT_CLEANUP_TIMEOUT_MS = 60_000' },
      { name: 'SAS_CLEANUP_GRACE_MS', shown: '10000', code: 'DEFAULT_CLEANUP_GRACE_MS = 10_000' },
      { name: 'SAS_PREFLIGHT_TIMEOUT_MS', shown: '10000', code: "'SAS_PREFLIGHT_TIMEOUT_MS', 10_000" },
      { name: 'SAS_AUDIT_KEEP_RUNS', shown: '20', code: 'DEFAULT_AUDIT_KEEP_RUNS = 20' },
      { name: 'SAS_EVIDENCE_RETENTION_DAYS', shown: '7', code: 'DEFAULT_EVIDENCE_RETENTION_DAYS = 7' },
      { name: 'SAS_STATE_DIR', shown: '.sas-state', code: "DEFAULT_STATE_DIR = '.sas-state'" },
      { name: 'SAS_NAMESPACE_PATTERN', shown: 'AUTO_{runId}', code: "DEFAULT_NAMESPACE_PATTERN = 'AUTO_{runId}'" },
      { name: 'SAS_EVIDENCE', shown: 'failure', code: "'SAS_EVIDENCE', 'failure'" },
      { name: 'SAS_EVIDENCE_DIR', shown: 'test-results/sas-evidence', code: "DEFAULT_EVIDENCE_DIR = 'test-results/sas-evidence'" },
      { name: 'SAS_DESKTOP_TIMEOUT_MS', shown: '30000', code: 'DEFAULT_TIMEOUT_MS = 30_000' },
      { name: 'SAS_DESKTOP_REQUEST_TIMEOUT_MS', shown: '60000', code: 'DEFAULT_REQUEST_TIMEOUT_MS = 60_000' },
      { name: 'SAS_DESKTOP_EVIDENCE_DIR', shown: 'test-results/sas-desktop-evidence', code: "DEFAULT_EVIDENCE_DIR = 'test-results/sas-desktop-evidence'" },
      { name: 'SAS_DESKTOP_EVIDENCE', shown: 'off', code: "['off', 'failure', 'steps'], 'off'" },
      { name: 'SAS_DESKTOP_TRANSPORT', shown: 'powershell', code: "['powershell', 'remote'], 'powershell'" },
      { name: 'SAS_COM_PROGIDS', shown: 'SASEGObjectModel.Application.*,SASObjectManager.*', code: "DEFAULT_COM_PROGIDS = ['SASEGObjectModel.Application.*', 'SASObjectManager.*']" },
      { name: 'SAS_PREFLIGHT', shown: 'true', code: "'SAS_PREFLIGHT', true" },
      { name: 'SAS_CLEANUP_FAILURE', shown: 'fail', code: "'SAS_CLEANUP_FAILURE', ['fail', 'warn'], 'fail'" },
      { name: 'SAS_APP_MODE', shown: 'auto', code: "'SAS_APP_MODE', ['auto', 'launch', 'attach'], 'auto'" },
      { name: 'SAS_ASSERT_TIMEOUT_MS', shown: '5000', code: 'DEFAULT_ASSERT_TIMEOUT_MS = 5_000' },
      { name: 'SAS_RECORDER_DIR', shown: 'recordings', code: "DEFAULT_RECORDER_DIR = 'recordings'" },
      { name: 'SAS_RECORDER_STOP_KEY', shown: 'Ctrl+Alt+Q', code: "DEFAULT_STOP_KEY = 'Ctrl+Alt+Q'" },
      { name: 'SAS_RECORDER_POLL_MS', shown: '200', code: 'DEFAULT_POLL_MS = 200' },
      { name: 'SAS_RECORDER_MAX_QUEUE', shown: '5000', code: 'DEFAULT_MAX_QUEUE = 5000' },
      { name: 'SAS_RECORDER_MODE', shown: 'full', code: "'SAS_RECORDER_MODE', 'full'" },
    ];
    for (const d of defaults) {
      expect(example.find((v) => v.name === d.name)?.block.find((line) => line.startsWith('# Default:')), `${d.name}: Default line`).toContain(d.shown);
      expect(code, `${d.name}: the default ${d.shown} is not in the code as "${d.code}"`).toContain(d.code);
    }
  });

  test('the sections the reader looks for exist, in order, with the transport sub-headings', () => {
    const text = read('.env.example');
    const titles = [
      '1. FIRST THINGS TO FILL IN', '2. ENVIRONMENTS AND SAFETY', '3. CREDENTIALS AND LOGON PROTECTION', '4. SAS MANAGEMENT CONSOLE', '5. SAS ENTERPRISE GUIDE',
      '6. COMMAND-LINE TOOLS', '7. TRANSPORT', '8. EVIDENCE AND TIMING', '9. TEST DATA AND CLEANUP', '10. RECORDER', '11. SIMULATOR AND CI',
    ];
    let at = -1;
    for (const title of titles) {
      const found = text.indexOf(title, at + 1);
      expect(found, `section "${title}"`).toBeGreaterThan(at);
      at = found;
    }
    for (const sub of ['--- PowerShell (this machine) ---', '--- Remote desktop host']) expect(text).toContain(sub);
  });

  test('the first section holds what a first run needs', () => {
    const text = read('.env.example');
    const first = text.slice(text.indexOf('1. FIRST THINGS TO FILL IN'), text.indexOf('2. ENVIRONMENTS AND SAFETY'));
    for (const name of ['ENV', 'SAS_ENVIRONMENT', 'SAS_SMC_PATH', 'SAS_SMC_PROFILE', 'SAS_EG_PATH', 'SAS_EG_PROFILE', 'SAS_USER', 'SAS_PASSWORD']) expect(first, name).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
  });

  test('where to find a value in the SAS programs is said for the program settings, and the guesses are labelled NOT VERIFIED', () => {
    expect(blockOf('SAS_SMC_PROFILE')).toContain('Connection Profile');
    expect(blockOf('SAS_EG_PROGID')).toContain('Help > About');
    expect(blockOf('SAS_SMC_PATH')).toContain('NOT VERIFIED');
    expect(read('.env.example')).toMatch(/NOT VERIFIED: nothing in this file has been checked/);
  });
});

test.describe('.env.local.example (the secrets template)', () => {
  const template = listed(read('.env.local.example'));

  test('lists every secret of .env.example, as a placeholder, and no live value', () => {
    const secrets = example.filter(isSecret).map((v) => v.name);
    expect(secrets.length).toBeGreaterThanOrEqual(8);
    for (const name of secrets) expect(template.map((v) => v.name), `.env.local.example is missing ${name}`).toContain(name);
    for (const variable of template) expect(variable.value, `${variable.name} in the template must be a placeholder`).toMatch(/^"change-me"$/);
    expect(template.map((v) => v.name).filter((n) => !secrets.includes(n))).toEqual([]); // nothing but secrets in it
  });

  test('says to copy it to .env.<ENV>.local (a plain .env.local is not read), and the file that holds the secrets stays out of git', () => {
    const text = read('.env.local.example');
    expect(text).toContain('Copy it to .env.<ENV>.local');
    expect(text).toMatch(/\.env\.local is NOT read/);
    expect(text).toContain('Copy-Item .env.local.example .env.qa.local');
    expect(read('.gitignore')).toMatch(/^\.env\.\*\.local$/m);
  });
});

test.describe('the README table', () => {
  const readme = read('README.md');
  const start = readme.indexOf('## Configuration reference');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1)); // up to the next top-level heading
  const rows = [...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_<>]*)`\s*\|(.*)\|\s*$/gm)];
  const tableNames = rows.map((m) => m[1] as string);

  test('has a "Configuration reference" section with the columns name | purpose | default | required | secret', () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toMatch(/\|\s*Name\s*\|\s*Purpose\s*\|\s*Default\s*\|\s*Required\s*\|\s*Secret\s*\|/);
    expect(section).toContain('.env.example');
  });

  test('lists every variable of .env.example, and only those', () => {
    const missing = exampleNames.filter((n) => !tableNames.includes(n));
    const extra = tableNames.filter((n) => !exampleNames.includes(n));
    expect(missing, `in .env.example but not in the README table: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `in the README table but not in .env.example: ${extra.join(', ')}`).toEqual([]);
    expect(tableNames.filter((n, i) => tableNames.indexOf(n) !== i)).toEqual([]);
  });

  test('its secret column agrees with .env.example', () => {
    for (const variable of example) {
      const row = rows.find((m) => m[1] === variable.name);
      const cells = (row?.[2] ?? '').split('|').map((c) => c.trim());
      expect(/^yes/i.test((cells[cells.length - 1] ?? '').replace(/\*/g, '')), `${variable.name}: secret column`).toBe(isSecret(variable));
    }
  });

  test('its default column agrees with the example for the settings the code gives a number to', () => {
    for (const name of ['SAS_LOGON_FAILURE_COOLDOWN_MIN', 'SAS_DESKTOP_TIMEOUT_MS', 'SAS_PREFLIGHT_TIMEOUT_MS', 'SAS_CLEANUP_TIMEOUT_MS', 'SAS_AUDIT_KEEP_RUNS', 'SAS_ASSERT_TIMEOUT_MS']) {
      const row = rows.find((m) => m[1] === name);
      const shown = (blockOf(name).match(/# Default:\s+(\S+)/) ?? [])[1];
      expect(row?.[2], name).toContain(String(shown));
    }
  });
});

test.describe('the README and the guides', () => {
  const readme = read('README.md');
  const firstRun = read('docs/WINDOWS_FIRST_RUN.md');

  test('say what the repo is for and not for: SAS Viya is out of scope and the order of preference is command line > COM > screens', () => {
    for (const needle of ['SAS Viya', 'Not for', 'referenced-automation-api', 'referenced-automation-ui', 'command line', 'COM', 'Screens', 'The order of preference', 'NOT VERIFIED']) expect(readme, needle).toContain(needle);
    expect(readme.indexOf('| 1 | **Command line**')).toBeLessThan(readme.indexOf('| 2 | **COM**'));
    expect(readme.indexOf('| 2 | **COM**')).toBeLessThan(readme.indexOf('| 3 | **Screens**'));
  });

  test('the Windows first run is in PowerShell syntax and walks through every step', () => {
    for (const [file, text] of Object.entries({ 'README.md': readme, 'docs/WINDOWS_FIRST_RUN.md': firstRun })) {
      for (const needle of [
        '.\\scripts\\setup.bat', '--local', '$env:', 'Remove-Item Env:', 'npm run build', 'npm run doctor', 'npm run inspect -- --app smc', 'npm run try:simulator', 'forward slashes',
        'Java Access Bridge', 'jabswitch -enable', 'restart', 'interactive', 'Copy-Item .env.local.example .env.qa.local', 'npx playwright test -g', 'show-report', 'tests/real/conformance.spec.ts',
        'npm run test:real-smoke', 'sas-environments.json', 'SAS_LOGON_FAILURE_COOLDOWN_MIN', 'NOT VERIFIED',
      ])
        expect(text, `${file}: ${needle}`).toContain(needle);
    }
    expect(readme).toContain('Windows first run');
  });

  test('the troubleshooting tables carry the exact messages people saw', () => {
    for (const message of ["'tsc' is not recognized", 'Cannot find module', 'Illegal characters in path', '*.tgz', 'No tests found', 'TS5108', 'moduleResolution', 'logon NOT attempted', 'LogonRejected', 'The SAS desktop programs run on Windows', 'pre-flight check(s) are red', 'outside-namespace', 'prod-read-only', 'unknown-environment'])
      expect(readme, `README.md: ${message}`).toContain(message);
    for (const message of ["'tsc' is not recognized", 'Cannot find module', 'Illegal characters in path', '*.tgz', 'No tests found', 'TS5108', 'moduleResolution', 'logon NOT attempted', 'rejected the logon'])
      expect(firstRun, `docs/WINDOWS_FIRST_RUN.md: ${message}`).toContain(message);
  });

  test('the messages quoted for the framework\'s own errors are really what the code says', () => {
    const code = srcFiles.map(read).join('\n');
    for (const fragment of [
      'logon NOT attempted - it would have repeated a logon that',
      'REFUSED by safety policy rule',
      'pre-flight check(s) are red; no test was started',
      'The SAS desktop programs run on Windows: this test was skipped, not run',
      'asks for a profile but none is configured',
      'is not the bridge script this version of the framework ships',
      'workers with a real SAS desktop',
      'the desktop is locked or the session is disconnected',
      'On the screen now',
      'a Java window whose UI Automation tree is empty',
    ])
      expect(code, fragment).toContain(fragment);
  });

  test('every setting the documents name is a documented one', () => {
    const docs = ['README.md', 'docs/ARCHITECTURE.md', 'docs/WINDOWS_FIRST_RUN.md', 'docs/SECURITY.md', 'docs/DESKTOP_SAS.md', 'examples/README.md', 'CONTRIBUTING.md', '.env.dev', '.env.qa', '.env.stage', '.env.simulator'].filter(exists);
    const known = new Set([...exampleNames, ...SET_BY_THE_TOOLS, 'SAS_SMC_USER', 'SAS_SMC_PASSWORD', 'SAS_EG_USER', 'SAS_EG_PASSWORD', 'SAS_<APP>_USER', 'SAS_<APP>_PASSWORD', 'SAS_RUN_ID']);
    for (const file of docs) {
      const named = [...new Set([...read(file).matchAll(/\b(SAS_[A-Z0-9_<>]*[A-Z0-9>])\b/g)].map((m) => m[1] as string))];
      for (const name of named) expect(known.has(name), `${file} names ${name}, which is not documented in .env.example`).toBe(true);
    }
  });

  test('every file a guide points at exists (links and `code` paths)', () => {
    for (const file of ['README.md', 'docs/ARCHITECTURE.md', 'docs/WINDOWS_FIRST_RUN.md', 'docs/adr/README.md', 'examples/README.md', 'CONTRIBUTING.md']) {
      const dir = path.dirname(file);
      for (const m of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1] as string;
        if (/^(https?:|mailto:)/.test(target) || target.startsWith('../../..') || (file === 'README.md' && target.startsWith('../')) || target.startsWith('../referenced-')) continue; // sibling repos
        if (target.endsWith('RECORD_AND_PLAY.md') && !exists('docs/RECORD_AND_PLAY.md')) continue; // written by the recorder's author (ADR 0002); a link to it is checked once it exists
        expect(fs.existsSync(path.join(root, dir, target)), `${file} links to ${target}`).toBe(true);
      }
    }
    const generated = new Set(['docs/RECORD_AND_PLAY.md']); // written by the recorder's author; checked below when present
    for (const file of ['README.md', 'docs/ARCHITECTURE.md']) {
      for (const m of read(file).matchAll(/`((?:src|bridge|env|tests|features|examples|scripts|docs)\/[A-Za-z0-9_./-]+\.(?:ts|ps1|js|md|json|example|feature))`/g)) {
        const target = m[1] as string;
        if (generated.has(target)) continue;
        expect(exists(target) || exists(`${target}`.replace(/\.json$/, '.json.example')), `${file} names ${target}`).toBe(true);
      }
    }
  });

  test('the architecture page maps every layer to folders that exist, and the ADR index lists both ADRs with their files', () => {
    const architecture = read('docs/ARCHITECTURE.md');
    for (const folder of ['src/core', 'src/process', 'src/desktop', 'src/fixtures', 'src/bdd', 'features', 'bridge']) {
      expect(architecture, folder).toContain(folder);
      expect(exists(folder), folder).toBe(true);
    }
    const index = read('docs/adr/README.md');
    for (const adr of ['0001-sas-automation-architecture.md', '0002-record-and-play-for-sas-desktop-apps.md']) {
      expect(index, adr).toContain(adr);
      expect(exists(`docs/adr/${adr}`), adr).toBe(true);
    }
    expect(architecture).toContain('SAS Viya is out of scope');
  });

  test('the safety rules are in one table, naming every rule of the policy that a test can meet', () => {
    const table = readme.slice(readme.indexOf('## Safety rules'), readme.indexOf('## Windows first run'));
    for (const needle of ['unknown-environment', 'host-not-allowed', 'prod-read-only', 'prod-reads-disabled', 'outside-namespace', 'SAS_ALLOW_OUTSIDE_NAMESPACE_REASON', 'SAS_LOGON_FAILURE_COOLDOWN_MIN', 'One desktop, one worker', 'bridge script is verified']) expect(table, needle).toContain(needle);
  });

  test('the CHANGELOG records it under Unreleased, flagged NOT VERIFIED', () => {
    const changelog = read('CHANGELOG.md');
    const from = changelog.indexOf('## Unreleased');
    const unreleased = changelog.slice(from, changelog.indexOf('\n## ', from + 1) === -1 ? undefined : changelog.indexOf('\n## ', from + 1));
    for (const needle of ['NOT VERIFIED', '### Added', 'desktopTest', 'guardAdapter', 'Pre-flight', 'SAS_EVIDENCE', 'registerDesktopSteps', 'try:simulator', 'test:conformance', '.env.example', 'tests/envDocs.spec.ts', 'sas-desktop-smoke', 'SAS Viya', 'Known issues'])
      expect(unreleased, needle).toContain(needle);
  });

  test('the contributing guide states the rules of this repo', () => {
    const contributing = read('CONTRIBUTING.md');
    for (const needle of ['SAS Viya is out of scope', 'command line > COM > screens', 'policy gate', '.env.example', 'tests/bdd/vocabulary.spec.ts', 'bridge:hash', 'NOT VERIFIED', 'automation-framework-audit']) expect(contributing, needle).toContain(needle);
  });
});

test.describe('docs/SECURITY.md and docs/DESKTOP_SAS.md', () => {
  const security = read('docs/SECURITY.md');

  test('SECURITY.md covers every section a security reviewer looks for and names every rule of the safety policy', () => {
    for (const heading of ['Credentials', 'Lockout protection', 'Environment allow-list', 'Safety policy', 'Process hygiene', 'Audit log', 'Evidence hygiene', 'Supply chain', 'NOT VERIFIED']) expect(security, heading).toContain(heading);
    for (const rule of ['unknown-environment', 'invalid-operation', 'host-not-allowed', 'host-required', 'prod-read-only', 'prod-reads-disabled', 'target-required', 'invalid-target', 'outside-namespace', 'override-reason-missing'])
      expect(security, rule).toContain(rule);
  });

  test('says the command-line and COM routes come first and the UI layer exists only for tests about the GUI or tasks with no API', () => {
    expect(security).toMatch(/command-line and COM routes come first/i);
    expect(security).toMatch(/only for tests about the GUI itself or tasks with no API/);
  });
});

test.describe('the worked examples', () => {
  const files = walk('tests/examples', (f) => /^\d+_.*\.spec\.ts$/.test(path.basename(f)));

  test('there is one per program, and the examples README explains each', () => {
    expect(files.map((f) => path.basename(f))).toEqual(['01_management_console.spec.ts', '02_enterprise_guide_com.spec.ts', '03_enterprise_guide_screens.spec.ts', '04_safety_policy.spec.ts']);
    const guide = read('examples/README.md');
    for (const file of files) expect(guide, file).toContain(path.basename(file));
    for (const needle of ['npm run try:simulator', 'stand-in', 'SAS_ALLOW_OUTSIDE_NAMESPACE', 'NOT VERIFIED', '.env.example']) expect(guide, needle).toContain(needle);
  });

  test('each example runs on the stand-in, is tagged, and names the settings it relies on in its header (every one documented)', () => {
    for (const file of files) {
      const text = read(file);
      const header = text.slice(0, text.indexOf('*/'));
      expect(header, `${file}: how to run it`).toContain('npm run try:simulator');
      expect(text, `${file}: tagged`).toMatch(/@sas-desktop/);
      expect(text, `${file}: imports the shared test`).toContain("./support/exampleTest");
      const named = [...new Set([...header.matchAll(/\b(SAS_[A-Z0-9_]+)\b/g)].map((m) => m[1] as string))];
      expect(named.length, `${file}: names its settings`).toBeGreaterThanOrEqual(3);
      for (const name of named) expect(exampleNames.includes(name) || ['SAS_SMC_USER', 'SAS_SMC_PASSWORD', 'SAS_EG_USER', 'SAS_EG_PASSWORD'].includes(name), `${file} names ${name}, not documented in .env.example`).toBe(true);
    }
  });

  test('every setting an example reads is explained in its header', () => {
    for (const file of files) {
      const text = read(file);
      for (const name of namesRead(text)) expect(text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length, `${file}: ${name} is read but not explained in the comments`).toBeGreaterThan(1);
    }
  });

  test('the shared example test forces the stand-in and says how to run against the real programs', () => {
    const support = read('tests/examples/support/exampleTest.ts');
    expect(support).toContain('desktopSimulator');
    expect(support).toContain('REAL programs');
    expect(support).toMatch(/await use\(true\)/);
  });
});

test.describe('the pipeline', () => {
  const ci = read('.gitlab-ci.yml');

  test('has the family shape: build, test with the minimum-executed gate, security, audit, pages', () => {
    for (const needle of ['build:', 'test:', 'security:', 'audit:', 'pages:', 'npm run typecheck', 'npm run lint', 'bridge:hash:check', 'npm run test:ci', 'SAS_DESKTOP_SIMULATOR=true npm run test:real-smoke', 'automation-scan-secrets']) expect(ci, needle).toContain(needle);
  });

  test('the Windows-runner templates are manual, may fail, have a placeholder runner tag and are labelled NOT VERIFIED', () => {
    for (const job of ['sas-desktop-conformance', 'sas-desktop-smoke']) {
      const start = ci.indexOf(`\n${job}:`);
      expect(start, job).toBeGreaterThan(0);
      const body = ci.slice(start, ci.indexOf('\n\n', ci.indexOf('script:', start)));
      expect(body, `${job}: manual`).toContain('when: manual');
      expect(body, `${job}: may fail`).toContain('allow_failure: true');
      expect(body, `${job}: placeholder tag`).toContain('PLACEHOLDER');
      expect(body, `${job}: runs the doctor`).toContain('npm run doctor');
    }
    expect(ci).toContain('NOT VERIFIED');
    expect(ci).toContain('npm run test:conformance');
    expect(ci).toContain('npm run test:real-smoke');
  });

  test('every npm script the pipeline and the guides use exists in package.json', () => {
    const scripts = Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts);
    const used = new Set<string>();
    for (const file of ['.gitlab-ci.yml', 'README.md', 'CONTRIBUTING.md', 'docs/WINDOWS_FIRST_RUN.md', 'examples/README.md'])
      for (const m of read(file).matchAll(/npm run ([a-z][a-z:-]*)/g)) used.add(m[1] as string);
    for (const script of used) expect(scripts, `npm run ${script}`).toContain(script);
    expect(used.size).toBeGreaterThan(10);
  });
});

test.describe('the scanner can fail (made-up sources)', () => {
  test('finds each way the code reads a variable', () => {
    const source = `
      env.get('A_ONE'); loadEnv().getOptional("B_TWO"); env.getBoolean('C_THREE', false); env.getInt('D_FOUR', 1); env.getList('E_FIVE');
      process.env.F_SIX; process.env['G_SEVEN']; const general = { user: 'SAS_H_EIGHT' }; env.envName; baseUrlKey: 'L_TWELVE';
      const prefix = \`SAS_\${application.toUpperCase()}\`; const code = 'BRIDGE_EXITED'; const j = 'BRIDGE_JUNK';
      env.get('lower_case'); env.get(variable); const text = 'M_NOT_READ'; const sentence = 'SAS_SMC_PATH is not set';`;
    expect(namesRead(source).sort()).toEqual(['A_ONE', 'B_TWO', 'BRIDGE_JUNK', 'C_THREE', 'D_FOUR', 'E_FIVE', 'ENV', 'F_SIX', 'G_SEVEN', 'L_TWELVE', 'SAS_<APP>_PASSWORD', 'SAS_<APP>_USER', 'SAS_H_EIGHT'].sort());
  });

  test('a variable the code reads that the example lacks is reported as missing; one the example lists that nothing reads, as unused', () => {
    const result = drift({ readByCode: ['SAS_USER', 'SAS_NEW_SETTING', 'CI'], listed: ['SAS_USER', 'SAS_OLD_SETTING', 'LOG_LEVEL'], readAnywhere: ['SAS_USER', 'SAS_NEW_SETTING'], passThrough: ['LOG_LEVEL'], ignore: ['CI'] });
    expect(result).toEqual({ missing: ['SAS_NEW_SETTING'], unused: ['SAS_OLD_SETTING'] });
    expect(drift({ readByCode: ['SAS_USER'], listed: ['SAS_USER'], readAnywhere: ['SAS_USER'], passThrough: [] })).toEqual({ missing: [], unused: [] });
  });

  test('the example parser takes active and commented variables, with the comment block above each, and ignores prose', () => {
    const text = ['# Quoting: write NAME="x" in quotes', '', '# What:     one', '# Secret:   NO', 'A_ONE=1', '', '# What:     two', '# SAS_<APP>_USER=', '#   not_a=variable', '#           powershell = a value line', 'B_TWO='].join('\n');
    const result = listed(text);
    expect(result.map((v) => v.name)).toEqual(['A_ONE', 'SAS_<APP>_USER', 'B_TWO']);
    expect(result[0]?.block).toEqual(['# What:     one', '# Secret:   NO']);
    expect(result[1]?.block).toEqual(['# What:     two']);
    expect(result[2]?.block).toEqual(['#   not_a=variable', '#           powershell = a value line']);
  });

  test('the README table row pattern takes names with placeholders and ignores other tables', () => {
    const rows = [...'| `SAS_<APP>_USER` | x | y | z | no |\n| Name | Purpose |\n| `lower` | x |\n| `ENV` | a | b | c | no |'.matchAll(/^\|\s*`([A-Z][A-Z0-9_<>]*)`\s*\|(.*)\|\s*$/gm)].map((m) => m[1]);
    expect(rows).toEqual(['SAS_<APP>_USER', 'ENV']);
  });
});
