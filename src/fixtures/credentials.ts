import type { ConfigReader } from '@automation/referenced-automation-utils';
import { Credentials, credentialVariables, credentialsFor } from '../core';
import type { FakeSasDesktop } from '../desktop';

/**
 * Where a worker's logins come from: the configuration (`SAS_<APP>_USER` / `SAS_<APP>_PASSWORD`, else `SAS_USER` / `SAS_PASSWORD` - a
 * pair from ONE source, a half-set pair is an error) - or, with the stand-in desktop, the stand-in's own demo account. The stand-in's
 * login is not a real credential: it exists only inside that fake, and a real password is never typed into a fake: what is configured
 * for the real programs is ignored by the stand-in unless a test supplied it on purpose (`explicit`: the keys of the `sasSettings` option).
 */
export class CredentialSource {
  constructor(
    private readonly env: ConfigReader,
    private readonly simulator?: FakeSasDesktop,
    /** The settings a test supplied on purpose; only these override the stand-in's demo login. */
    private readonly explicit: ReadonlySet<string> = new Set(),
  ) {}

  private suppliedOnPurpose(application: string): boolean {
    const own = credentialVariables(application);
    return [own.user, own.password, 'SAS_USER', 'SAS_PASSWORD'].some((key) => this.explicit.has(key));
  }

  /** Has anything been configured for this application (its own pair, or the general pair)? */
  anyConfigured(application: string): boolean {
    const own = credentialVariables(application);
    return [own.user, own.password, 'SAS_USER', 'SAS_PASSWORD'].some((key) => this.env.getOptional(key) !== undefined);
  }

  /** Can `for` give a login (configured, or the stand-in's)? A half-set pair counts as configured: `for` then explains what is wrong. */
  available(application: string): boolean {
    return this.anyConfigured(application) || this.simulator !== undefined;
  }

  /** The login for an application. Throws ConfigurationError (naming the settings, never a value) when none is configured. */
  for(application: string): Credentials {
    if (this.simulator && !this.suppliedOnPurpose(application)) {
      const account = (application === 'eg' ? this.simulator.eg : this.simulator.smc).options.accounts[0];
      if (account) return new Credentials({ application, user: account.user, password: account.password, source: "the stand-in desktop's demo account" });
    }
    return credentialsFor(application, this.env);
  }
}
