import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { Credentials, LogonGuard, PreflightFailed } from '../../src/core';
import { DesktopSession, DesktopTransportError, startFakeDesktop, type DesktopCommand, type DesktopTransport } from '../../src/desktop';
import { CredentialSource, credentialChecks, desktopHealthChecks, preflightChecks, runDesktopPreflight } from '../../src/fixtures';
import { reader, settingsFor, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

// The pre-flight gate: one clear failure, listing everything that is red, before the first test starts.

/** `values` is the configuration (files, environment); `overrides` is what a test supplies on purpose (the sasSettings option) - the only thing that changes the stand-in's login. */
function input(values: Record<string, string> = {}, simulated = true, overrides: Record<string, string> = {}) {
  const dir = tempDir();
  const fake = startFakeDesktop();
  const settings = settingsFor({ SAS_STATE_DIR: path.join(dir, 'state'), SAS_AUDIT_FILE: path.join(dir, 'audit.jsonl'), ...values }, { simulator: simulated, overrides });
  return { dir, fake, settings, session: fake.session(), credentials: new CredentialSource(settings.env, simulated ? fake : undefined, settings.explicit), guard: new LogonGuard({ env: settings.env }) };
}

/** A transport that answers like a bridge, except where `answers` says otherwise. */
function stub(answers: Record<string, unknown | Error>): DesktopTransport {
  return {
    request: async (command: DesktopCommand) => {
      const answer = answers[command.op];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
    close: async () => undefined,
  };
}

test.describe('a green gate', () => {
  test('on the stand-in every check is ok or skipped, and the report is a table of them', async () => {
    const report = await runDesktopPreflight(input());
    expect(report?.ok).toBe(true);
    expect(report?.rows.map((r) => r.name)).toEqual(['environment', 'state-dir', 'audit-log', 'credentials:smc', 'credentials:eg', 'desktop-bridge', 'desktop-session']);
    expect(report?.rows.every((r) => r.status === 'ok')).toBe(true);
    expect(report?.table).toContain('CHECK');
  });

  test('SAS_PREFLIGHT=false skips the whole gate: nothing is checked', async () => {
    const i = input({ SAS_PREFLIGHT: 'false', SAS_ENVIRONMENT: 'nowhere-at-all' }, false);
    expect(await runDesktopPreflight(i)).toBeUndefined();
  });
});

test.describe('a red gate says everything at once, and what to do', () => {
  test('an undeclared environment and an unwritable state folder are both reported in ONE failure with their hints', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const i = input({ SAS_STATE_DIR: path.join(blocker, 'state') }, true, { SAS_ENVIRONMENT: 'nowhere' });
    const error = (await runDesktopPreflight(i).catch((e: unknown) => e)) as PreflightFailed;
    expect(error).toBeInstanceOf(PreflightFailed);
    expect(error.report.rows.filter((r) => r.status === 'FAILED').map((r) => r.name).sort()).toEqual(['environment', 'state-dir']);
    expect(error.message).toContain('2 of ');
    expect(error.message).toContain('declare the environment in the environments file');
    expect(error.message).toContain('SAS_STATE_DIR');
    expect(error.message).toContain('no test was started');
    // the checks that could be made were still made
    expect(error.report.rows.find((r) => r.name === 'desktop-bridge')?.status).toBe('ok');
  });

  test('an active logon cooldown is reported BEFORE the first test, with the steps from its own message', async () => {
    const i = input();
    const login = i.credentials.for('smc');
    new LogonGuard({ env: i.settings.env }).recordRejection(i.settings.environmentName, login, 'Invalid user ID or password');
    const error = (await runDesktopPreflight(i).catch((e: unknown) => e)) as PreflightFailed;
    expect(error).toBeInstanceOf(PreflightFailed);
    const row = error.report.rows.find((r) => r.name === 'credentials:smc');
    expect(row?.status).toBe('FAILED');
    expect(row?.detail).toContain('logon NOT attempted');
    expect(error.message).toContain('SAS_SMC_USER');
    expect(error.report.rows.find((r) => r.name === 'credentials:eg')?.status).toBe('ok'); // another application's login is not affected
  });

  test('a half-set login pair is red and names the settings, never a value', async () => {
    const i = input({}, true, { SAS_SMC_USER: 'someone' });
    const error = (await runDesktopPreflight(i).catch((e: unknown) => e)) as PreflightFailed;
    const row = error.report.rows.find((r) => r.name === 'credentials:smc');
    expect(row?.status).toBe('FAILED');
    expect(row?.detail).toContain('SAS_SMC_PASSWORD');
    expect(error.message).not.toContain('someone-secret');
  });

  test('a dead bridge is red with the doctor hint', async () => {
    const session = new DesktopSession(stub({ ping: new DesktopTransportError('the bridge process exited', 'BRIDGE_EXITED') }));
    const [bridge] = desktopHealthChecks(session, false);
    await expect(Promise.resolve(bridge?.run())).rejects.toThrow(/bridge process exited/);
    expect(bridge?.hint).toContain('npm run doctor');
  });

  test('a locked or non-interactive desktop is red and says which', async () => {
    const info = { os: 'Windows', sessionName: 'RDP-Tcp#1', userInteractive: true, desktopAccessible: false, uiaAvailable: true, topLevelWindows: 0 };
    const session = new DesktopSession(stub({ ping: { bridge: 'b', version: 1 }, environment: info }));
    const [, desktop] = desktopHealthChecks(session, false);
    expect(await desktop?.run()).toMatchObject({ ok: false, detail: 'the desktop is locked or disconnected' });
    const service = new DesktopSession(stub({ environment: { ...info, desktopAccessible: true, userInteractive: false, uiaAvailable: false } }));
    const [, bad] = desktopHealthChecks(service, false);
    expect(await bad?.run()).toMatchObject({ ok: false, detail: 'not an interactive session; UI Automation is not available' });
    expect(desktop?.hint).toContain('unlock');
  });
});

test.describe('logins that are not configured', () => {
  test('without the stand-in and with nothing configured the check is skipped, never red: only the *LoggedOn fixtures need a login', () => {
    const i = input({}, false);
    const [smc] = credentialChecks(['smc'], i.credentials, i.guard, i.settings.environmentName);
    expect(smc?.skip?.()).toContain('no login configured');
    expect(i.credentials.available('smc')).toBe(false);
    expect(() => i.credentials.for('smc')).toThrow(/no user name for smc/);
  });

  test('a configured login is used for the real programs; the stand-in uses its own demo account unless a test supplies a login on purpose', () => {
    const real = input({ SAS_USER: 'real.person', SAS_PASSWORD: ['Zx9', 'real', 'login'].join('-') }, false);
    expect(real.credentials.for('eg').user).toBe('real.person');
    expect(real.credentials.for('eg').source).toBe('SAS_USER / SAS_PASSWORD');
    // with the stand-in the same configuration is ignored: a real password is never typed into a fake
    const ignored = input({ SAS_USER: 'real.person', SAS_PASSWORD: ['Zx9', 'real', 'login'].join('-') });
    expect(ignored.credentials.for('eg').user).toBe('sasdemo');
    expect(ignored.credentials.for('eg').source).toContain('stand-in');
    // a test that supplies one on purpose (sasSettings) gets it - per program
    const own = input({}, true, { SAS_EG_USER: 'e', SAS_EG_PASSWORD: ['Zx9', 'eg', 'login'].join('-') });
    expect(own.credentials.for('eg').user).toBe('e');
    expect(own.credentials.for('smc').source).toContain('stand-in'); // the other program still has the demo login
    expect(preflightChecks(input()).map((c) => c.name)).toContain('credentials:smc');
  });

  test('a login is never printed: the Credentials object masks the password everywhere', () => {
    const secret = ['Zx9', randomUUID()].join('-'); // made up per run
    const login = new Credentials({ application: 'smc', user: 'u', password: secret });
    expect(JSON.stringify(login)).not.toContain(secret);
    expect(String(login)).not.toContain(secret);
    expect(reader({}).has('SAS_PASSWORD')).toBe(false);
  });
});
