import { AdapterError } from '@automation/referenced-automation-utils';

/**
 * The application rejected the user name or password (or the account is locked).
 *
 * The desktop layer NEVER retries after this: it raises the error and stops. The caller hands it to the logon guard (src/core)
 * so the same credentials are refused for a cooldown - a rejected password retried by a CI re-run is how accounts get locked.
 * The error carries who and where, and the text the application showed, but never the password.
 */
export class LogonRejected extends AdapterError {
  constructor(
    /** Which application: 'smc', 'eg' or a window title. */
    readonly app: string,
    readonly user: string,
    /** The metadata profile / server profile that was being connected to, when known. */
    readonly profile: string | undefined,
    /** What the application said ("Invalid user ID or password", "The account is locked"). */
    readonly reason: string,
  ) {
    super(
      'desktop-logon',
      'logon',
      `${app} rejected the logon of ${user}${profile ? ` on profile "${profile}"` : ''}: ${reason || '(no message shown)'}. ` +
        'The logon is NOT retried: another wrong password can lock the account. Fix the password, then run again.',
    );
    this.name = 'LogonRejected';
    Object.setPrototypeOf(this, LogonRejected.prototype);
  }
}

/** A control was not on the screen in time. The message ends with what IS on the screen (see screenHints.ts). */
export class DesktopElementNotFoundError extends AdapterError {
  constructor(
    readonly description: string,
    readonly waitedMs: number,
    readonly screen: string,
    cause?: unknown,
  ) {
    super('desktop-ui', 'locate', `no control matched ${description} after ${waitedMs}ms${screen ? `\n${screen}` : ''}`, { cause });
    this.name = 'DesktopElementNotFoundError';
    Object.setPrototypeOf(this, DesktopElementNotFoundError.prototype);
  }
}

/** A strict locator matched more than one control. */
export class AmbiguousLocatorError extends AdapterError {
  constructor(
    readonly description: string,
    readonly matches: string[],
    readonly total: number,
  ) {
    super(
      'desktop-ui',
      'locate',
      `${description} is ambiguous: ${total} controls match (${matches.slice(0, 6).join('; ')}${total > 6 ? '; ...' : ''}). ` +
        'Narrow it (add a name / automation id / control type, chain from a container), or say .first() / .nth(i) on purpose.',
    );
    this.name = 'AmbiguousLocatorError';
    Object.setPrototypeOf(this, AmbiguousLocatorError.prototype);
  }
}

/** The bridge script that is about to run is not the one this version of the framework was built with. */
export class BridgeTamperedError extends AdapterError {
  constructor(
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      'desktop-bridge',
      'verify',
      `${file} is not the bridge script this version of the framework ships (expected SHA-256 ${expected}, found ${actual}). ` +
        'Refusing to run a modified or outdated copy. Restore the original, or - if you changed it on purpose and it was reviewed - rebuild: node bridge/generate-hash.js',
    );
    this.name = 'BridgeTamperedError';
    Object.setPrototypeOf(this, BridgeTamperedError.prototype);
  }
}

/** A COM class was refused because it is not on the allow-list (SAS_COM_PROGIDS). */
export class ComClassRefusedError extends AdapterError {
  constructor(
    readonly progId: string,
    readonly allowed: string[],
  ) {
    super(
      'desktop-com',
      'create',
      `the COM class "${progId}" is not on the allow-list (${allowed.join(', ') || 'empty'}). Only the SAS classes are reachable; to allow another, add it to SAS_COM_PROGIDS (and have security review why).`,
    );
    this.name = 'ComClassRefusedError';
    Object.setPrototypeOf(this, ComClassRefusedError.prototype);
  }
}
