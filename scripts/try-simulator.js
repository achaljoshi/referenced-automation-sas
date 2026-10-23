#!/usr/bin/env node
/**
 * Runs the worked examples (tests/examples) against the built-in stand-in desktop - no SAS, no Windows, any OS - and says first what
 * each example does.
 *
 *   npm run try:simulator                 all examples
 *   npm run try:simulator -- 02_          only the examples whose file name or title contains "02_" (any Playwright argument works)
 *
 * A script rather than `SAS_DESKTOP_SIMULATOR=true playwright ...` in package.json, because that inline form does not work in Windows
 * cmd.exe or PowerShell. ENV=simulator loads .env.simulator and not .env.qa(.local): the run does not depend on your real settings.
 * The stand-in proves the framework's flows, not that SAS looks like this: see examples/README.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const examplesDir = path.join(root, 'tests', 'examples');

/** The `EXAMPLE n - ...` line of each example's header comment, with the line that runs it. */
function describeExamples(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+_.*\.spec\.ts$/.test(name))
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((line) => /^ \* EXAMPLE \d+ - /.test(line));
      let title = name;
      if (start !== -1) {
        // the paragraph under the title: up to the first empty comment line
        const paragraph = [];
        for (let i = start; i < lines.length && /^ \* ?\S/.test(lines[i]); i++) paragraph.push(lines[i].replace(/^ \* ?/, ''));
        title = paragraph.join(' ');
      }
      const settings = [...text.matchAll(/^ \*   (SAS_[A-Z0-9_]+)\b/gm)].map((m) => m[1]);
      return { name, title, settings: [...new Set(settings)] };
    });
}

/**
 * Playwright ORs its file arguments, so `tests/examples 02_` would run every example. A bare word is therefore a filter INSIDE the
 * examples folder (`02_` -> tests/examples/02_), and with none the whole folder runs.
 */
function testTargets(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  return words.length === 0 ? ['tests/examples'] : words.map((w) => (/[\\/]/.test(w) ? w : `tests/examples/${w}`));
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

  const result = spawnSync('npx', ['playwright', 'test', ...testTargets(argv), '--reporter=list', ...argv.filter((a) => a.startsWith('-'))], {
    stdio: 'inherit',
    shell: true,
    cwd: root,
    env: { ...process.env, ENV: 'simulator', SAS_DESKTOP_SIMULATOR: 'true' },
  });
  return result.status ?? 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { describeExamples, testTargets };
