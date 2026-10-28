import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { REAL_TESTS_OPT_IN, realTestsSkipReason } from './support/realOptIn';

test.describe('the tests of the real SAS programs are opt-in', () => {
  test('without the opt-in and without the stand-in they are skipped, and the reason says how to run them', () => {
    for (const realTests of [undefined, '', 'false', '0', 'no']) expect(realTestsSkipReason({ realTests, simulated: false }), String(realTests)).toBe(REAL_TESTS_OPT_IN);
    expect(REAL_TESTS_OPT_IN).toContain('npm run test:conformance');
    expect(REAL_TESTS_OPT_IN).toContain('npm run test:real-samples');
    expect(REAL_TESTS_OPT_IN).toContain('npm run test:real-smoke');
  });

  test('SAS_REAL_TESTS=true (1, yes) runs them; so does the stand-in desktop, which is how the pipeline checks the tests themselves', () => {
    for (const realTests of ['true', 'TRUE', '1', 'yes', ' true ']) expect(realTestsSkipReason({ realTests, simulated: false }), realTests).toBeUndefined();
    expect(realTestsSkipReason({ realTests: undefined, simulated: true })).toBeUndefined();
  });

  test('every spec file under tests/real asks the opt-in first: a new file cannot log on to SAS by accident', () => {
    const dir = path.join(__dirname, 'real');
    const specs = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(0);
    for (const file of specs) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(text, `${file} must call realTestsSkipReason and test.skip before its tests`).toMatch(/realTestsSkipReason\([^)]*\)[\s\S]*test\.skip\(skipReason !== undefined/);
    }
  });

  test('every scenario of features/real asks the opt-in first: the guard is an automatic fixture of that folder\'s own test, and nothing else runs those features', () => {
    const root = path.join(__dirname, '..');
    const fixtures = fs.readFileSync(path.join(root, 'features', 'real', 'steps', 'fixtures.ts'), 'utf8');
    // realTestsSkipReason decides, an AUTOMATIC fixture applies it to every scenario, and the desktop gate waits for it (so the opt-in is the reason shown)
    expect(fixtures).toMatch(/realOptIn: \[[\s\S]*realTestsSkipReason\([^)]*\)[\s\S]*testInfo\.skip\(skipReason !== undefined[\s\S]*\{ auto: true \}/);
    expect(fixtures).toMatch(/desktopGate: \[\s*async \(\{ realOptIn,/);
    const steps = fs.readFileSync(path.join(root, 'features', 'real', 'steps', 'steps.ts'), 'utf8');
    expect(steps, 'the steps of features/real are registered on that folder\'s own test').toContain("from './fixtures'");
    // the feature files of the real folder are generated into the project that uses that test, and into no other
    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
    expect(config).toMatch(/features: 'features\/real\/\*\.feature',\s*steps: 'features\/real\/steps\/\*\.ts'/);
    // and no feature of another folder carries a real-program tag, which would run it without the guard
    for (const folder of ['features', path.join('features', 'production')])
      for (const file of fs.readdirSync(path.join(root, folder)).filter((f) => f.endsWith('.feature')))
        expect(fs.readFileSync(path.join(root, folder, file), 'utf8'), `${folder}/${file} must not carry a @real-* tag`).not.toMatch(/^\s*@.*@real-/m);
    const real = fs.readdirSync(path.join(root, 'features', 'real')).filter((f) => f.endsWith('.feature'));
    expect(real.length).toBeGreaterThan(0);
  });

  test('the npm scripts that run them go through the launcher that sets SAS_REAL_TESTS, the same way on every shell', () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['test:conformance']).toBe('node scripts/run-real.js @real-conformance');
    expect(scripts['test:real-smoke']).toBe('node scripts/run-real.js @real-smoke');
    expect(scripts['test:real-samples']).toBe('node scripts/run-real.js @real-sample');
    const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-real.js'), 'utf8');
    expect(launcher).toContain("SAS_REAL_TESTS: 'true'");
    expect(launcher).not.toMatch(/shell:\s*true/);
  });

  test('the launcher refuses anything but the two tags, with the usage', () => {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'run-real.js'), '@something-else'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: node scripts/run-real.js @real-conformance | @real-smoke');
  });
});
