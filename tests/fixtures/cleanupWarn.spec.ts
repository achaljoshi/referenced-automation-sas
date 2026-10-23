import { desktopTest as test } from '../../src/fixtures';
import { settings } from './desktopSupport';

// SAS_CLEANUP_FAILURE=warn: the negative control of "a clean-up that fails FAILS its test" in fixtures.spec.ts.
test.use({ desktopSimulator: true, sasSettings: settings({ SAS_CLEANUP_FAILURE: 'warn' }) });

test('the same failing undo only warns, so the test passes @sas-desktop', async ({ cleanup }) => {
  cleanup.register({ type: 'group', name: 'stuck-too', undo: () => { throw new Error('the group is in use'); } });
});
