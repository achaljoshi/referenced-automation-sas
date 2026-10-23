import { loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { DEFAULT_MAX_QUEUE, normalizeKeys, RECORD_MODES, type RecordMode } from '../desktop/recording';

/**
 * Every setting the recorder reads. This is the ONLY place in src/recorder that reads the environment (through the shared ConfigReader, like
 * every other package of the family); `.env.example` (section "RECORDER") documents each key and tests/recorder/envDocs.spec.ts keeps the two in step.
 */
export interface RecorderConfig {
  /** SAS_RECORDER_DIR: where recordings are written when `--out` names no folder. */
  dir: string;
  /** SAS_RECORDER_STOP_KEY: the chord that ends a recording (noticed in any window, recorded in none). */
  stopKey: string;
  /** SAS_RECORDER_POLL_MS: how often the recorder collects events from the bridge. */
  pollMs: number;
  /** SAS_RECORDER_MAX_QUEUE: how many events the bridge keeps between two collections (more are dropped and counted). */
  maxQueue: number;
  /** SAS_RECORDER_MODE: `full` (mouse and keyboard hooks plus UI Automation events) or `uia` (UI Automation events only). */
  mode: RecordMode;
  /** SAS_RECORDER_SECRET_PATTERNS: extra regular expressions; a field whose name or automation id matches is treated as a secret. */
  secretPatterns: string[];
}

export const DEFAULT_RECORDER_DIR = 'recordings';
export const DEFAULT_STOP_KEY = 'Ctrl+Alt+Q';
export const DEFAULT_POLL_MS = 200;

export function recorderConfig(env: ConfigReader = loadEnv()): RecorderConfig {
  const stopKey = env.get('SAS_RECORDER_STOP_KEY', DEFAULT_STOP_KEY).trim();
  const normalized = normalizeKeys(stopKey);
  if (normalized === undefined || !/^(?:(?:Ctrl|Alt|Shift)\+)*(?:[A-Z0-9]|F\d{1,2}|Escape|Enter)$/.test(normalized))
    throw new Error(`SAS_RECORDER_STOP_KEY must be a key chord such as Ctrl+Alt+Q (found "${stopKey}")`);
  const pollMs = env.getInt('SAS_RECORDER_POLL_MS', DEFAULT_POLL_MS);
  if (!(pollMs >= 20 && pollMs <= 5000)) throw new Error(`SAS_RECORDER_POLL_MS must be between 20 and 5000 milliseconds (found ${pollMs})`);
  const maxQueue = env.getInt('SAS_RECORDER_MAX_QUEUE', DEFAULT_MAX_QUEUE);
  if (!(maxQueue >= 100 && maxQueue <= 200_000)) throw new Error(`SAS_RECORDER_MAX_QUEUE must be between 100 and 200000 (found ${maxQueue})`);
  const mode = env.get('SAS_RECORDER_MODE', 'full').trim().toLowerCase();
  if (!(RECORD_MODES as readonly string[]).includes(mode)) throw new Error(`SAS_RECORDER_MODE must be one of ${RECORD_MODES.map((m) => `"${m}"`).join(', ')} (found "${mode}")`);
  const secretPatterns = env.getList('SAS_RECORDER_SECRET_PATTERNS', []);
  for (const pattern of secretPatterns) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new Error(`SAS_RECORDER_SECRET_PATTERNS entry "${pattern}" is not a valid regular expression`);
    }
  }
  return { dir: env.get('SAS_RECORDER_DIR', DEFAULT_RECORDER_DIR), stopKey: normalized, pollMs, maxQueue, mode: mode as RecordMode, secretPatterns };
}
