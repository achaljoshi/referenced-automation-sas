import { loadEnv, remote, type ConfigReader } from '@automation/referenced-automation-utils';
import { desktopConfig, type DesktopConfig } from './config';
import { startFakeDesktop, type FakeSasDesktop } from './fakeApps';
import { PowerShellTransport } from './powershellTransport';
import { RemoteTransport } from './remoteTransport';
import { DesktopSession, type DesktopSessionOptions } from './session';
import { DesktopTransportError, type DesktopTransport } from './types';

export interface StartedTransport {
  transport: DesktopTransport;
  /** For messages: "PowerShell", "PowerShell on the remote desktop host", "the built-in simulator". */
  name: string;
  /** Ends this process's use of the remote desktop host (remote only): call it after `transport.close()`. */
  release?: () => Promise<void>;
  /** The stand-in itself, when the simulator is in use (to inspect or configure it in a test). */
  simulator?: FakeSasDesktop;
}

/**
 * Ends this process's use of the remote desktop host (the one `getRemoteHost()` shares per worker) - and forgets it, so the next use
 * connects afresh instead of finding a half-closed host. Safe to call when it was never opened.
 */
export function releaseRemoteHost(): Promise<void> {
  return remote.closeRemoteHost();
}

/**
 * Starts the bridge to the real desktop that SAS_DESKTOP_TRANSPORT selects:
 *   powershell (default)  the PowerShell bridge on this Windows machine
 *   remote                the PowerShell bridge run on a remote desktop host through the RDP agent (REMOTE_* keys; REMOTE_ALLOW must include "sap")
 * With SAS_DESKTOP_SIMULATOR=true the built-in stand-in desktop is used instead, on any OS.
 */
export async function startDesktopTransport(config: DesktopConfig = desktopConfig(), env: ConfigReader = loadEnv()): Promise<StartedTransport> {
  if (config.simulator) {
    const simulator = startFakeDesktop({ allowProgIds: config.comProgIds });
    return { transport: simulator.desktop, name: 'the built-in simulator', simulator };
  }
  if (config.transport === 'remote') {
    try {
      const host = await remote.getRemoteHost(env);
      if (!host)
        throw new DesktopTransportError(
          'SAS_DESKTOP_TRANSPORT=remote needs the remote desktop host: set REMOTE_ENABLED=true and the REMOTE_* keys (REMOTE_RDP_HOST, REMOTE_RDP_USER, REMOTE_RDP_PASSWORD in .env.<env>.local ... - see referenced-automation-utils docs/REMOTE_DESKTOP.md), with REMOTE_ALLOW including "sap"',
          'ERROR',
        );
      const transport = await RemoteTransport.start({
        host,
        bridgeFile: config.remoteBridgeFile,
        allowProgIds: config.comProgIds,
        requestTimeoutMs: config.requestTimeoutMs,
      });
      return { transport, name: 'PowerShell on the remote desktop host', release: releaseRemoteHost };
    } catch (error) {
      await releaseRemoteHost().catch(() => undefined); // a failed start must not leave a connected (or remembered-as-failed) host behind
      throw error;
    }
  }
  return {
    transport: await PowerShellTransport.start({
      powershellPath: config.powershell,
      scriptDir: config.scriptDir,
      allowProgIds: config.comProgIds,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    name: 'PowerShell',
  };
}

export interface OpenedDesktopSession {
  session: DesktopSession;
  name: string;
  /** Closes the bridge (and releases the remote host). Applications that were launched are closed with `app.dispose()`. */
  close(): Promise<void>;
  simulator?: FakeSasDesktop;
}

/** Starts the configured transport and wraps it in a session with the configured timeout and evidence settings. */
export async function openDesktopSession(options: { config?: DesktopConfig; session?: DesktopSessionOptions } = {}): Promise<OpenedDesktopSession> {
  const config = options.config ?? desktopConfig();
  const started = await startDesktopTransport(config);
  const session = new DesktopSession(started.transport, {
    timeoutMs: config.timeoutMs,
    evidence: config.evidence,
    evidenceDir: config.evidenceDir,
    ...options.session,
  });
  return {
    session,
    name: started.name,
    simulator: started.simulator,
    close: async () => {
      await session.close();
      await started.release?.();
    },
  };
}
