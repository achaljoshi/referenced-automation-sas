import * as fs from 'node:fs';
import * as path from 'node:path';
import { desktopExpect as expect, desktopTest as test } from '../../src/fixtures';
import { settings } from './desktopSupport';

// A wrong password through the fixture: the first test that needs the logon fails, once; the next is stopped by the logon guard.
// The password is made up for this run (never a real one) and the marker goes into a folder of its own under test-results.
const wrong = `wrong-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-Zx9`;
const state = path.join('test-results', `sas-state-wrong-${process.pid}`);

test.use({ desktopSimulator: true, sasSettings: settings({ SAS_STATE_DIR: state, SAS_SMC_USER: 'sasdemo', SAS_SMC_PASSWORD: wrong }) });
test.describe.configure({ mode: 'serial' });

// `test.fail(title, body)` declares the test as expected to fail - before its fixtures start: the failure happens in the `smcLoggedOn` fixture, not in the body.
test.fail('the first test fails: the logon is rejected, once @sas-desktop', async ({ smcLoggedOn }) => {
  void smcLoggedOn;
});

test.fail('the next one fails too, and the logon guard stops it before anything is typed @sas-desktop', async ({ smcLoggedOn }) => {
  void smcLoggedOn;
});

test('at most one logon was ever typed, a marker was written, and no password is in it @sas-desktop', async ({ fakeDesktop, desktopSession }) => {
  expect(fakeDesktop?.smc.attempts.length ?? 0).toBeLessThanOrEqual(1);
  const marker = fs.readFileSync(path.resolve(state, 'logon-failed.json'), 'utf8');
  expect(marker).toContain('sasdemo');
  expect(marker).not.toContain(wrong);
  expect(await desktopSession.listWindows(), 'no window of the console is left on the screen').toEqual([]);
});
