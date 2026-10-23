import { startFakeDesktop } from '../../src/desktop';
import { desktopExpect as expect, desktopTest, publishStandInEnvironment, standInIdentity } from '../../src/fixtures';
import { expect as plainExpect, test } from '@playwright/test';
import { settings } from './desktopSupport';

// Tests - above all converted recordings - read the login and the profile names from the environment. On the stand-in these are ITS values for the
// duration of the test, whatever is configured for the real programs; afterwards the environment is exactly as it was.

test.describe('publishStandInEnvironment', () => {
  test('sets the stand-in\'s own login and profile names, and puts everything back (present values restored, absent values removed)', () => {
    const who = standInIdentity();
    const target: NodeJS.ProcessEnv = { SAS_USER: 'real.person', SAS_SMC_PROFILE: 'Prod Metadata Server', UNRELATED: 'x' };
    const restore = publishStandInEnvironment(target);
    plainExpect(target).toMatchObject({ SAS_USER: who.user, SAS_PASSWORD: who.password, SAS_SMC_PROFILE: who.smcProfile, SAS_EG_PROFILE: who.egProfile, UNRELATED: 'x' });
    restore();
    plainExpect(target).toEqual({ SAS_USER: 'real.person', SAS_SMC_PROFILE: 'Prod Metadata Server', UNRELATED: 'x' });
  });

  test('a setting a test supplied on purpose is left alone', () => {
    const target: NodeJS.ProcessEnv = { SAS_SMC_PROFILE: 'Chosen By The Test' };
    const restore = publishStandInEnvironment(target, new Set(['SAS_SMC_PROFILE']));
    plainExpect(target.SAS_SMC_PROFILE).toBe('Chosen By The Test');
    plainExpect(target.SAS_USER).toBe(standInIdentity().user);
    restore();
    plainExpect(target).toEqual({ SAS_SMC_PROFILE: 'Chosen By The Test' });
  });

  test('the identity is the stand-in\'s own: the demo account and the first profile of each program, as a fresh stand-in has them', () => {
    const fake = startFakeDesktop();
    plainExpect(standInIdentity()).toEqual({ user: fake.smc.options.accounts[0]?.user, password: fake.smc.options.accounts[0]?.password, smcProfile: fake.smc.options.profiles[0], egProfile: fake.eg.options.profiles[0] });
  });
});

desktopTest.use({ desktopSimulator: true, sasSettings: settings() });

desktopTest('in a desktopTest the environment carries the stand-in\'s values for the test: a converted recording that reads them works unchanged', async ({ fakeDesktop }) => {
  expect(process.env.SAS_USER).toBe(fakeDesktop?.smc.options.accounts[0]?.user);
  expect(process.env.SAS_PASSWORD).toBe(fakeDesktop?.smc.options.accounts[0]?.password);
  expect(process.env.SAS_SMC_PROFILE).toBe(fakeDesktop?.smc.options.profiles[0]);
  expect(process.env.SAS_EG_PROFILE).toBe(fakeDesktop?.eg.options.profiles[0]);
});
