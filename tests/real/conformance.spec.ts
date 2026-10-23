import { desktopExpect as expect, desktopTest as test } from '../../src';
import type { EnvironmentInfo } from '../../src/desktop';

/**
 * CONFORMANCE of the desktop layer against the REAL machine - no login needed, nothing is changed. Run it first on a Windows machine
 * that has the SAS programs (`npm run doctor`, then `npm run test:conformance`): it checks what the stand-in only assumes - that the
 * bridge starts, the desktop is interactive and unlocked, UI Automation works and the Enterprise Guide COM class can be created.
 *
 * NOT VERIFIED: nobody has run this on a real Windows desktop with the real SAS programs. Where no desktop can be reached the tests are
 * SKIPPED with the reason, never silently passed; `SAS_DESKTOP_SIMULATOR=true npm run test:conformance` runs the same checks against the
 * stand-in desktop to show that the checks themselves work.
 *
 * Settings: SAS_DESKTOP_TRANSPORT, SAS_DESKTOP_POWERSHELL, SAS_DESKTOP_SCRIPT_DIR, SAS_COM_PROGIDS, SAS_EG_PROGID, SAS_EG_PROFILE (all in .env.example).
 */
test.describe('desktop conformance (the real machine) @sas-desktop @real-conformance', () => {
  test('the bridge starts and answers @real-conformance', async ({ desktopSession }) => {
    const ping = await desktopSession.ping();
    expect(ping.bridge).toBeTruthy();
    expect(ping.version).toBeGreaterThan(0);
  });

  test('the desktop is interactive, unlocked and visible to UI Automation @real-conformance', async ({ desktopSession }) => {
    const info = (await desktopSession.send({ op: 'environment' })) as EnvironmentInfo;
    expect(info.userInteractive, 'a logged-in interactive session').toBe(true);
    expect(info.desktopAccessible, 'the workstation is unlocked / the RDP session is connected').toBe(true);
    expect(info.uiaAvailable, 'UI Automation works').toBe(true);
    expect(info.allowedProgIds.length, 'the COM allow-list leaves something creatable').toBeGreaterThan(0);
  });

  test('the Enterprise Guide COM class can be created @real-conformance @eg-com', async ({ egCom }) => {
    expect(egCom.progId).toMatch(/^SASEGObjectModel\.Application\./);
    expect(await egCom.version()).not.toBe('');
  });
});
