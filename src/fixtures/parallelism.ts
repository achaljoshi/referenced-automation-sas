import type { ConfigReader } from '@automation/referenced-automation-utils';
import { reachesRealDesktop } from '../desktop/platform';

/**
 * One desktop = one worker. The SAS programs are driven through ONE interactive Windows desktop (or one remote desktop host whose
 * agent answers one request at a time): two workers would type into the same windows. The stand-in desktop has no such limit - every
 * worker starts its own.
 *
 * `playwright.config.ts` uses `desktopWorkerPlan` to set `workers: 1` where a real desktop can be reached, and the fixtures call
 * `assertSingleWorker` so `--workers=4` on the command line fails loudly instead of corrupting a run.
 */

export interface WorkerPlan {
  /** A real desktop can be reached from this run: use exactly one worker and no fully-parallel files. */
  oneWorker: boolean;
  /** Set when WORKERS asked for more than one and was ignored: the message to print. */
  ignored?: string;
}

/**
 * Can a REAL desktop be reached - and therefore driven by more than one worker's tests? True unless SAS_DESKTOP_SIMULATOR is on, and
 * only when this is Windows or SAS_DESKTOP_TRANSPORT=remote (anywhere else the tests that need a desktop are skipped).
 */
export function realDesktopReachable(env: ConfigReader, platform: NodeJS.Platform = process.platform): boolean {
  if (env.getBoolean('SAS_DESKTOP_SIMULATOR', false)) return false;
  return reachesRealDesktop({ platform, transport: env.get('SAS_DESKTOP_TRANSPORT', 'powershell') });
}

export function desktopWorkerPlan(env: ConfigReader, platform: NodeJS.Platform = process.platform): WorkerPlan {
  if (!realDesktopReachable(env, platform)) return { oneWorker: false };
  const requested = env.getOptional('WORKERS');
  const ignored =
    requested && requested !== '1'
      ? `[sas] WORKERS=${requested} ignored: a real desktop is in reach and every worker would drive the same SAS windows. Using 1 worker. (SAS_DESKTOP_SIMULATOR=true allows parallel workers.)`
      : undefined;
  return { oneWorker: true, ...(ignored ? { ignored } : {}) };
}

/** Throws when a real desktop is in use (not the stand-in) and Playwright runs more than one worker. */
export function assertSingleWorker(options: { simulated: boolean; workers: number; transport?: string }): void {
  if (options.simulated || options.workers <= 1) return;
  const remote = options.transport === 'remote';
  throw new Error(
    `${options.workers} workers with a real SAS desktop${remote ? ' (SAS_DESKTOP_TRANSPORT=remote: one remote desktop, one agent answering one request at a time)' : ''}: every worker would drive the same SAS windows. ` +
      "Run with --workers=1 (this repo's playwright.config.ts does that by default - was WORKERS or --workers set?), or SAS_DESKTOP_SIMULATOR=true for the stand-in desktop, where every worker has its own.",
  );
}
