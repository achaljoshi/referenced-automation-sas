import { desktopTest as test } from '../../src/fixtures';
import { settings } from './desktopSupport';

// Without the stand-in the real programs are needed. On a machine that cannot host them (not Windows, no remote desktop host) the
// test is SKIPPED with the reason by the `desktopGate` fixture, before any other fixture starts - never run, never silently passed.
// If the gate did not skip it, the body below would fail the suite. (On Windows there is nothing to skip: this file steps aside.)
test.skip(process.platform === 'win32', 'on Windows a real desktop can be reached, so there is nothing to skip');
test.use({ desktopSimulator: false, sasSettings: settings({ SAS_DESKTOP_TRANSPORT: 'powershell' }) });

test('this body must never run on a machine that cannot host the programs @sas-desktop', async ({ smcApp }) => {
  void smcApp;
  throw new Error('the gate should have skipped this test before any fixture started');
});
