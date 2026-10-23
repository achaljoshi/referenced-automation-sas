import { startFakeDesktop } from '../desktop';

/**
 * What the stand-in desktop brings itself: its demo login and the names of its connection profiles. Taken from a fresh in-memory stand-in
 * (it starts no process), so there is exactly one place - the stand-in's own defaults - that says what they are.
 */
export interface StandInIdentity {
  user: string;
  password: string;
  smcProfile: string;
  egProfile: string;
}

let identity: StandInIdentity | undefined;

export function standInIdentity(): StandInIdentity {
  if (!identity) {
    const probe = startFakeDesktop();
    const account = probe.smc.options.accounts[0];
    const smcProfile = probe.smc.options.profiles[0];
    const egProfile = probe.eg.options.profiles[0];
    if (!account || !smcProfile || !egProfile) throw new Error('the stand-in desktop has no demo account or no profile: the fixtures cannot publish its identity');
    identity = { user: account.user, password: account.password, smcProfile, egProfile };
  }
  return identity;
}

/**
 * Tests - above all converted recordings - read the login and the profile names from the environment (`SAS_USER`, `SAS_PASSWORD`,
 * `SAS_SMC_PROFILE`, `SAS_EG_PROFILE`). While a test runs on the stand-in these are the STAND-IN's own values, whatever is configured for the
 * real programs (a real password is never typed into a fake), so such a test works unchanged. A setting the test supplied on purpose
 * (`explicit`: the keys of the `sasSettings` option) is left alone. Returns the function that puts the environment back exactly as it was,
 * so nothing leaks into another test of the same worker.
 */
export function publishStandInEnvironment(target: NodeJS.ProcessEnv, explicit: ReadonlySet<string> = new Set()): () => void {
  const who = standInIdentity();
  const values: Record<string, string> = { SAS_USER: who.user, SAS_PASSWORD: who.password, SAS_SMC_PROFILE: who.smcProfile, SAS_EG_PROFILE: who.egProfile };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    if (explicit.has(key)) continue;
    saved.set(key, target[key]);
    target[key] = value;
  }
  return () => {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete target[key];
      else target[key] = previous;
    }
  };
}
