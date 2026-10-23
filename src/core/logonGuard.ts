import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import type { Credentials } from './credentials';
import { maskSecrets } from './secrets';
import { stateDir } from './stateDir';

/**
 * Protection against locking a personal account by repeating a logon that cannot work.
 *
 * A wrong logon is counted by the directory or the SAS server, and a few of them lock the account (the limit is the organisation's
 * policy, not ours). A run that fails on a wrong password is routinely started again - by a CI retry, by the next test of the same
 * worker, by a person pressing "run" once more - and every repetition is another wrong logon. So after a logon the CALLER classified as
 * "rejected credentials" the guard writes a marker, and refuses to attempt the same environment + application + user + password again
 * for SAS_LOGON_FAILURE_COOLDOWN_MIN minutes. Nothing is sent to SAS when it refuses.
 *
 * The marker holds environment, application, user, a salted scrypt fingerprint of the password (never the password), the time and a
 * short reason. A different password, user, application or environment does not match, so fixing the credentials clears the stop by itself.
 * One file holds the markers of every environment/application/user (a failure in qa must not erase the protection of dev).
 *
 * Where: `.sas-state/logon-failed.json` (SAS_STATE_DIR). Not under test-results: Playwright empties that folder at the start of every run.
 *
 * What counts as "rejected credentials" is the caller's decision (it knows the tool's exit code or the dialog text); a timeout, a network
 * error or a server that is down is NOT a rejection and writes no marker.
 */

const log = getLogger('sas-logon');

export const LOGON_MARKER_FILE = 'logon-failed.json';
export const DEFAULT_LOGON_COOLDOWN_MIN = 15;
const KEEP_MARKERS_MS = 24 * 3_600_000;

export interface LogonFailureMarker {
  environment: string;
  application: string;
  user: string;
  /** scrypt of the password with `salt` - enough to recognise the same password again, not to read it back. */
  passwordFingerprint: string;
  salt: string;
  /** ISO time of the rejected logon. */
  at: string;
  /** Why the caller classified it as rejected credentials (short, masked). */
  reason: string;
}

interface MarkerFile {
  version: 1;
  failures: LogonFailureMarker[];
}

/** SAS_LOGON_FAILURE_COOLDOWN_MIN: minutes to refuse the same logon after it was rejected (default 15; 0 turns the protection off). */
export function logonCooldownMinutes(env: ConfigReader = loadEnv()): number {
  const minutes = env.getInt('SAS_LOGON_FAILURE_COOLDOWN_MIN', DEFAULT_LOGON_COOLDOWN_MIN);
  if (minutes < 0) throw new Error(`SAS_LOGON_FAILURE_COOLDOWN_MIN must be 0 (off) or a number of minutes (found ${minutes})`);
  return minutes;
}

export function logonMarkerPath(dir: string = stateDir()): string {
  return path.resolve(dir, LOGON_MARKER_FILE);
}

function fingerprint(credentials: Credentials, salt: string): string {
  return credentials.fingerprint(salt);
}

function sameWho(marker: LogonFailureMarker, environment: string, credentials: Credentials): boolean {
  return (
    marker.environment.toLowerCase() === environment.toLowerCase() &&
    marker.application.toLowerCase() === credentials.application.toLowerCase() &&
    marker.user.toLowerCase() === credentials.user.toLowerCase()
  );
}

function validMarker(m: Partial<LogonFailureMarker>): m is LogonFailureMarker {
  return (
    typeof m.environment === 'string' &&
    typeof m.application === 'string' &&
    typeof m.user === 'string' &&
    typeof m.salt === 'string' &&
    typeof m.passwordFingerprint === 'string' &&
    typeof m.at === 'string' &&
    !Number.isNaN(Date.parse(m.at))
  );
}

/** The markers on disk; empty when there is no file or it cannot be read (a damaged marker protects nothing, so it is ignored). */
export function readLogonFailures(dir: string = stateDir()): LogonFailureMarker[] {
  try {
    const file = JSON.parse(fs.readFileSync(logonMarkerPath(dir), 'utf8')) as Partial<MarkerFile>;
    if (Array.isArray(file.failures)) return file.failures.filter(validMarker);
  } catch {
    /* no marker, or not readable */
  }
  return [];
}

