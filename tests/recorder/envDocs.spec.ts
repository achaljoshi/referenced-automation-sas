import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigReader } from '@automation/referenced-automation-utils';
import { expect, test } from '@playwright/test';
import { DEFAULT_POLL_MS, DEFAULT_RECORDER_DIR, DEFAULT_STOP_KEY, recorderConfig, SECRET_ENV_VAR } from '../../src/recorder';
import { repoRoot } from './support/examples';

// .env.example (section RECORDER) documents EVERY setting src/recorder reads, and the variables a converted test reads, in the family's format - and nothing else.

const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

/** The recorder's settings are documented in section "RECORDER" of .env.example; everything else documented there is "elsewhere". */
function sections(text: string): string[] {
  return text.split(/^# -{20,}\n(?=# \d+\. )/m);
}
const merged = sections(read('.env.example'));
const mergedRecorder = merged.find((s) => /^# \d+\. RECORDER/.test(s)) as string;
const example = mergedRecorder;
const others = merged.filter((s) => s !== mergedRecorder).join('\n');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}
const recorderFiles = sources(path.join(repoRoot, 'src', 'recorder'));

/** The keys the code asks the shared config for: `.get('KEY'...)`, `.getInt`, ... in src/recorder. */
const readByConfig = (): Set<string> =>
  new Set(recorderFiles.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\.(?:get|getOptional|getInt|getBoolean|getList|has)\(\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] as string)));

