import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeTamperedError } from './errors';
import { BRIDGE_SHA256 } from './bridgeHash.generated';

/** The file name the shipped bridge has, and the name an approved (signed) copy must have inside SAS_DESKTOP_SCRIPT_DIR. */
export const APPROVED_SCRIPT_NAME = 'sas-desktop-bridge.ps1';

/**
 * Where the shipped PowerShell bridge lives: `bridge/sas-desktop-bridge.ps1` at the package root. This file sits two levels below the
 * package root both as source (src/desktop) and compiled (dist/desktop), so one relative path serves both; the CLI (one level
 * deeper) resolves through the same function.
 */
export function bridgeScriptPath(): string {
  return path.resolve(__dirname, '..', '..', 'bridge', APPROVED_SCRIPT_NAME);
}

/** The bytes of the shipped bridge script (UTF-8 with a byte-order mark - see the script header). */
export function readBridgeScriptBytes(file: string = bridgeScriptPath()): Buffer {
  return fs.readFileSync(file);
}

/** The text of the bridge script at `file` (default: the shipped one). */
export function readBridgeScript(file: string = bridgeScriptPath()): string {
  return readBridgeScriptBytes(file).toString('utf8');
}

/**
 * What the file holds apart from an Authenticode signature block, with the BOM and line endings normalised and the end trimmed.
 * Only a block made of comment lines counts as a signature: code appended after a fake "# SIG # Begin signature block" line is NOT cut off,
 * so it changes the hash.
 * bridge/generate-hash.js implements the same function (tests/desktop/bridgeHash.spec.ts keeps them identical).
 */
export function normalizeBridgeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n# SIG # Begin signature block(?:\r?\n#[^\n]*)*\s*$/, '')
    .trim();
}

/** SHA-256 (hex) of the normalised script text. */
export function bridgeHash(text: string): string {
  return crypto.createHash('sha256').update(normalizeBridgeText(text), 'utf8').digest('hex');
}

export interface BridgeVerification {
  ok: boolean;
  file: string;
  expected: string;
  actual: string;
}

/**
 * Checks a bridge script against the hash computed at build time (src/desktop/bridgeHash.generated.ts, written by
 * `node bridge/generate-hash.js`). With no arguments it checks the shipped script. Never throws for a mismatch: see assertBridgeVerified.
 */
export function verifyBridge(file: string = bridgeScriptPath(), expected: string = BRIDGE_SHA256): BridgeVerification {
  const actual = bridgeHash(readBridgeScript(file));
  return { ok: actual === expected, file, expected, actual };
}

/** Like verifyBridge, but throws BridgeTamperedError for a script that is not the one this version was built with. */
export function assertBridgeVerified(file: string = bridgeScriptPath(), expected: string = BRIDGE_SHA256): BridgeVerification {
  const result = verifyBridge(file, expected);
  if (!result.ok) throw new BridgeTamperedError(result.file, result.expected, result.actual);
  return result;
}

export { BRIDGE_SHA256 };
