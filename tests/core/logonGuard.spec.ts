import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  Credentials,
  LogonCooldownError,
  LogonGuard,
  LogonRejectedError,
  activeLogonCooldown,
  logonCooldownMinutes,
  logonMarkerPath,
  readLogonFailures,
  stateDir,
  writeLogonFailure,
  type LogonFailureClass,
} from '../../src/core';
import { config, tempDir, useCleanSasEnv } from './support';

/**
 * A rejected logon is counted by the directory or SAS server and a few of them lock the account. A run that fails on it is started
 * again by CI retries, by the next test of the worker, by a person pressing "run" - so after a rejected logon the same
 * environment + application + user + password is refused, without contacting SAS, for SAS_LOGON_FAILURE_COOLDOWN_MIN minutes.
 */
class FakeSas {
  attempts = 0;
  failed = 0;
  locked = false;
  constructor(private readonly good = { user: 'ajoshi', password: 'correct-horse' }, private readonly lockAfter = 3) {}
  async logon(credentials: Credentials): Promise<string> {
    this.attempts++;
    if (this.locked) throw Object.assign(new Error('account locked out'), { kind: 'rejected' });
    if (credentials.user.toLowerCase() === this.good.user && credentials.reveal() === this.good.password) return 'session-1';
    this.failed++;
    if (this.failed >= this.lockAfter) this.locked = true;
    throw Object.assign(new Error('The user name or password is not correct (logon rejected)'), { kind: 'rejected' });
  }
}

const classify = (error: unknown): LogonFailureClass => ((error as { kind?: string }).kind === 'rejected' ? 'rejected-credentials' : 'other');
const wrongPassword = 'Wr0ng-pa55#word';
const wrong = (user = 'ajoshi', application = 'smc') => new Credentials({ application, user, password: wrongPassword });
const good = (application = 'smc') => new Credentials({ application, user: 'ajoshi', password: 'correct-horse' });

