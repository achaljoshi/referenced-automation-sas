import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

const root = path.resolve(__dirname, '..');

// The two scripts the npm scripts and the pipeline lean on: the minimum-executed gate and the simulator runner.

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, LOG_TO_FILE: 'false', ...env } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped';
function report(outcomes: Array<{ status: Outcome; skip?: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-min-'));
  const file = path.join(dir, 'results.json');
  const specs = outcomes.map((o, i) => ({
    title: `t${i}`,
    tests: [{ status: o.status, annotations: o.skip ? [{ type: 'skip', description: o.skip }] : [], results: [{ status: o.status === 'skipped' ? 'skipped' : o.status === 'unexpected' ? 'failed' : 'passed' }] }],
  }));
  fs.writeFileSync(file, JSON.stringify({ suites: [{ title: 'a.spec.ts', specs: specs.slice(0, 2), suites: [{ title: 'nested', specs: specs.slice(2) }] }] }));
  return file;
}

test.describe('scripts/min-executed.js', () => {
  test('enough tests executed: exit 0, with the counts', () => {
    const input = report([{ status: 'expected' }, { status: 'expected' }, { status: 'flaky' }]);
    const r = run('min-executed.js', ['--min', '3', '--input', input]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('3 executed, 0 skipped, 0 failed');
  });

  test('too few executed (everything was skipped - no desktop): exit 1, and the skip reasons are printed with their counts', () => {
    const input = report([{ status: 'skipped', skip: 'The SAS desktop programs run on Windows' }, { status: 'skipped', skip: 'The SAS desktop programs run on Windows' }, { status: 'expected' }]);
    const r = run('min-executed.js', ['--min', '2', '--input', input]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('skipped 2x: The SAS desktop programs run on Windows');
    expect(r.err).toContain('only 1 test(s) executed, expected at least 2');
  });

  test('a failed test fails the gate whatever the count; a skip with no reason says so', () => {
    const failed = run('min-executed.js', ['--min', '1', '--input', report([{ status: 'expected' }, { status: 'unexpected' }])]);
    expect(failed.status).toBe(1);
    expect(failed.out).toContain('1 failed');
    const noReason = run('min-executed.js', ['--min', '1', '--input', report([{ status: 'expected' }, { status: 'skipped' }])]);
    expect(noReason.status).toBe(0);
    expect(noReason.out).toContain('skipped 1x: no reason given');
  });

  test('no readable report is exit 2 (the tests did not run), and MIN_EXECUTED is the default for --min', () => {
    const missing = run('min-executed.js', ['--input', path.join(os.tmpdir(), 'sas-no-such-report.json')]);
    expect(missing.status).toBe(2);
    expect(missing.err).toContain('no readable report');
    const input = report([{ status: 'expected' }]);
    expect(run('min-executed.js', ['--input', input], { MIN_EXECUTED: '1' }).status).toBe(0);
    expect(run('min-executed.js', ['--input', input], { MIN_EXECUTED: '5' }).status).toBe(1);
  });
});

test.describe('scripts/try-simulator.js', () => {
  test('prints what each worked example does BEFORE it runs, with the settings it explains', () => {
    const r = run('try-simulator.js', ['--list']); // Playwright's --list: shows the tests without running them
    expect(r.status).toBe(0);
    for (const needle of ['example_01_management_console.feature', 'example_02_enterprise_guide_com.feature', 'example_03_enterprise_guide_screens.feature', 'example_04_safety_policy.feature', 'EXAMPLE 2 - SAS Enterprise Guide by COM', 'settings it explains:', 'SAS_EG_PROGID', 'SAS_DESKTOP_SIMULATOR'])
      expect(r.out, needle).toContain(needle);
    expect(r.out.indexOf('EXAMPLE 1')).toBeLessThan(r.out.indexOf('Listing tests'));
    expect(r.out).not.toMatch(/\d+ passed/);
  });

  test('a bare word filters the examples by file name instead of running more than them (Playwright ORs its file arguments)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a plain CommonJS script, loaded at run time
    const { testTargets, describeExamples } = require(path.join(root, 'scripts', 'try-simulator.js')) as { testTargets(argv: string[]): string[]; describeExamples(dir: string): Array<{ name: string; title: string; settings: string[] }> };
    expect(testTargets([])).toEqual([]); // the @example tag selects them all
    expect(testTargets(['02_', '--workers=1'])).toEqual(['example_02_']);
    expect(testTargets(['example_04_safety_policy'])).toEqual(['example_04_safety_policy']);
    expect(describeExamples(path.join(root, 'features')).map((e) => e.name)).toHaveLength(4);
    expect(describeExamples(path.join(root, 'features')).every((e) => e.title.startsWith('EXAMPLE ') && e.settings.length >= 3)).toBe(true);
  });
});

test.describe('playwright.config.ts', () => {
  const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');

  test('shares one run id with every worker, defines the bdd projects and sets one worker where a real desktop is in reach', () => {
    expect(config).toContain('initRunContext()');
    expect(config).toContain("name: 'bdd'");
    expect(config).toContain("name: 'bdd-production'");
    expect(config).toContain("name: 'bdd-real'");
    expect(config).toContain('features/*.feature');
    expect(config).toContain('features/production/*.feature');
    expect(config).toContain('features/real/*.feature');
    expect(config).toContain('desktopWorkerPlan');
    expect(config).toMatch(/workers: 1, fullyParallel: false/);
    expect(config).toContain('createPlaywrightConfig');
  });
});
