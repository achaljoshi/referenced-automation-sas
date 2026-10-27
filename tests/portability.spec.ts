import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The rules of docs/PLATFORMS.md ("Rules for new code") that a machine can check. The package must run on Windows, macOS and Linux, and
 * a rule nobody checks erodes with the next contributor. Each rule is a pattern that must not occur in src/; a justified exception is
 * listed in ALLOWED with the reason, never silently.
 */
const RULES: { name: string; pattern: RegExp; why: string }[] = [
  { name: 'a shell', pattern: /\bshell\s*:\s*true\b/, why: 'a shell string is an injection risk and differs between cmd, PowerShell and sh: pass an argument array' },
  { name: 'child_process.exec / execSync', pattern: /(?<![.\w])(?:exec|execSync)\s*\(/, why: 'exec runs a shell: use spawn with an argument array (the process driver)' },
  { name: 'a hard-coded /tmp', pattern: /['"`]\/tmp\b/, why: 'use os.tmpdir()' },
  { name: 'a hard-coded shell path', pattern: /['"`]\/bin\/(?:ba|z)?sh\b/, why: 'there is no /bin/sh on Windows: do not depend on a shell' },
  { name: 'the home folder from the environment', pattern: /process\.env\.(?:HOME|USERPROFILE|HOMEPATH)\b/, why: 'use os.homedir()' },
  { name: 'a Unix command by name', pattern: /spawn(?:Sync)?\(\s*['"`](?:rm|ls|cp|mv|cat|grep|sh|bash|kill|ps)['"`]/, why: 'these do not exist on Windows: use fs, or the process driver' },
];

/** file (relative to the repo, forward slashes) -> rule name -> the reason it is acceptable there. */
const ALLOWED: Record<string, Record<string, string>> = {};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []));
}

const root = path.resolve(__dirname, '..');

/** The rules a text breaks (comments are not code: a rule may be explained in one). */
function violations(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return RULES.filter((rule) => rule.pattern.test(code)).map((rule) => rule.name);
}

test.describe('portability rules for the code of the package (src/)', () => {
  test('the checker finds what it is meant to find (a check that finds nothing would pass everything)', () => {
    expect(violations("spawn('x', [], { shell: true })")).toEqual(['a shell']);
    expect(violations("execSync('dir')")).toEqual(['child_process.exec / execSync']);
    expect(violations("const re = /a/.exec(text); fs.exec(1)")).toEqual([]);
    expect(violations("const dir = '/tmp/x';")).toEqual(['a hard-coded /tmp']);
    expect(violations("spawn('/bin/sh', ['-c', 'ls'])")).toEqual(['a hard-coded shell path']);
    expect(violations("const home = process.env.HOME;")).toEqual(['the home folder from the environment']);
    expect(violations("spawnSync('rm', ['-rf', dir])")).toEqual(['a Unix command by name']);
    expect(violations('// shell: true is refused here\n/* execSync( */ const ok = 1;')).toEqual([]);
  });

  test('src/ breaks none of them (an exception is listed with its reason)', () => {
    const files = sources(path.join(root, 'src'));
    expect(files.length).toBeGreaterThan(40);
    const found: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).replace(/\\/g, '/');
      for (const rule of violations(fs.readFileSync(file, 'utf8'))) {
        if (ALLOWED[relative]?.[rule]) continue;
        found.push(`${relative}: ${rule} - ${RULES.find((r) => r.name === rule)?.why}`);
      }
    }
    expect(found, found.join('\n')).toEqual([]);
  });

  test('every exception names a rule that exists and gives a reason', () => {
    const names = new Set(RULES.map((r) => r.name));
    for (const [file, rules] of Object.entries(ALLOWED))
      for (const [rule, reason] of Object.entries(rules)) {
        expect(names.has(rule), `${file}: unknown rule "${rule}"`).toBe(true);
        expect(reason.trim().length, `${file}: "${rule}" needs a reason`).toBeGreaterThan(10);
      }
  });
});
