import { coreHealthChecks, runPreflight, type HealthCheck, type LogonGuard, type PreflightReport } from '../core';
import type { DesktopSession, EnvironmentInfo } from '../desktop';
import type { CredentialSource } from './credentials';
import type { FixtureSettings } from './settings';

/**
 * The pre-flight health gate the fixtures run once per worker (SAS_PREFLIGHT=false skips it): the core checks (the environment is
 * declared, the state folder and the audit log are writable), a check per application whose login is configured (so an active logon
 * cooldown stops the run BEFORE the first test, not at it), and the desktop session's own: the bridge answers, and the desktop is
 * interactive, unlocked and visible to UI Automation. A red gate fails once, listing every red check with what to do - instead of
 * hundreds of timeouts.
 */

export const PREFLIGHT_APPLICATIONS = ['smc', 'eg'] as const;

/** The checks about the desktop session. */
export function desktopHealthChecks(session: DesktopSession, simulated: boolean): HealthCheck[] {
  return [
    {
      name: 'desktop-bridge',
      hint: 'the PowerShell bridge did not start or answer: run `npm run doctor` (Windows PowerShell 5.1 on the PATH; on a managed desktop see SAS_DESKTOP_SCRIPT_DIR for an approved script; SAS_DESKTOP_TRANSPORT=remote for a remote host).',
      run: async () => {
        const ping = await session.ping();
        return { ok: true, detail: `${ping.bridge} protocol ${ping.version}${simulated ? ' (the stand-in desktop)' : ''}` };
      },
    },
    {
      name: 'desktop-session',
      hint: 'UI steps need a logged-in, unlocked, connected interactive desktop of the same user as the programs: unlock the workstation or reconnect the RDP session, then run `npm run doctor`.',
      run: async () => {
        const info = (await session.send({ op: 'environment' })) as EnvironmentInfo;
        const problems = [
          info.userInteractive ? '' : 'not an interactive session',
          info.desktopAccessible ? '' : 'the desktop is locked or disconnected',
          info.uiaAvailable ? '' : 'UI Automation is not available',
        ].filter(Boolean);
        return problems.length === 0
          ? { ok: true, detail: `${info.os}, session "${info.sessionName || '(none)'}", ${info.topLevelWindows} window(s) visible` }
          : { ok: false, detail: problems.join('; ') };
      },
    },
  ];
}

/** One check per application: the login is configured and not in a logon cooldown. Skipped (never red) when nothing is configured: only the `*LoggedOn` fixtures need a login. */
export function credentialChecks(applications: readonly string[], credentials: CredentialSource, guard: LogonGuard, environment: string): HealthCheck[] {
  return applications.map((application) => ({
    name: `credentials:${application}`,
    hint: `fix SAS_${application.toUpperCase()}_USER / SAS_${application.toUpperCase()}_PASSWORD (or SAS_USER / SAS_PASSWORD) in .env.<ENV>.local - a pair from one source; if a logon cooldown is active, follow the steps in its message.`,
    skip: () => (credentials.available(application) ? undefined : 'no login configured (only the *LoggedOn fixtures need one)'),
    run: () => {
      const login = credentials.for(application);
      guard.assertAllowed(environment, login);
      return { ok: true, detail: `${login.user} (from ${login.source}); no logon cooldown` };
    },
  }));
}

export interface PreflightInput {
  settings: FixtureSettings;
  session: DesktopSession;
  credentials: CredentialSource;
  guard: LogonGuard;
}

/** Every check, in order: the core's first, then the logins, then the desktop's. */
export function preflightChecks(input: PreflightInput): HealthCheck[] {
  const { settings } = input;
  return [
    ...coreHealthChecks({ env: settings.env }),
    ...credentialChecks(PREFLIGHT_APPLICATIONS, input.credentials, input.guard, settings.environmentName),
    ...desktopHealthChecks(input.session, settings.simulated),
  ];
}

/** Runs the gate. Throws ONE PreflightFailed naming every red check. Skipped (returns undefined) with SAS_PREFLIGHT=false. */
export async function runDesktopPreflight(input: PreflightInput): Promise<PreflightReport | undefined> {
  if (!input.settings.preflight) return undefined;
  return runPreflight(preflightChecks(input), { env: input.settings.env });
}
