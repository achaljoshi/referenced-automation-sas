import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APPROVED_SCRIPT_NAME, assertBridgeVerified, bridgeHash, bridgeScriptPath, readBridgeScriptBytes } from './bridgeFile';
import { BRIDGE_SHA256 } from './bridgeHash.generated';
import { BridgeTamperedError } from './errors';
import { ProcessTransport } from './processTransport';
import { DesktopTransportError } from './types';

export interface PowerShellTransportOptions {
  /**
   * PowerShell executable. Default 'powershell.exe' (Windows PowerShell 5.1, present on every Windows). An older, 32-bit Enterprise Guide
   * registers its COM classes for 32-bit clients only: use C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe (SAS_DESKTOP_POWERSHELL).
   */
  powershellPath?: string;
  /**
   * A folder holding an approved - typically code-signed - copy of the bridge script as `sas-desktop-bridge.ps1`
   * (`copy bridge\sas-desktop-bridge.ps1 <dir>`, then sign it). With it set, that file is run instead of a temporary one and
   * `-ExecutionPolicy Bypass` is NOT passed, so the machine's own policy (AllSigned, ...) decides. The copy must be the exact script
   * this version of the framework ships (a signature block is ignored): a stale or edited copy is refused. SAS_DESKTOP_SCRIPT_DIR.
   */
  scriptDir?: string;
  /** The COM class allow-list handed to the bridge (SAS_COM_PROGIDS). Default: the bridge's own default. */
  allowProgIds?: string[];
  /** Per-request limit. A "the bridge is hung" backstop, not a screen-wait. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long to wait for PowerShell to start and say ready. Default 30 s. */
  startupTimeoutMs?: number;
  /** Test seam: the platform to behave as. Default process.platform. */
  platform?: NodeJS.Platform;
  /** Test seam: the expected hash of the script. Default: the one computed at build time. */
  expectedHash?: string;
  /** Test seam: where the temporary copy goes. Default os.tmpdir(). */
  tmpDir?: string;
}

/**
 * The PowerShell arguments to run the bridge, and what to clean up afterwards.
 *
 * The script is ALWAYS verified against the SHA-256 computed at build time first: a modified or outdated copy is refused
 * (BridgeTamperedError). By default the verified bytes are written to a private temporary file and that copy is run with
 * `-ExecutionPolicy Bypass` - what was verified is exactly what runs, and a swap of the packaged file between the check and the
 * start cannot matter. The process-level bypass lets a script that is not signed run on a machine whose policy would otherwise
 * refuse it, and it applies to this one PowerShell process only - but on a managed desktop it also sidesteps a control the
 * organisation set on purpose. Where that is not acceptable, point `scriptDir` (SAS_DESKTOP_SCRIPT_DIR) at an approved, signed copy
 * and the policy is left alone.
 */
export function bridgeInvocation(
  options: Pick<PowerShellTransportOptions, 'scriptDir' | 'allowProgIds' | 'expectedHash' | 'tmpDir'>,
): { args: string[]; cleanup: () => void; scriptFile: string } {
  const expected = options.expectedHash ?? BRIDGE_SHA256;
  const base = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  const tail = options.allowProgIds && options.allowProgIds.length > 0 ? ['-AllowProgIds', options.allowProgIds.join(',')] : [];
  if (options.scriptDir) {
    const approved = path.join(options.scriptDir, APPROVED_SCRIPT_NAME);
    if (!fs.existsSync(approved))
      throw new DesktopTransportError(
        `SAS_DESKTOP_SCRIPT_DIR is set but ${approved} does not exist. Copy the shipped bridge there: copy "${bridgeScriptPath()}" "${approved}"  (and sign it if your policy requires).`,
        'ERROR',
      );
    assertBridgeVerified(approved, expected);
    return { args: [...base, '-File', approved, ...tail], cleanup: () => undefined, scriptFile: approved };
  }
  const shipped = bridgeScriptPath();
  const bytes = readBridgeScriptBytes(shipped);
  const actual = bridgeHash(bytes.toString('utf8'));
  if (actual !== expected) throw new BridgeTamperedError(shipped, expected, actual);
  const tmp = options.tmpDir ?? os.tmpdir();
  const scriptPath = path.join(tmp, `sas-desktop-bridge-${process.pid}-${crypto.randomBytes(6).toString('hex')}.ps1`);
  // 'wx': never follow or replace something that is already there; 0600: only this user can read or change the copy
  fs.writeFileSync(scriptPath, bytes, { flag: 'wx', mode: 0o600 });
  return {
    args: [...base, '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...tail],
    cleanup: () => fs.rmSync(scriptPath, { force: true }),
    scriptFile: scriptPath,
  };
}

/**
 * The default way to reach the desktop: one long-lived PowerShell process (bridge/sas-desktop-bridge.ps1) that holds the UI Automation
 * and COM state, spoken to by ProcessTransport. Windows only, by nature.
 */
export const PowerShellTransport = {
  async start(options: PowerShellTransportOptions = {}): Promise<ProcessTransport> {
    if ((options.platform ?? process.platform) !== 'win32') {
      throw new DesktopTransportError(
        'Windows UI Automation and the SAS COM objects are Windows-only: run these tests on a Windows machine with an unlocked desktop (or set SAS_DESKTOP_TRANSPORT=remote to use a remote desktop host; SAS_DESKTOP_SIMULATOR=true runs the built-in stand-in on any OS).',
        'ERROR',
      );
    }
    const { args, cleanup } = bridgeInvocation(options);
    return ProcessTransport.start({
      command: options.powershellPath ?? 'powershell.exe',
      args,
      label: 'PowerShell',
      cleanup,
      requestTimeoutMs: options.requestTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });
  },
};
