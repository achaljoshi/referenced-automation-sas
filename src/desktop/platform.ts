/**
 * What this package can do on which operating system. The core, the command-line driver, the policy gate and the converters run on
 * Windows, macOS and Linux. Only the two things that talk to a Windows desktop (UI Automation and COM objects through the PowerShell
 * bridge) need Windows; everywhere else they are reached through a remote desktop host or the built-in stand-in, or the tests that need
 * them are skipped with the reason.
 */
export interface PlatformFacts {
  /** `process.platform` by default. */
  platform?: NodeJS.Platform;
  /** SAS_DESKTOP_TRANSPORT: 'powershell' (default), 'remote', ... */
  transport?: string;
  /** SAS_DESKTOP_SIMULATOR=true: the built-in stand-in desktop. */
  simulated?: boolean;
}

export interface PlatformCapability {
  id: string;
  title: string;
  available: boolean;
  /** Why it is available or not, and what to do about it. */
  detail: string;
}

export interface PlatformReport {
  platform: NodeJS.Platform;
  name: string;
  capabilities: PlatformCapability[];
}

const NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function describePlatform(facts: PlatformFacts = {}): PlatformReport {
  const platform = facts.platform ?? process.platform;
  const windows = platform === 'win32';
  const transport = (facts.transport ?? 'powershell').trim().toLowerCase();
  const reachable = windows || facts.simulated === true || transport === 'remote';
  const tools = windows
    ? 'SAS command-line tools run as .exe files found in SAS_TOOL_DIRS (a .bat or .cmd file is refused: it needs a shell).'
    : 'SAS command-line tools run as executable programs or scripts found in SAS_TOOL_DIRS.';

  const capabilities: PlatformCapability[] = [
    { id: 'core', title: 'policy gate, logon guard, audit log, clean-up, run context', available: true, detail: 'Pure Node: the same on every system.' },
    { id: 'process', title: 'command-line tools (batch tools, sas)', available: true, detail: `${tools} Arguments are an array, never a shell string.` },
    { id: 'converters', title: 'recorder converter and Enterprise Guide script importer', available: true, detail: 'They read files and write TypeScript: no desktop needed.' },
    { id: 'simulator', title: 'built-in stand-in desktop (SAS_DESKTOP_SIMULATOR=true)', available: true, detail: 'Runs the whole suite without Windows or SAS.' },
    {
      id: 'desktop',
      title: 'real Management Console and Enterprise Guide (UI Automation, COM)',
      available: reachable,
      detail: windows
        ? transport === 'remote'
          ? 'Windows, through the remote desktop host (SAS_DESKTOP_TRANSPORT=remote).'
          : 'Windows: the PowerShell bridge runs here. It needs an unlocked interactive session.'
        : reachable
          ? facts.simulated === true
            ? 'Only the stand-in on this system. The real programs need Windows.'
            : 'Through the remote desktop host (SAS_DESKTOP_TRANSPORT=remote): the programs run on that Windows machine.'
          : `Not on ${NAMES[platform] ?? platform}: UI Automation and COM are Windows features. Use a Windows machine, SAS_DESKTOP_TRANSPORT=remote, or SAS_DESKTOP_SIMULATOR=true. Tests that need the desktop are skipped with this reason.`,
    },
  ];
  return { platform, name: NAMES[platform] ?? platform, capabilities };
}

export function formatPlatform(report: PlatformReport): string {
  const lines = [`Operating system: ${report.name}`];
  for (const c of report.capabilities) lines.push(`  ${c.available ? 'yes' : 'NO '}  ${c.title}\n        ${c.detail}`);
  return lines.join('\n');
}
