import { loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';

/**
 * Every setting the desktop layer reads. This is the ONLY place in src/desktop that reads the environment (through the shared
 * ConfigReader, like every other package of the family); .env.example documents each key and tests/envDocs.spec.ts
 * keeps the two in step: a key read here and missing there (or the reverse) fails the test run.
 */
export type TransportKind = 'powershell' | 'remote';
export type EvidenceMode = 'off' | 'failure' | 'steps';

export interface DesktopConfig {
  /** SAS_DESKTOP_TRANSPORT. */
  transport: TransportKind;
  /** SAS_DESKTOP_SIMULATOR: use the built-in stand-in desktop instead of Windows (any OS). */
  simulator: boolean;
  /** SAS_DESKTOP_POWERSHELL: the PowerShell executable (default powershell.exe; the 32-bit one for an old Enterprise Guide). */
  powershell?: string;
  /** SAS_DESKTOP_SCRIPT_DIR: a folder holding an approved copy of the bridge script (run without -ExecutionPolicy Bypass). */
  scriptDir?: string;
  /** SAS_DESKTOP_REMOTE_BRIDGE_FILE: the approved bridge script that already lives on the remote host. */
  remoteBridgeFile?: string;
  /** SAS_DESKTOP_TIMEOUT_MS: how long any one step waits for its control. */
  timeoutMs: number;
  /** SAS_DESKTOP_REQUEST_TIMEOUT_MS: the "bridge is hung" backstop for one request. */
  requestTimeoutMs: number;
  /** SAS_DESKTOP_EVIDENCE. */
  evidence: EvidenceMode;
  /** SAS_DESKTOP_EVIDENCE_DIR. */
  evidenceDir: string;
  /** SAS_SMC_PATH. */
  smcPath?: string;
  /** SAS_SMC_PROFILE. */
  smcProfile?: string;
  /** SAS_EG_PATH. */
  egPath?: string;
  /** SAS_EG_PROFILE. */
  egProfile?: string;
  /** SAS_EG_PROGID. */
  egProgId?: string;
  /** SAS_COM_PROGIDS: the COM class allow-list handed to the bridge. */
  comProgIds: string[];
}

export const DEFAULT_COM_PROGIDS = ['SASEGObjectModel.Application.*', 'SASObjectManager.*'] as const;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_EVIDENCE_DIR = 'test-results/sas-desktop-evidence';

function oneOf<T extends string>(env: ConfigReader, key: string, allowed: readonly T[], fallback: T): T {
  const value = env.get(key, fallback).trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${key} must be one of ${allowed.map((a) => `"${a}"`).join(', ')} (found "${value}")`);
  return value as T;
}

function optional(env: ConfigReader, key: string): string | undefined {
  const value = env.getOptional(key);
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function positive(env: ConfigReader, key: string, fallback: number): number {
  const value = env.getInt(key, fallback);
  if (!(value > 0)) throw new Error(`${key} must be a positive number of milliseconds (found ${value})`);
  return value;
}

/** Reads the settings (default: the shared environment as `loadEnv()` resolves it). */
export function desktopConfig(env: ConfigReader = loadEnv()): DesktopConfig {
  const progIds = env.getList('SAS_COM_PROGIDS', [...DEFAULT_COM_PROGIDS]);
  for (const pattern of progIds) {
    if (!/^[A-Za-z0-9_.*]+$/.test(pattern))
      throw new Error(`SAS_COM_PROGIDS entry "${pattern}" is not valid: use ProgIDs with * as the only wildcard, separated by commas (for example SASEGObjectModel.Application.*,SASObjectManager.*)`);
  }
  return {
    transport: oneOf(env, 'SAS_DESKTOP_TRANSPORT', ['powershell', 'remote'], 'powershell'),
    simulator: env.getBoolean('SAS_DESKTOP_SIMULATOR', false),
    powershell: optional(env, 'SAS_DESKTOP_POWERSHELL'),
    scriptDir: optional(env, 'SAS_DESKTOP_SCRIPT_DIR'),
    remoteBridgeFile: optional(env, 'SAS_DESKTOP_REMOTE_BRIDGE_FILE'),
    timeoutMs: positive(env, 'SAS_DESKTOP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    requestTimeoutMs: positive(env, 'SAS_DESKTOP_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    evidence: oneOf(env, 'SAS_DESKTOP_EVIDENCE', ['off', 'failure', 'steps'], 'off'),
    evidenceDir: env.get('SAS_DESKTOP_EVIDENCE_DIR', DEFAULT_EVIDENCE_DIR),
    smcPath: optional(env, 'SAS_SMC_PATH'),
    smcProfile: optional(env, 'SAS_SMC_PROFILE'),
    egPath: optional(env, 'SAS_EG_PATH'),
    egProfile: optional(env, 'SAS_EG_PROFILE'),
    egProgId: optional(env, 'SAS_EG_PROGID'),
    comProgIds: progIds,
  };
}
