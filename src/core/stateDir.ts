import * as path from 'node:path';
import { loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';

/** Default folder for state that must survive between runs: the logon-failure marker and the created-objects list. */
export const DEFAULT_STATE_DIR = '.sas-state';

/**
 * SAS_STATE_DIR: where state that must outlive a run is kept (default `.sas-state`, git-ignored). Deliberately NOT under test-results:
 * Playwright empties that folder at the start of every run, which would remove the logon-failure marker exactly when the next run
 * needs it.
 */
export function stateDir(env: ConfigReader = loadEnv()): string {
  return path.resolve(env.get('SAS_STATE_DIR', DEFAULT_STATE_DIR));
}
