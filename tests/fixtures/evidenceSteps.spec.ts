import { desktopExpect as expect, desktopTest as test } from '../../src/fixtures';
import { settings } from './desktopSupport';

// SAS_EVIDENCE=steps: failure evidence plus a screenshot after every step that may change something.
test.use({ desktopSimulator: true, sasSettings: settings({ SAS_EVIDENCE: 'steps' }) });

test('a screenshot is taken after a step that may change something, not after a read @sas-desktop', async ({ eg, desktopSession }) => {
  const before = desktopSession.evidenceFiles.length;
  await expect(eg.mainWindow.getByName('Connect')).toBeEnabled(); // a read: nothing is taken
  await eg.mainWindow.getByName('Connect').resolve();
  expect(desktopSession.evidenceFiles.length).toBe(before);
  await eg.mainWindow.getByName('Connect').click(); // a click may change something
  expect(desktopSession.evidenceFiles.length).toBe(before + 1);
});
