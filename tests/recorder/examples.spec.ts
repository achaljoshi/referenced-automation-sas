import * as fs from 'node:fs';
import * as path from 'node:path';
import { csvUtils } from '@automation/referenced-automation-utils';
import { expect, test } from '@playwright/test';
import { parseRecording, serializeRecording } from '../../src/recorder';
import { GENERATED, generate, recordExample, repoRoot } from './support/examples';

// The committed example recordings and the tests generated from them are exactly what the recorder and the converter produce today (a change to
// either shows up here as a diff to commit), and the generated tests RUN against the fake desktop (tests/desktop-generated, run by the normal runner).
//
//   SAS_UPDATE_EXAMPLES=1 npx playwright test tests/recorder/examples.spec.ts      rewrites the committed files from today's code

const update = process.env.SAS_UPDATE_EXAMPLES === '1';
const examples = path.join(repoRoot, 'examples');
const generated = path.join(repoRoot, 'tests', 'desktop-generated');

function check(file: string, expected: string): void {
  if (update) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, expected);
    return;
  }
  expect(fs.existsSync(file), `${path.relative(repoRoot, file)} is missing: run with SAS_UPDATE_EXAMPLES=1`).toBe(true);
  expect(fs.readFileSync(file, 'utf8'), `${path.relative(repoRoot, file)} differs from what today's code produces (SAS_UPDATE_EXAMPLES=1 rewrites it)`).toBe(expected);
}

test.describe('the committed examples', () => {
  // SAS_UPDATE_EXAMPLES writes the recordings before the converter tests read them: in order. (Not otherwise: one drifted file must not hide the others.)
  if (update) test.describe.configure({ mode: 'serial' });
  for (const which of ['smc', 'eg'] as const) {
    test(`examples/${which === 'smc' ? 'smc_create_user' : 'eg_run_project'}.sasrec.json is what the recorder produces from the scripted session`, async () => {
      const recording = await recordExample(which);
      const file = path.join(examples, `${which === 'smc' ? 'smc_create_user' : 'eg_run_project'}.sasrec.json`);
      check(file, serializeRecording(recording));
      // and it reads back as a valid recording
      if (!update) expect(parseRecording(fs.readFileSync(file, 'utf8'), file).events.length).toBeGreaterThan(5);
    });
  }

  for (const entry of GENERATED) {
    test(`tests/desktop-generated/${entry.id}.spec.ts is what the converter produces today from the committed recording`, async () => {
      const recording = parseRecording(fs.readFileSync(path.join(examples, `${entry.recording === 'smc' ? 'smc_create_user' : 'eg_run_project'}.sasrec.json`), 'utf8'));
      const result = generate(entry, recording);
      check(path.join(generated, `${entry.id}.spec.ts`), result.spec);
      if (result.pages) check(path.join(generated, 'pages', result.pages.fileName), result.pages.code);
      if (result.data) check(path.join(generated, result.data.fileName), csvUtils.toCsv(result.data.rows));
      expect(result.todos, 'the committed examples have nothing left for a human').toBe(0);
    });
  }
});