/** Every SAS_* name written in the code that is not a setting of the recorder: what converted tests read. */
const emitted = (): Set<string> =>
  new Set(
    recorderFiles
      .filter((f) => !f.endsWith(path.join('recorder', 'config.ts')))
      .flatMap((f) => [...fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').matchAll(/'(SAS_[A-Z0-9_]+)'/g)].map((m) => m[1] as string)),
  );

function documented(text: string): Array<{ key: string; block: string[]; active: boolean; value: string }> {
  const lines = text.split('\n');
  const out: Array<{ key: string; block: string[]; active: boolean; value: string }> = [];
  let block: string[] = [];
  for (const line of lines) {
    const assignment = /^(#?)\s?(SAS_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (assignment && !/^#\s+(What|Values|Default|Required|Secret|Example|Find it):/.test(line)) {
      out.push({ key: assignment[2] as string, block, active: assignment[1] === '', value: (assignment[3] as string).trim() });
      block = [];
    } else if (line.startsWith('#') && !/^#\s*[-=]{5,}/.test(line)) block.push(line);
    else block = [];
  }
  return out;
}

test.describe('.env.example, section RECORDER', () => {
  const listed = documented(example);
  const names = new Set(listed.map((d) => d.key));

  test('documents every key the recorder reads, and every variable a converted test reads that is not documented in another fragment', () => {
    const settings = readByConfig();
    expect([...settings].filter((k) => !names.has(k)).sort(), 'read by the code but not documented').toEqual([]);
    const converted = [...emitted()].filter((k) => !settings.has(k));
    const elsewhere = new Set(documented(others).map((d) => d.key));
    const missing = converted.filter((k) => !names.has(k) && !elsewhere.has(k));
    expect(missing.sort(), 'written into converted tests but documented nowhere').toEqual([]);
    expect(settings.size).toBe(6);
    expect(Object.values(SECRET_ENV_VAR).filter((k) => k !== 'SAS_PASSWORD').every((k) => names.has(k))).toBe(true);
  });

  test('lists nothing that nothing reads or writes, and repeats nothing another fragment documents (the lead merges them)', () => {
    const known = new Set([...readByConfig(), ...emitted()]);
    expect([...names].filter((k) => !known.has(k)).sort(), 'documented but read by nothing').toEqual([]);
    const elsewhere = new Set(documented(others).map((d) => d.key));
    expect([...names].filter((k) => elsewhere.has(k)).sort(), 'documented twice').toEqual([]);
  });

  test('every variable has the comment lines the family format asks for, directly above it, in order; Secret is NO or YES', () => {
    expect(listed.length).toBeGreaterThanOrEqual(11);
    for (const { key, block } of listed) {
      const labels = block.map((l) => /^#\s+(What|Values|Default|Required|Secret|Example|Find it):/.exec(l)?.[1]).filter(Boolean);
      expect(labels.slice(0, 5), key).toEqual(['What', 'Values', 'Default', 'Required', 'Secret']);
      expect(['Example', 'Find it'], key).toContain(labels[5]);
      expect(labels, key).toHaveLength(6);
      expect(block.find((l) => /^#\s+Secret:/.test(l)), key).toMatch(/Secret:\s+(NO|YES)\b/);
      const example_ = block.find((l) => /^#\s+Example:/.test(l));
      if (example_) expect(example_.replace(/^#\s+Example:\s+/, '').startsWith(`${key}=`), `${key}: the Example line is a value that can be pasted`).toBe(true);
    }
  });

  test('optional variables are commented out and none is active with an empty value; what a secret variable holds is never in the file', () => {
    expect(listed.filter((d) => d.active)).toEqual([]);
    for (const line of example.split('\n').filter((l) => /^SAS_[A-Z0-9_]+=/.test(l))) expect(line, line).not.toMatch(/=\s*$/);
    const secrets = listed.filter((d) => d.block.some((l) => /^#\s+Secret:\s+YES/.test(l)));
    expect(secrets.map((s) => s.key).sort()).toEqual(['SAS_API_KEY', 'SAS_OTP', 'SAS_PIN', 'SAS_SECRET', 'SAS_TOKEN']);
    for (const s of secrets) expect(s.value, `${s.key} is shipped empty`).toBe('');
    expect(listed.filter((d) => !secrets.includes(d)).map((d) => d.key).sort(), 'everything else is a plain setting of the recorder').toEqual(['SAS_RECORDER_DIR', 'SAS_RECORDER_MAX_QUEUE', 'SAS_RECORDER_MODE', 'SAS_RECORDER_POLL_MS', 'SAS_RECORDER_SECRET_PATTERNS', 'SAS_RECORDER_STOP_KEY']);
  });

  test('the section says that nothing secret is recorded', () => {
    expect(example).toContain('A recording NEVER contains a password');
  });
});

test.describe('the code reads the environment only through the shared config', () => {
  test('no file of src/recorder touches process.env; config.ts is the only one that asks for a setting by name', () => {
    for (const file of recorderFiles) expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/process\.env\b/);
    const askers = recorderFiles.filter((f) => /\.(?:get|getOptional|getInt|getBoolean|getList)\(\s*'SAS_RECORDER_/.test(fs.readFileSync(f, 'utf8')));
    expect(askers.map((f) => path.relative(repoRoot, f))).toEqual(['src/recorder/config.ts']);
  });
});

test.describe('recorderConfig', () => {
  const config = (values: Record<string, string> = {}) => recorderConfig(new ConfigReader({ ENV: 'qa', ...values }));

  test('defaults', () => {
    expect(config()).toEqual({ dir: DEFAULT_RECORDER_DIR, stopKey: 'Ctrl+Alt+Q', pollMs: 200, maxQueue: 5000, mode: 'full', secretPatterns: [] });
    expect(DEFAULT_STOP_KEY).toBe('Ctrl+Alt+Q');
    expect(DEFAULT_POLL_MS).toBe(200);
  });

  test('values are read and normalised', () => {
    expect(config({ SAS_RECORDER_DIR: 'rec', SAS_RECORDER_STOP_KEY: 'ctrl+shift+f12', SAS_RECORDER_POLL_MS: '50', SAS_RECORDER_MAX_QUEUE: '1000', SAS_RECORDER_MODE: 'UIA', SAS_RECORDER_SECRET_PATTERNS: 'account code, ^cvv$' })).toEqual({
      dir: 'rec',
      stopKey: 'Ctrl+Shift+F12',
      pollMs: 50,
      maxQueue: 1000,
      mode: 'uia',
      secretPatterns: ['account code', '^cvv$'],
    });
  });

  test('a wrong value is refused with the name of the variable and what is valid', () => {
    expect(() => config({ SAS_RECORDER_STOP_KEY: 'Hyper+Q' })).toThrow(/SAS_RECORDER_STOP_KEY must be a key chord such as Ctrl\+Alt\+Q \(found "Hyper\+Q"\)/);
    expect(() => config({ SAS_RECORDER_STOP_KEY: 'Ctrl+Alt+Home' })).toThrow(/SAS_RECORDER_STOP_KEY/);
    expect(() => config({ SAS_RECORDER_POLL_MS: '5' })).toThrow(/SAS_RECORDER_POLL_MS must be between 20 and 5000 milliseconds \(found 5\)/);
    expect(() => config({ SAS_RECORDER_MAX_QUEUE: '10' })).toThrow(/SAS_RECORDER_MAX_QUEUE must be between 100 and 200000/);
    expect(() => config({ SAS_RECORDER_MODE: 'hooks' })).toThrow(/SAS_RECORDER_MODE must be one of "full", "uia" \(found "hooks"\)/);
    expect(() => config({ SAS_RECORDER_SECRET_PATTERNS: 'ok,(' })).toThrow(/SAS_RECORDER_SECRET_PATTERNS entry "\(" is not a valid regular expression/);
  });
});
