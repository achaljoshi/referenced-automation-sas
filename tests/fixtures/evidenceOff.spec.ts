import { desktopExpect as expect, desktopTest as test } from '../../src/fixtures';
import { evidenceFiles, settings, slug } from './desktopSupport';

// SAS_EVIDENCE=off: nothing automatic, not even with SAS_DESKTOP_EVIDENCE=steps (off is the master switch).
test.use({ desktopSimulator: true, sasSettings: settings({ SAS_EVIDENCE: 'off', SAS_DESKTOP_EVIDENCE: 'steps' }) });
test.describe.configure({ mode: 'serial' });

test('leaves nothing automatic @sas-desktop', async ({ eg, desktopSession }) => {
  await eg.mainWindow.getByName('Connect').click(); // a step that would be photographed in steps mode
  expect(desktopSession.evidenceFiles.filter((f) => f.label === 'click')).toEqual([]);
});

test('nothing was kept for the previous test @sas-desktop', async ({ runContext }) => {
  expect(evidenceFiles(runContext.runId).filter((f) => f.includes(slug('leaves nothing automatic @sas-desktop')))).toEqual([]);
});
