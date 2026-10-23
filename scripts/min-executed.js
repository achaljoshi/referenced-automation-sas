#!/usr/bin/env node
/**
 * Fails a run in which too few tests actually executed, and says why the rest did not.
 *
 *   node scripts/min-executed.js --min 5 [--input test-results/results.json]
 *
 * Reads the Playwright JSON report (the shared config writes test-results/results.json). "Executed" means passed or flaky:
 * a run that discovers tests but skips them all - a missing JDK, no Windows, a feature file nobody generated - exits 0 from
 * Playwright and must not look green. The skip reasons are printed with their counts so the CI log says what was not covered.
 *
 * Exit codes: 0 enough executed, 1 too few (or any failed), 2 no readable report.
 */
const fs = require('node:fs');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const input = arg('--input') ?? 'test-results/results.json';
const min = Number(arg('--min') ?? process.env.MIN_EXECUTED ?? 1);

let report;
try {
  report = JSON.parse(fs.readFileSync(input, 'utf8'));
} catch (error) {
  process.stderr.write(`min-executed: no readable report at ${input} (${error.message}) - did the tests run?\n`);
  process.exit(2);
}

const skipReasons = new Map();
let executed = 0;
let skipped = 0;
let failed = 0;
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const last = (test.results ?? [])[test.results.length - 1];
      const outcome = test.status; // expected | unexpected | flaky | skipped
      if (outcome === 'skipped' || last?.status === 'skipped') {
        skipped++;
        const reason = (test.annotations ?? []).find((a) => a.type === 'skip')?.description || 'no reason given';
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      } else if (outcome === 'expected' || outcome === 'flaky') executed++;
      else failed++;
    }
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites ?? []) walk(suite);

process.stdout.write(`min-executed: ${executed} executed, ${skipped} skipped, ${failed} failed (need at least ${min} executed)\n`);
for (const [reason, count] of skipReasons) process.stdout.write(`  skipped ${count}x: ${reason}\n`);
if (failed > 0) process.exit(1);
if (executed < min) {
  process.stderr.write(`min-executed: only ${executed} test(s) executed, expected at least ${min} - the run is not evidence of anything\n`);
  process.exit(1);
}
