import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { Credentials, LogonCooldownError, LogonGuard, LogonRejectedError } from '../../src/core';
import { FAKE_EG_PATH, FAKE_SMC_PATH, LogonRejected, SasEnterpriseGuideUi, SasManagementConsole, clearRejectedLogons, startFakeDesktop, type FakeSasDesktopOptions } from '../../src/desktop';
import { CredentialSource, LogonHelper, classifyLogonFailure } from '../../src/fixtures';
import { captureLogs } from '../desktop/support';
import { reader, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();
test.beforeEach(() => clearRejectedLogons());

// The logons of both programs always go through the core LogonGuard: a rejected one is typed once and refused afterwards.

function rig(options: FakeSasDesktopOptions = {}, values: Record<string, string> = {}) {
  const dir = tempDir();
  const env = reader({ SAS_STATE_DIR: dir, ...values });
  const fake = startFakeDesktop(options);
  const guard = new LogonGuard({ env });
  const credentials = new CredentialSource(env, fake);
  const helper = new LogonHelper({ guard, credentials, environment: 'simulator', defaultProfiles: { smc: 'Dev Metadata Server', eg: 'Dev SAS Server' } });
  const wrong = (application: 'smc' | 'eg') => new Credentials({ application, user: helper.credentialsFor(application).user, password: `wrong-${Math.random().toString(36).slice(2)}-Zx9` });
  const launchSmc = () => SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
  return { dir, env, fake, guard, helper, wrong, launchSmc };
}

test('a correct logon works, writes no marker, and the password is typed once into a secret field', async () => {
  const { fake, helper, guard, launchSmc } = rig();
  const smc = await launchSmc();
  await helper.smc(smc);
  expect(fake.smc.attempts).toEqual([{ user: 'sasdemo', accepted: true }]);
  expect(fs.existsSync(guard.markerFile)).toBe(false);
  await expect(smc.mainWindow.getByRole('Tree').resolve()).resolves.toMatchObject({ controlType: 'Tree' });
});

test('a rejected logon: ONE attempt, a marker, a LogonRejectedError that says what to check - and no password anywhere', async () => {
  const { fake, helper, guard, wrong, launchSmc } = rig();
  const smc = await launchSmc();
  const bad = wrong('smc');
  const captured = await captureLogs(() => helper.smc(smc, bad));
  expect(captured.error).toBeInstanceOf(LogonRejectedError);
  expect((captured.error as LogonRejectedError).cause).toBeInstanceOf(LogonRejected);
  expect((captured.error as Error).message).toContain('Do NOT run the tests again');
  expect(fake.smc.attempts).toEqual([{ user: 'sasdemo', accepted: false }]);
  const marker = JSON.parse(fs.readFileSync(guard.markerFile, 'utf8')) as { failures: Array<{ user: string; application: string; environment: string }> };
  expect(marker.failures).toMatchObject([{ user: 'sasdemo', application: 'smc', environment: 'simulator' }]);
  const everything = `${(captured.error as Error).message}\n${captured.lines.join('\n')}\n${fs.readFileSync(guard.markerFile, 'utf8')}`;
  expect(everything).not.toContain(bad.reveal());
});

test('the same logon is then refused WITHOUT typing anything - what stops Playwright retries, CI re-runs and the next test', async () => {
  const { fake, helper, wrong, launchSmc } = rig();
  const smc = await launchSmc();
  const bad = wrong('smc');
  await expect(helper.smc(smc, bad)).rejects.toBeInstanceOf(LogonRejectedError);
  const typed = fake.desktop.calls.filter((c) => c.op === 'setText').length;
  // a second process (a retry starts a new worker): the in-process memory of the desktop layer is gone, only the marker remains
  clearRejectedLogons();
  const again = await launchSmc();
  const refusal = (await helper.smc(again, bad).catch((e: unknown) => e)) as LogonCooldownError;
  expect(refusal).toBeInstanceOf(LogonCooldownError);
  expect(refusal.message).toContain('logon NOT attempted');
  expect(fake.desktop.calls.filter((c) => c.op === 'setText').length).toBe(typed);
  expect(fake.smc.attempts).toHaveLength(1);
});

test('fixing the credentials clears the stop by itself: another password is a different fingerprint', async () => {
  const { fake, helper, wrong, launchSmc, guard } = rig();
  const smc = await launchSmc();
  await expect(helper.smc(smc, wrong('smc'))).rejects.toBeInstanceOf(LogonRejectedError);
  clearRejectedLogons();
  const fresh = await launchSmc(); // the rejected logon cancelled its dialog: the program is started again
  await helper.smc(fresh); // the configured (right) login
  expect(fake.smc.attempts.map((a) => a.accepted)).toEqual([false, true]);
  expect(guard.activeCooldown('simulator', helper.credentialsFor('smc'))).toBeUndefined();
});

test('a failure that is not a rejection (the program is too slow) writes no marker and is rethrown unchanged', async () => {
  const { fake, helper, guard } = rig({ smc: { logonDelayMs: 3_000 } });
  const smc = await SasManagementConsole.launch(fake.session({ timeoutMs: 600 }), { path: FAKE_SMC_PATH });
  const error = (await helper.smc(smc).catch((e: unknown) => e)) as Error;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(LogonRejectedError);
  expect(error).not.toBeInstanceOf(LogonCooldownError);
  expect(fs.existsSync(guard.markerFile)).toBe(false);
});

test('SAS_LOGON_FAILURE_COOLDOWN_MIN=0 turns the cross-run protection off: no marker is written', async () => {
  const { helper, guard, wrong, launchSmc } = rig({}, { SAS_LOGON_FAILURE_COOLDOWN_MIN: '0' });
  const smc = await launchSmc();
  await expect(helper.smc(smc, wrong('smc'))).rejects.toBeInstanceOf(LogonRejectedError);
  expect(fs.existsSync(guard.markerFile)).toBe(false);
});

test('Enterprise Guide\'s screens connect through the same guard: rejected once, then refused', async () => {
  const { fake, helper, wrong, guard } = rig();
  const eg = await SasEnterpriseGuideUi.launch(fake.session(), { path: FAKE_EG_PATH });
  const bad = wrong('eg');
  await expect(helper.eg(eg, bad)).rejects.toBeInstanceOf(LogonRejectedError);
  expect(fake.eg.attempts).toHaveLength(1);
  expect(guard.activeCooldown('simulator', bad)?.marker.application).toBe('eg');
  clearRejectedLogons();
  const again = await SasEnterpriseGuideUi.launch(fake.session(), { path: FAKE_EG_PATH });
  await expect(helper.eg(again, bad)).rejects.toBeInstanceOf(LogonCooldownError);
  expect(fake.eg.attempts).toHaveLength(1);
  const fresh = await SasEnterpriseGuideUi.launch(fake.session(), { path: FAKE_EG_PATH });
  await helper.eg(fresh);
  expect(fake.eg.attempts.map((a) => a.accepted)).toEqual([false, true]);
});

test('classifyLogonFailure: only the application saying "rejected" counts', () => {
  expect(classifyLogonFailure(new LogonRejected('smc', 'u', undefined, 'Invalid user ID or password.'))).toBe('rejected-credentials');
  expect(classifyLogonFailure(new Error('timed out'))).toBe('other');
  expect(classifyLogonFailure('Invalid user ID or password')).toBe('other');
});

test('the profile comes from the settings, else the stand-in\'s first one; a missing profile is the desktop layer\'s clear error', async () => {
  const { fake, env, guard } = rig();
  const noProfile = new LogonHelper({ guard, credentials: new CredentialSource(env, fake), environment: 'simulator' });
  const smc = await SasManagementConsole.launch(fake.session(), { path: FAKE_SMC_PATH });
  const error = (await noProfile.smc(smc).catch((e: unknown) => e)) as Error;
  expect(error.message).toContain('SAS_SMC_PROFILE');
  expect(path.basename(guard.markerFile)).toBe('logon-failed.json');
  expect(fs.existsSync(guard.markerFile)).toBe(false); // a missing setting is not a rejected password
});