let dir = '';
useCleanSasEnv();
test.beforeEach(() => {
  dir = tempDir('sas-logon-guard-');
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const guard = (cooldownMinutes?: number, now?: () => number) => new LogonGuard({ dir, env: config(), ...(cooldownMinutes === undefined ? {} : { cooldownMinutes }), ...(now ? { now } : {}) });
const attempt = (sas: FakeSas, g: LogonGuard, credentials: Credentials, environment = 'dev') => g.protect(environment, credentials, () => sas.logon(credentials), classify);

test.describe('what the failure message says', () => {
  test('keeps the cause, says where the credentials came from and what to check - without the password', async () => {
    const error = (await attempt(new FakeSas(), guard(), wrong()).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(LogonRejectedError);
    expect((error as LogonRejectedError).cause).toBeInstanceOf(Error);
    expect(error.message).toContain('smc in "dev" rejected the credentials of "ajoshi": The user name or password is not correct');
    expect(error.message).toContain('They came from (supplied by code)');
    expect(error.message).toMatch(/special characters|# or spaces needs double quotes/);
    expect(error.message).toMatch(/account may be locked/);
    expect(error.message).toMatch(/WARNING: repeated wrong logons can LOCK the account\. Do NOT run the tests again until the credentials are fixed/);
    expect(error.message).not.toContain(wrongPassword);
  });

  test('mentions the cooldown and the marker file when it armed it, and nothing about it when the protection is off', async () => {
    const armed = (await attempt(new FakeSas(), guard(), wrong()).catch((e: unknown) => e)) as Error;
    expect(armed.message).toContain('refuses to repeat the same logon for 15 minute(s)');
    expect(armed.message).toContain(logonMarkerPath(dir));
    const off = (await attempt(new FakeSas(), guard(0), wrong()).catch((e: unknown) => e)) as Error;
    expect(off.message).not.toContain('refuses to repeat');
  });

  test('a password the server echoes in its own message is masked in ours and in the marker', async () => {
    const credentials = wrong();
    const error = (await guard()
      .protect('dev', credentials, () => { throw Object.assign(new Error(`bad password ${wrongPassword}`), { kind: 'rejected' }); }, classify)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(wrongPassword);
    expect(fs.readFileSync(logonMarkerPath(dir), 'utf8')).not.toContain(wrongPassword);
  });
});

test.describe('the marker', () => {
  test('holds environment, application, user, a salted fingerprint of the password and a time - and the password is nowhere in the file', async () => {
    const before = Date.now();
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    const text = fs.readFileSync(logonMarkerPath(dir), 'utf8');
    const marker = JSON.parse(text).failures[0];
    expect(marker).toMatchObject({ environment: 'dev', application: 'smc', user: 'ajoshi' });
    expect(marker.reason).toMatch(/not correct/);
    expect(Date.parse(marker.at)).toBeGreaterThanOrEqual(before - 1_000);
    expect(marker.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(marker.passwordFingerprint).toMatch(/^[0-9a-f]{48}$/);
    expect(text).not.toContain(wrongPassword);
    expect(text).not.toContain('pa55');

    // a second marker for the same password has another salt: two files cannot be compared to find a shared password
    writeLogonFailure('dev', wrong(), 'x', dir);
    const second = readLogonFailures(dir)[0];
    expect(second?.salt).not.toBe(marker.salt);
    expect(second?.passwordFingerprint).not.toBe(marker.passwordFingerprint);
  });

  test('is owner-only (0600)', async () => {
    test.skip(process.platform === 'win32', 'POSIX file modes');
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    expect(fs.statSync(logonMarkerPath(dir)).mode & 0o777).toBe(0o600);
  });

  test('is not under test-results (Playwright empties that folder at the start of every run) - the default is .sas-state - and that folder is git-ignored', () => {
    const file = logonMarkerPath();
    expect(path.relative(process.cwd(), file)).toBe(path.join('.sas-state', 'logon-failed.json'));
    expect(file).not.toContain('test-results');
    expect(fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')).toMatch(/^\.sas-state\/$/m);
    expect(stateDir(config({ SAS_STATE_DIR: dir }))).toBe(dir);
  });

  test('is not written for a failure the caller did not classify as rejected credentials (a timeout, a server that is down)', async () => {
    const error = (await guard().protect('dev', wrong(), () => { throw new Error('connect ETIMEDOUT'); }, classify).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('connect ETIMEDOUT');
    expect(error).not.toBeInstanceOf(LogonRejectedError);
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(false);
  });

  test('a damaged marker protects nothing and breaks nothing', async () => {
    fs.writeFileSync(logonMarkerPath(dir), '{ not json');
    expect(await attempt(new FakeSas(), guard(), good())).toBe('session-1');
    fs.writeFileSync(logonMarkerPath(dir), JSON.stringify({ version: 1, failures: [{ user: 5 }, 'x'] }));
    expect(await attempt(new FakeSas(), guard(), good())).toBe('session-1');
  });
});

test.describe('the cooldown', () => {
  test('the same environment, application, user and password is refused at once - nothing is sent to SAS, the account is not counted again', async () => {
    const sas = new FakeSas();
    await expect(attempt(sas, guard(), wrong())).rejects.toBeInstanceOf(LogonRejectedError);
    expect(sas.failed).toBe(1);
    // "run it again": a retry, the next test, a re-run
    const error = (await attempt(sas, guard(), wrong()).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(LogonCooldownError);
    expect(sas.attempts).toBe(1);
    expect(sas.failed).toBe(1);
  });

  test('says what happened, when, and the three ways on - and never the password', async () => {
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    const error = (await attempt(new FakeSas(), guard(), wrong()).catch((e: unknown) => e)) as LogonCooldownError;
    expect(error.message).toContain('logon NOT attempted');
    expect(error.message).toContain('smc in "dev" has just rejected');
    expect(error.message).toContain('repeated wrong logons can LOCK the account');
    expect(error.message).toContain(error.marker.at);
    expect(error.message).toMatch(/logon as "ajoshi" failed \(The user name or password is not correct/);
    expect(error.message).toMatch(/1\. fix the credentials .*changed password or user clears this stop by itself/);
    expect(error.message).toContain(`2. if the password was reset or the account unlocked and you are sure the current values are right: delete ${logonMarkerPath(dir)}`);
    expect(error.message).toMatch(/3\. wait \d+ more minute\(s\) \(SAS_LOGON_FAILURE_COOLDOWN_MIN=15; 0 turns this protection off/);
    expect(error.message).not.toContain(wrongPassword);
  });

  test('a changed password clears the stop by itself, and a successful logon removes the marker', async () => {
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(true);
    expect(await attempt(new FakeSas(), guard(), good())).toBe('session-1'); // the right password: another fingerprint, so it goes through
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(false);
  });

  test('a changed user, application or environment is not stopped, and its own failure is recorded next to the first (nothing is overwritten)', async () => {
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    for (const [who, environment] of [[wrong('other'), 'dev'], [wrong('ajoshi', 'eg'), 'dev'], [wrong(), 'qa']] as const) {
      const sas = new FakeSas();
      const error = (await attempt(sas, guard(), who, environment).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(LogonRejectedError);
      expect(sas.attempts).toBe(1); // it really tried
    }
    expect(readLogonFailures(dir).map((m) => `${m.environment}/${m.application}/${m.user}`).sort()).toEqual(['dev/eg/ajoshi', 'dev/smc/ajoshi', 'dev/smc/other', 'qa/smc/ajoshi']);
    // and each is still protected
    await expect(attempt(new FakeSas(), guard(), wrong(), 'dev')).rejects.toBeInstanceOf(LogonCooldownError);
    await expect(attempt(new FakeSas(), guard(), wrong(), 'qa')).rejects.toBeInstanceOf(LogonCooldownError);
  });

  test('a success clears only its own environment/application/user marker', async () => {
    await attempt(new FakeSas(), guard(), wrong('other')).catch(() => undefined);
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    await attempt(new FakeSas(), guard(), good());
    expect(readLogonFailures(dir).map((m) => m.user)).toEqual(['other']);
  });

  test('the user name is compared case-insensitively', async () => {
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    await expect(attempt(new FakeSas(), guard(), wrong('AJOSHI'), 'DEV')).rejects.toBeInstanceOf(LogonCooldownError);
  });

  test('ends after the cooldown; deleting the marker ends it at once', async () => {
    const credentials = wrong();
    writeLogonFailure('dev', credentials, 'x', dir, Date.now() - 20 * 60_000);
    expect(activeLogonCooldown('dev', credentials, 15, dir)).toBeUndefined();
    expect(activeLogonCooldown('dev', credentials, 30, dir)?.remainingMs).toBeGreaterThan(9 * 60_000);
    const sas = new FakeSas();
    await expect(attempt(sas, guard(), wrong())).rejects.toBeInstanceOf(LogonRejectedError); // really tried: not a cooldown error
    await expect(attempt(sas, guard(), wrong())).rejects.toBeInstanceOf(LogonCooldownError);
    fs.rmSync(logonMarkerPath(dir));
    await expect(attempt(sas, guard(), wrong())).rejects.toBeInstanceOf(LogonRejectedError);
  });

  test('a time stamp too far in the future is not trusted', () => {
    const credentials = wrong();
    writeLogonFailure('dev', credentials, 'x', dir, Date.now() + 3 * 3_600_000);
    expect(activeLogonCooldown('dev', credentials, 15, dir)).toBeUndefined();
  });

  test('time can be injected: the cooldown ends exactly when it says', async () => {
    let now = Date.parse('2026-10-23T10:00:00Z');
    const g = guard(15, () => now);
    await attempt(new FakeSas(), g, wrong()).catch(() => undefined);
    now += 14 * 60_000;
    await expect(attempt(new FakeSas(), g, wrong())).rejects.toBeInstanceOf(LogonCooldownError);
    now += 2 * 60_000;
    await expect(attempt(new FakeSas(), g, wrong())).rejects.toBeInstanceOf(LogonRejectedError);
  });

  test('SAS_LOGON_FAILURE_COOLDOWN_MIN: default 15, 0 turns the protection off (nothing is written and every attempt goes to SAS), not a number is an error', async () => {
    expect(logonCooldownMinutes(config())).toBe(15);
    expect(logonCooldownMinutes(config({ SAS_LOGON_FAILURE_COOLDOWN_MIN: '30' }))).toBe(30);
    expect(() => logonCooldownMinutes(config({ SAS_LOGON_FAILURE_COOLDOWN_MIN: 'soon' }))).toThrow(/not a valid integer/);
    expect(() => logonCooldownMinutes(config({ SAS_LOGON_FAILURE_COOLDOWN_MIN: '-5' }))).toThrow(/must be 0 \(off\)/);
    const off = new LogonGuard({ dir, env: config({ SAS_LOGON_FAILURE_COOLDOWN_MIN: '0' }) });
    const sas = new FakeSas(undefined, 99);
    for (let i = 0; i < 3; i++) await expect(attempt(sas, off, wrong())).rejects.toBeInstanceOf(LogonRejectedError);
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(false);
    expect(sas.attempts).toBe(3);
  });

  test('negative control - without the protection a retry loop locks the account; with it the account is hit once', async () => {
    const loop = async (cooldownMinutes: number) => {
      const sas = new FakeSas();
      for (let run = 0; run < 5; run++) await attempt(sas, guard(cooldownMinutes), wrong()).catch(() => undefined); // five CI retries / re-runs
      return sas;
    };
    expect((await loop(0)).locked).toBe(true);
    fs.rmSync(logonMarkerPath(dir), { force: true });
    const protectedRun = await loop(15);
    expect(protectedRun.locked).toBe(false);
    expect(protectedRun.failed).toBe(1);
  });

  test('assertAllowed alone (what a health check uses) refuses without running anything', async () => {
    await attempt(new FakeSas(), guard(), wrong()).catch(() => undefined);
    expect(() => guard().assertAllowed('dev', wrong())).toThrow(LogonCooldownError);
    expect(() => guard().assertAllowed('dev', good())).not.toThrow();
  });
});
