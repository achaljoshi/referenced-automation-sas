import { ConfigReader, loadEnv } from '@automation/referenced-automation-utils';
import { ConfigurationError, RunContext, getRunContext, selectedEnvironmentName } from '../core';
import { desktopConfig, reachesDesktop, type DesktopConfig } from '../desktop';

/**
 * Everything the fixtures decide from the configuration, resolved ONCE per worker so a mistake (a misspelt value, a half-set login)
 * stops the worker with one message that names the setting, instead of surfacing in the middle of a test.
 *
 * The settings come from the shared config (`.env` -> `.env.<ENV>` -> `.env.<ENV>.local` -> real environment variables). Tests can
 * overlay values with `desktopTest.use({ sasSettings: { SAS_EVIDENCE: 'on' } })` without touching the process environment.
 */

export type CleanupFailureMode = 'fail' | 'warn';
export type AppMode = 'auto' | 'launch' | 'attach';
/** What SAS_EVIDENCE says. `steps` is "failure, plus a screenshot after every step that may change something". */
export type EvidenceSetting = 'off' | 'failure' | 'on' | 'steps';

export interface FixtureSettings {
  /** The configuration the fixtures read, after the overlays below. */
  env: ConfigReader;
  /** The desktop layer's settings (`simulator` already decided). */
  desktop: DesktopConfig;
  /** True when the built-in stand-in desktop is used (any OS), either by SAS_DESKTOP_SIMULATOR or by the `desktopSimulator` option. */
  simulated: boolean;
  /** The selected SAS environment (SAS_ENVIRONMENT; with the simulator and no SAS_ENVIRONMENT: `simulator`). */
  environmentName: string;
  /** SAS_PREFLIGHT: run the pre-flight health gate once per worker (default true). */
  preflight: boolean;
  /** SAS_CLEANUP_FAILURE: what a failed clean-up does to its test. */
  cleanupFailure: CleanupFailureMode;
  /** SAS_APP_MODE, with the simulator forcing `launch`. */
  appMode: AppMode;
  /** The master evidence switch (core's `off` / `failure` / `on`; `steps` counts as `failure`). */
  evidence: 'off' | 'failure' | 'on';
  /** A screenshot after every step that may change something (SAS_EVIDENCE=steps or SAS_DESKTOP_EVIDENCE=steps), unless evidence is off. */
  evidenceSteps: boolean;
  /** The run: its id (shared by every worker through initRunContext) and everything derived from it, read from `env`. */
  run: RunContext;
  /** The names of the settings that came from the `sasSettings` option: the only ones that can change what the stand-in desktop uses (see STAND_IN_OWN). */
  explicit: ReadonlySet<string>;
}

/**
 * What the stand-in desktop brings itself. Its programs are at their own paths, its connection profiles have their own names, its Enterprise
 * Guide is a registered class of its own, its login is its own demo login and it runs as the declared `simulator` environment. Nothing
 * you configured for the REAL programs is used with it - not even a real password is ever typed into a fake - unless a test says so on
 * purpose through the `sasSettings` option. That keeps `npm test` the same on every machine, whatever `.env.qa` and `.env.qa.local` hold.
 */
export const STAND_IN_OWN = ['SAS_ENVIRONMENT', 'SAS_SMC_PATH', 'SAS_SMC_PROFILE', 'SAS_EG_PATH', 'SAS_EG_PROFILE', 'SAS_EG_PROGID'] as const;

/** A reader that answers like `base` but with `values` on top (they win over files and the real environment). */
export function overlay(base: ConfigReader, values: Record<string, string>): ConfigReader {
  const declared = base.toObject();
  return new ConfigReader({ ...declared, ...values }, [...Object.keys(declared), ...Object.keys(values)]);
}

function oneOf<T extends string>(env: ConfigReader, key: string, allowed: readonly T[], fallback: T): T {
  const value = env.get(key, fallback).trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(value)) throw new ConfigurationError('settings', `${key} must be one of ${allowed.map((a) => `"${a}"`).join(', ')} (found "${value}")`);
  return value as T;
}

