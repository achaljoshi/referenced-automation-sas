import { desktopTest as packageTest, desktopExpect } from '../../../src';
import type { FakeSasDesktop } from '../../../src/desktop';
import { installRecorderExtras } from './extras';

/**
 * The package's own `desktopTest` (src/fixtures) with two things added for the tests generated from the example recordings: it always runs on the
 * stand-in desktop, and the stand-in has the two extras the examples were recorded with (a "New User..." dialog in the fake Management Console, a "Tip of
 * the Day" dialog in the fake Enterprise Guide: see extras.ts). The fixtures themselves - smcApp, egApp, smcLoggedOn, egLoggedOn, desktopSession, the logon
 * guard, the safety policy, the stand-in's own login put into SAS_USER / SAS_PASSWORD / the profile variables - are the package's.
 */
const installed = new WeakSet<FakeSasDesktop>();

export const desktopTest = packageTest.extend<object, { recorderExtras: void }>({
  // the package declares this worker option itself; extend()'s typing does not allow a new default for an existing option, the runtime does
  desktopSimulator: [true, { option: true, scope: 'worker' }] as never,
  recorderExtras: [
    async ({ fakeDesktop }, use) => {
      if (fakeDesktop && !installed.has(fakeDesktop)) {
        installed.add(fakeDesktop);
        installRecorderExtras(fakeDesktop);
      }
      await use();
    },
    { auto: true, scope: 'worker' },
  ],
});

export { desktopExpect };
