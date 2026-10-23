import { desktopExpect as expect, desktopTest as test } from '../../src/fixtures';
import { evidenceFiles, settings, slug } from './desktopSupport';

// SAS_EVIDENCE=on: every test leaves a screenshot, under the run's own folder.
test.use({ desktopSimulator: true, sasSettings: settings({ SAS_EVIDENCE: 'on' }) });
test.describe.configure({ mode: 'serial' });

test('keeps a screenshot of a passed test @sas-desktop', async ({ smcApp }) => {
  await expect(smcApp.window(/Connection Profile/i)).toExist();
});

test('the screenshot was taken while the program was still open (before it was closed) @sas-desktop', async ({ fakeDesktop }) => {
  const ops = (fakeDesktop?.desktop.calls ?? []).map((c) => c.op);
  const shot = ops.indexOf('screenshot');
  const close = ops.indexOf('close');
  expect(shot, 'a screenshot was taken').toBeGreaterThanOrEqual(0);
  expect(close, 'the program was closed').toBeGreaterThanOrEqual(0);
  expect(shot, 'the screenshot comes first: it shows the screen as the test left it').toBeLessThan(close);
});

test('the screenshot is there, under the run folder @sas-desktop', async ({ runContext }) => {
  const mine = evidenceFiles(runContext.runId).filter((f) => f.includes(slug('keeps a screenshot of a passed test @sas-desktop')));
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatch(/\.png$/);
});