export interface SettingsOptions {
  /** The configuration to start from (default: `loadEnv()`). */
  env?: ConfigReader;
  /** Overrides SAS_DESKTOP_SIMULATOR (the `desktopSimulator` option). */
  simulator?: boolean | undefined;
  /** Values laid over the configuration (the `sasSettings` option). */
  overrides?: Record<string, string> | undefined;
  /** The run id to use (default: the process-wide run context's, which every worker of one run shares). */
  runId?: string;
}

/** Reads and checks every setting the fixtures use. Throws ConfigurationError (or the desktop layer's own message) naming the setting. */
export function resolveSettings(options: SettingsOptions = {}): FixtureSettings {
  let env = options.env ?? loadEnv();
  if (options.overrides && Object.keys(options.overrides).length > 0) env = overlay(env, options.overrides);

  const explicit = new Set(Object.keys(options.overrides ?? {}));
  const simulated = options.simulator ?? desktopConfig(env).simulator;
  if (simulated) {
    // the stand-in brings its own programs, profiles and environment (see STAND_IN_OWN): blank what was configured for the real ones
    const own: Record<string, string> = { SAS_ENVIRONMENT: 'simulator' };
    for (const key of STAND_IN_OWN) if (!explicit.has(key)) own[key] = key === 'SAS_ENVIRONMENT' ? 'simulator' : '';
    for (const key of explicit) delete own[key];
    env = overlay(env, own);
  }
  const configured = desktopConfig(env);

  const rawEvidence = env.get('SAS_EVIDENCE', 'failure').trim().toLowerCase();
  if (!['off', 'failure', 'on', 'steps'].includes(rawEvidence))
    throw new ConfigurationError('evidence', `SAS_EVIDENCE "${rawEvidence}" must be off, failure, on or steps`);
  const evidence = (rawEvidence === 'steps' ? 'failure' : rawEvidence) as FixtureSettings['evidence'];
  // the core run context only knows off | failure | on
  const runEnv = overlay(env, { SAS_EVIDENCE: evidence });

  const appMode = simulated ? 'launch' : oneOf<AppMode>(env, 'SAS_APP_MODE', ['auto', 'launch', 'attach'], 'auto');
  if (simulated) oneOf<AppMode>(env, 'SAS_APP_MODE', ['auto', 'launch', 'attach'], 'auto'); // still reject a misspelt value

  return {
    env,
    desktop: { ...configured, simulator: simulated },
    simulated,
    environmentName: selectedEnvironmentName(env),
    preflight: env.getBoolean('SAS_PREFLIGHT', true),
    cleanupFailure: oneOf<CleanupFailureMode>(env, 'SAS_CLEANUP_FAILURE', ['fail', 'warn'], 'fail'),
    appMode,
    evidence,
    evidenceSteps: evidence !== 'off' && (rawEvidence === 'steps' || configured.evidence === 'steps'),
    run: new RunContext({ runId: options.runId ?? getRunContext().runId, env: runEnv }),
    explicit,
  };
}

/** Can this machine run desktop tests at all? Windows, the stand-in, or a remote desktop host. Anywhere else a test is skipped with the reason. */
export function canRunDesktop(settings: Pick<FixtureSettings, 'simulated' | 'desktop'>, platform: NodeJS.Platform = process.platform): { ok: true } | { ok: false; reason: string } {
  if (reachesDesktop({ platform, transport: settings.desktop.transport, simulated: settings.simulated })) return { ok: true };
  return {
    ok: false,
    reason:
      'The SAS desktop programs run on Windows: this test was skipped, not run. Run it on a Windows machine, with SAS_DESKTOP_TRANSPORT=remote, or set SAS_DESKTOP_SIMULATOR=true to run it against the built-in stand-in desktop.',
  };
}