function writeMarkers(markers: LogonFailureMarker[], dir: string): string {
  const file = logonMarkerPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, failures: markers } satisfies MarkerFile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file); // atomic: two workers never see half a file
  return file;
}

/** Records that this environment / application / user / password was just rejected. Never throws: a marker that cannot be written must not hide the logon failure. */
export function writeLogonFailure(environment: string, credentials: Credentials, reason: string, dir: string = stateDir(), now: number = Date.now()): string | undefined {
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const marker: LogonFailureMarker = {
      environment: environment.toLowerCase(),
      application: credentials.application.toLowerCase(),
      user: credentials.user,
      passwordFingerprint: fingerprint(credentials, salt),
      salt,
      at: new Date(now).toISOString(),
      reason: maskSecrets(reason).slice(0, 300),
    };
    const kept = readLogonFailures(dir).filter((m) => !sameWho(m, environment, credentials) && now - Date.parse(m.at) < KEEP_MARKERS_MS);
    return writeMarkers([...kept, marker], dir);
  } catch (error) {
    log.warn(`[sas-logon] could not write the logon-failure marker: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Removes the markers of this environment / application / user (the credentials worked, or a person decided to). Never throws. */
export function clearLogonFailure(environment: string, credentials: Credentials, dir: string = stateDir()): void {
  try {
    const all = readLogonFailures(dir);
    const rest = all.filter((m) => !sameWho(m, environment, credentials));
    if (rest.length === all.length) return;
    if (rest.length === 0) fs.rmSync(logonMarkerPath(dir), { force: true });
    else writeMarkers(rest, dir);
  } catch (error) {
    log.warn(`[sas-logon] could not update the logon-failure marker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Is there a marker for exactly this environment, application, user and password still within its cooldown? */
export function activeLogonCooldown(
  environment: string,
  credentials: Credentials,
  cooldownMinutes: number,
  dir: string = stateDir(),
  now: number = Date.now(),
): { marker: LogonFailureMarker; remainingMs: number } | undefined {
  if (cooldownMinutes <= 0) return undefined;
  const cooldownMs = cooldownMinutes * 60_000;
  for (const marker of readLogonFailures(dir)) {
    if (!sameWho(marker, environment, credentials)) continue;
    if (marker.passwordFingerprint !== fingerprint(credentials, marker.salt)) continue;
    const elapsed = now - Date.parse(marker.at);
    if (elapsed > cooldownMs || elapsed < -cooldownMs) continue; // over, or a timestamp too far in the future to be trusted
    return { marker, remainingMs: cooldownMs - Math.max(0, elapsed) };
  }
  return undefined;
}

/** Thrown instead of attempting a logon that was just rejected. Nothing was sent to SAS. */
export class LogonCooldownError extends AdapterError {
  constructor(
    readonly marker: LogonFailureMarker,
    readonly remainingMs: number,
    readonly markerFile: string,
    cooldownMinutes: number,
  ) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    super(
      'sas-logon',
      'logon',
      `logon NOT attempted - it would have repeated a logon that ${marker.application} in "${marker.environment}" has just rejected, and repeated wrong logons can LOCK the account. ` +
        `At ${marker.at} the logon as "${marker.user}" failed (${marker.reason || 'rejected credentials'}), and this run has the same environment, application, user and password. Nothing was sent to SAS.\n` +
        `To go on, do ONE of these:\n` +
        `  1. fix the credentials (SAS_USER / SAS_PASSWORD, or the application's own SAS_<APP>_USER / SAS_<APP>_PASSWORD) - a changed password or user clears this stop by itself;\n` +
        `  2. if the password was reset or the account unlocked and you are sure the current values are right: delete ${markerFile}\n` +
        `  3. wait ${minutes} more minute(s) (SAS_LOGON_FAILURE_COOLDOWN_MIN=${cooldownMinutes}; 0 turns this protection off - not advised on a shared system).`,
    );
    this.name = 'LogonCooldownError';
    Object.setPrototypeOf(this, LogonCooldownError.prototype);
  }
}

/** A logon was rejected; the original failure is the `cause`. Says what to check and warns not to run again. The password is never printed. */
export class LogonRejectedError extends AdapterError {
  constructor(
    environment: string,
    credentials: Credentials,
    cause: unknown,
    protection: { cooldownMinutes: number; markerFile?: string },
  ) {
    const reason = maskSecrets(cause instanceof Error ? cause.message : String(cause)).split('\n')[0] ?? '';
    super(
      'sas-logon',
      'logon',
      `${credentials.application} in "${environment}" rejected the credentials of "${credentials.user}": ${reason}\n` +
        `They came from ${credentials.source}. What to check: the user and password are the ones that work when you log on by hand (a value exported in your shell wins over .env.<ENV>.local; a password with # or spaces needs double quotes in the .env file); the account may be locked or its password expired.\n` +
        `WARNING: repeated wrong logons can LOCK the account. Do NOT run the tests again until the credentials are fixed.` +
        (protection.cooldownMinutes > 0 ? ` Until then this framework refuses to repeat the same logon for ${protection.cooldownMinutes} minute(s)${protection.markerFile ? ` (marker: ${protection.markerFile})` : ''}.` : ''),
      { cause },
    );
    this.name = 'LogonRejectedError';
    Object.setPrototypeOf(this, LogonRejectedError.prototype);
  }
}

export type LogonFailureClass = 'rejected-credentials' | 'other';

export interface LogonGuardOptions {
  dir?: string;
  /** Overrides SAS_LOGON_FAILURE_COOLDOWN_MIN. */
  cooldownMinutes?: number;
  env?: ConfigReader;
  now?: () => number;
}

/** The guard a driver calls around every logon. */
export class LogonGuard {
  readonly dir: string;
  readonly cooldownMinutes: number;
  private readonly now: () => number;

  constructor(options: LogonGuardOptions = {}) {
    const env = options.env ?? loadEnv();
    this.dir = options.dir ?? stateDir(env);
    this.cooldownMinutes = options.cooldownMinutes ?? logonCooldownMinutes(env);
    this.now = options.now ?? Date.now;
  }

  get markerFile(): string {
    return logonMarkerPath(this.dir);
  }

  activeCooldown(environment: string, credentials: Credentials) {
    return activeLogonCooldown(environment, credentials, this.cooldownMinutes, this.dir, this.now());
  }

  /** Throws LogonCooldownError when this logon was rejected within the cooldown. Call it BEFORE sending anything to SAS. */
  assertAllowed(environment: string, credentials: Credentials): void {
    const active = this.activeCooldown(environment, credentials);
    if (active) throw new LogonCooldownError(active.marker, active.remainingMs, this.markerFile, this.cooldownMinutes);
  }

  /** Writes the marker (unless the protection is off). Returns the marker file, or undefined. */
  recordRejection(environment: string, credentials: Credentials, reason: string): string | undefined {
    if (this.cooldownMinutes <= 0) return undefined;
    return writeLogonFailure(environment, credentials, reason, this.dir, this.now());
  }

  recordSuccess(environment: string, credentials: Credentials): void {
    clearLogonFailure(environment, credentials, this.dir);
  }

  /**
   * Runs one logon attempt under the guard: refuses it when it was just rejected, clears the marker when it works, and when it fails
   * with a failure the caller `classify`s as `rejected-credentials` writes the marker and throws LogonRejectedError (cause: the
   * original error). Any other failure is rethrown unchanged and writes nothing.
   */
  async protect<T>(
    environment: string,
    credentials: Credentials,
    attempt: () => Promise<T> | T,
    classify: (error: unknown) => LogonFailureClass,
  ): Promise<T> {
    this.assertAllowed(environment, credentials);
    let result: T;
    try {
      result = await attempt();
    } catch (error) {
      if (classify(error) !== 'rejected-credentials') throw error;
      const markerFile = this.recordRejection(environment, credentials, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
      log.error(`[sas-logon] ${credentials.application} in "${environment}" rejected the credentials of "${credentials.user}"${markerFile ? ` - marker written: ${markerFile}` : ''}`);
      throw new LogonRejectedError(environment, credentials, error, { cooldownMinutes: this.cooldownMinutes, markerFile });
    }
    this.recordSuccess(environment, credentials);
    return result;
  }
}
