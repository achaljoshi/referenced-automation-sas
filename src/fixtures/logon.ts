import type { Credentials, LogonFailureClass, LogonGuard } from '../core';
import { LogonRejected, type SasEnterpriseGuideUi, type SasManagementConsole } from '../desktop';
import type { CredentialSource } from './credentials';

/**
 * The logons of the two programs, always through the core `LogonGuard`:
 *
 *  - A logon that was just rejected (same environment + application + user + password, within SAS_LOGON_FAILURE_COOLDOWN_MIN) is
 *    REFUSED before anything is typed - this is what stops Playwright's retries, a CI re-run or the next test from repeating a wrong
 *    logon until the account locks.
 *  - A logon the application rejects (the desktop layer's `LogonRejected`) writes the marker and becomes a `LogonRejectedError`
 *    that says what to check. It is never retried here.
 *  - Anything else (a timeout, a missing control) is not a rejection: it is rethrown unchanged and writes no marker.
 */

/** Only the application saying "wrong user or password" counts as a rejection. */
export function classifyLogonFailure(error: unknown): LogonFailureClass {
  return error instanceof LogonRejected ? 'rejected-credentials' : 'other';
}

export interface LogonHelperOptions {
  guard: LogonGuard;
  credentials: CredentialSource;
  environment: string;
  /** The profile to connect to when the settings name none (the stand-in's first profile). */
  defaultProfiles?: { smc?: string; eg?: string };
}

export class LogonHelper {
  constructor(private readonly options: LogonHelperOptions) {}

  get guard(): LogonGuard {
    return this.options.guard;
  }

  get environment(): string {
    return this.options.environment;
  }

  /** The login the fixtures use for an application (see CredentialSource). */
  credentialsFor(application: 'smc' | 'eg'): Credentials {
    return this.options.credentials.for(application);
  }

  /** Logs on to Management Console as `credentials` (default: the configured login for `smc`), under the logon guard. */
  async smc(smc: SasManagementConsole, credentials: Credentials = this.credentialsFor('smc')): Promise<void> {
    const profile = this.options.defaultProfiles?.smc;
    await this.options.guard.protect(
      this.options.environment,
      credentials,
      () => smc.logon({ user: credentials.user, password: credentials.reveal() }, profile ? { profile } : {}),
      classifyLogonFailure,
    );
  }

  /** Connects Enterprise Guide's screens as `credentials` (default: the configured login for `eg`), under the logon guard. */
  async eg(eg: SasEnterpriseGuideUi, credentials: Credentials = this.credentialsFor('eg')): Promise<void> {
    const profile = this.options.defaultProfiles?.eg;
    await this.options.guard.protect(
      this.options.environment,
      credentials,
      () => eg.connect({ user: credentials.user, password: credentials.reveal() }, profile ? { profile } : {}),
      classifyLogonFailure,
    );
  }
}
