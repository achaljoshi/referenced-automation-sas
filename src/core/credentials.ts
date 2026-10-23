import * as crypto from 'node:crypto';
import { inspect } from 'node:util';
import { loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { ConfigurationError } from './errors';
import { MASK, registerSecret } from './secrets';

/**
 * A personal SAS login. The password is held in a true private field: it is not visible to `JSON.stringify`, `console.log`, `util.inspect`,
 * `Object.keys`, spread or `structuredClone`, and it is registered with the secret masker, so it is also removed from audit records and
 * error text. The only way to read it is the explicit `reveal()`, which only drivers that must type or send it should call.
 */
export class Credentials {
  readonly application: string;
  readonly user: string;
  /** Which settings it came from, e.g. `SAS_SMC_USER / SAS_SMC_PASSWORD` - for messages. */
  readonly source: string;
  readonly #secret: string;

  constructor(init: { application: string; user: string; password: string; source?: string }) {
    if (init.user.trim() === '') throw new ConfigurationError('credentials', 'the user name is empty');
    if (init.password === '') throw new ConfigurationError('credentials', 'the password is empty');
    this.application = init.application;
    this.user = init.user.trim();
    this.source = init.source ?? '(supplied by code)';
    this.#secret = init.password;
    registerSecret(init.password);
  }

  /** The password. Call it only where it must be typed into a dialog, sent on standard input or sent in a request. Never log it. */
  reveal(): string {
    return this.#secret;
  }

  /**
   * A scrypt fingerprint of the password under `salt` (hex): enough to recognise the same password again, not to read it back.
   * Used by the logon guard, which stores its own random salt. The default salt is fixed per user, so two calls agree.
   */
  fingerprint(salt: string = `sas-credentials-v1:${this.user.toLowerCase()}`): string {
    return crypto.scryptSync(this.#secret, salt, 24).toString('hex');
  }

  /** `user=ADMIN password=***` - safe to log. */
  describe(): string {
    return `${this.application} login as "${this.user}" (password ${MASK})`;
  }

  toJSON(): { application: string; user: string; password: string } {
    return { application: this.application, user: this.user, password: MASK };
  }

  toString(): string {
    return `Credentials(${this.application}, ${this.user}, ${MASK})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

const APPLICATION_PATTERN = /^[a-z][a-z0-9]{0,15}$/;

/** The setting names for an application: `smc` -> SAS_SMC_USER / SAS_SMC_PASSWORD. */
export function credentialVariables(application: string): { user: string; password: string } {
  if (!APPLICATION_PATTERN.test(application)) throw new ConfigurationError('credentials', `application "${application}" must be lower-case letters and digits (for example smc, eg)`);
  const prefix = `SAS_${application.toUpperCase()}`;
  return { user: `${prefix}_USER`, password: `${prefix}_PASSWORD` };
}

/**
 * The personal login for an application, read through the shared config (so `.env.<ENV>.local`, then real environment variables):
 * SAS_<APP>_USER / SAS_<APP>_PASSWORD (SAS_SMC_USER, SAS_EG_USER, ...) when either is set, otherwise SAS_USER / SAS_PASSWORD.
 *
 * User and password are always taken as a PAIR from one source. An application-specific user combined with the general password (or the
 * reverse) would send a mismatched pair to SAS - and a wrong pair counts towards the account lockout - so a half-set override is an error.
 */
export function credentialsFor(application: string, env: ConfigReader = loadEnv()): Credentials {
  const specific = credentialVariables(application);
  const general = { user: 'SAS_USER', password: 'SAS_PASSWORD' };
  const specificUser = env.getOptional(specific.user);
  const specificPassword = env.getOptional(specific.password);
  const useSpecific = specificUser !== undefined || specificPassword !== undefined;
  const names = useSpecific ? specific : general;
  const user = useSpecific ? specificUser : env.getOptional(general.user);
  const password = useSpecific ? specificPassword : env.getOptional(general.password);
  const where = `.env.${env.envName}.local or a masked CI variable`;
  if (user === undefined || user.trim() === '')
    throw new ConfigurationError('credentials', `no user name for ${application}: set ${names.user} (and ${names.password}) in ${where}.${useSpecific ? ` ${specific.user} / ${specific.password} must be set together; unset both to use ${general.user} / ${general.password}.` : ''}`);
  if (password === undefined || password === '')
    throw new ConfigurationError('credentials', `no password for ${application}: set ${names.password} in ${where} (never in a committed file).${useSpecific ? ` ${specific.user} / ${specific.password} must be set together.` : ''}`);
  return new Credentials({ application, user, password, source: `${names.user} / ${names.password}` });
}

/** Are credentials configured for this application (for a health check)? Never throws, never reads the password into a message. */
export function hasCredentials(application: string, env: ConfigReader = loadEnv()): boolean {
  try {
    credentialsFor(application, env);
    return true;
  } catch {
    return false;
  }
}
