import { assertBridgeVerified, type BridgeVerification } from '../desktop';
import type { FixtureSettings } from './settings';

/**
 * The PowerShell bridge is verified against the SHA-256 pinned at build time BEFORE a worker opens a transport, so a modified or stale
 * script stops the run with `BridgeTamperedError` (what to do is in its message) instead of being started. The transports check the
 * bytes they are about to run as well; this is the early, worker-level check, with the pre-flight gate's one clear failure.
 *
 * Not checked where the shipped script is not what runs: the stand-in desktop (it is a Node program), and a remote host that runs an
 * approved copy that already lives on it (`SAS_DESKTOP_REMOTE_BRIDGE_FILE`: control that file on the host).
 */
export function verifyBridgeForRun(settings: Pick<FixtureSettings, 'simulated' | 'desktop'>, verify: () => BridgeVerification = assertBridgeVerified): { checked: boolean; reason: string } {
  if (settings.simulated) return { checked: false, reason: 'the stand-in desktop does not run the script' };
  if (settings.desktop.transport === 'remote' && settings.desktop.remoteBridgeFile) return { checked: false, reason: 'an approved copy on the remote host runs instead (SAS_DESKTOP_REMOTE_BRIDGE_FILE)' };
  verify();
  return { checked: true, reason: 'the shipped script matches the pinned SHA-256' };
}
