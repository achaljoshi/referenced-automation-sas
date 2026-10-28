#!/usr/bin/env node
/**
 * Runs the worked examples (features/example_*.feature) against the built-in stand-in desktop - no SAS, no Windows, any OS - and says
 * first what each example does.
 *
 *   npm run try:simulator                 all examples
 *   npm run try:simulator -- 02_          only the examples whose file name contains "02_" (any Playwright argument works)
 *
 * A script rather than `SAS_DESKTOP_SIMULATOR=true playwright ...` in package.json, because that inline form does not work in Windows
 * cmd.exe or PowerShell. ENV=simulator loads .env.simulator and not .env.qa(.local): the run does not depend on your real settings.
 * The examples are Gherkin: the script generates them first (what `bddgen` does) and runs those tagged @example in the `bdd` project.
 * The stand-in proves the framework's flows, not that SAS looks like this: see examples/README.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateGherkin } = require('./gherkin');

const root = path.resolve(__dirname, '..');
const examplesDir = path.join(root, 'features');

/** The `Feature: EXAMPLE n - ...` line of each example, and the settings its header comment explains (`#   SAS_X  what it does`). */
function describeExamples(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^example_\d+_.*\.feature$/.test(name))
    .sort()
    .map((name) => {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
      const feature = lines.find((line) => /^Feature: /.test(line));
      const title = feature ? feature.replace(/^Feature: /, '') : name;
      const settings = lines.map((line) => /^#\s{3}(SAS_[A-Z0-9_]+)\b/.exec(line)?.[1]).filter(Boolean);
      return { name, title, settings: [...new Set(settings)] };
    });
}

/**
 * Playwright ORs its file arguments, so a bare word would run more than the examples. A bare word is therefore turned into a filter on
 * the examples' file names (`02_` -> example_02_); with none, the `@example` tag selects every example.
 */
function testTargets(argv) {
  return argv.filter((a) => !a.startsWith('-')).map((w) => (/[\\/]/.test(w) || w.startsWith('example_') ? w : `example_${w}`));
}

function main(argv) {
  if (!fs.existsSync(examplesDir)) {
    process.stderr.write(`try-simulator: ${examplesDir} does not exist\n`);
    return 1;
  }
  const examples = describeExamples(examplesDir);
  process.stdout.write('Running the worked examples against the built-in stand-in desktop (no SAS, no Windows):\n\n');
  for (const example of examples) {
    process.stdout.write(`  ${example.name}\n    ${example.title}\n    settings it explains: ${example.settings.join(', ') || '(none)'}\n`);
  }
  process.stdout.write('\nA failing example prints what is on the screen. Read the example, then copy the parts you need (examples/README.md).\n\n');

  const env = { ...process.env, ENV: 'simulator', SAS_DESKTOP_SIMULATOR: 'true' };
  const generated = generateGherkin(env);
  if (generated !== 0) return generated;
  const result = spawnSync('npx', ['playwright', 'test', '--project=bdd', '--grep', '@example', ...testTargets(argv), '--reporter=list', ...argv.filter((a) => a.startsWith('-'))], {
    stdio: 'inherit',
    shell: true,
    cwd: root,
    env,
  });
  return result.status ?? 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { describeExamples, testTargets };
