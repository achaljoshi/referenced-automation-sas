import * as fs from 'node:fs';
import { ComClient } from './com';
import { desktopConfig, type DesktopConfig } from './config';
import { verifyBridge } from './bridgeFile';
import { discoverEgProgId } from './apps/enterpriseGuide';
import type { DesktopSession } from './session';
import type { EnvironmentInfo, JavaDiagnosis, PingResult } from './types';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when `ok` is false. */
  hint?: string;
  /** A finding that does not stop the tests (warning only). */
  warn?: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** No failed check (warnings do not count). */
  ok: boolean;
}

export interface DoctorOptions {
  config?: DesktopConfig;
  /** Where the program paths are checked (default: this machine; false skips the check, as for a remote host or the simulator). */
  checkPaths?: boolean;
  exists?: (file: string) => boolean;
}

/** The Java Access Bridge instructions, with the exact path of jabswitch when one was found. */
export function javaAccessBridgeHint(env?: Pick<EnvironmentInfo, 'jabswitch'>): string {
  const tool = env?.jabswitch[0] ? `"${env.jabswitch[0]}"` : 'jabswitch.exe (in the bin folder of the Java that Management Console uses, for example SASHome\\SASPrivateJavaRuntimeEnvironment\\9.4\\jre\\bin)';
  return `Enable the Java Access Bridge: run ${tool} -enable in a command prompt, then close and restart Management Console. Windows UI Automation cannot see Swing controls until it is enabled.`;
}

/**
 * Checks, in order, what the desktop tests need: the bridge script is the one this version shipped, the bridge starts, the machine is
 * Windows with an unlocked interactive session, UI Automation works, the Java Access Bridge is on (for Management Console), the program
 * paths exist, and the Enterprise Guide COM class can be created. Changes nothing (it creates and releases one COM object).
 */
export async function runDoctor(session: DesktopSession, options: DoctorOptions = {}): Promise<DoctorReport> {
  const config = options.config ?? desktopConfig();
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);

  const verification = verifyBridge();
  add({
    name: 'the bridge script is the one this version shipped',
    ok: verification.ok,
    detail: verification.ok ? `SHA-256 ${verification.actual.slice(0, 16)}...` : `expected ${verification.expected.slice(0, 16)}..., found ${verification.actual.slice(0, 16)}...`,
    hint: verification.ok ? undefined : 'The script was modified or is out of date. Restore it, or after a reviewed change run: node bridge/generate-hash.js',
  });

  let ping: PingResult | undefined;
  try {
    ping = await session.ping();
    add({ name: 'the bridge starts and answers', ok: true, detail: `${ping.bridge} protocol ${ping.version}${ping.powershell ? `, PowerShell ${ping.powershell}` : ''}${ping.is64BitProcess === false ? ', 32-bit' : ''}` });
  } catch (error) {
    add({ name: 'the bridge starts and answers', ok: false, detail: error instanceof Error ? error.message : String(error), hint: 'Windows PowerShell 5.1 (powershell.exe) must be on the PATH; on a managed desktop see SAS_DESKTOP_SCRIPT_DIR for an approved script, or SAS_DESKTOP_TRANSPORT=remote.' });
    return { checks, ok: false };
  }

  let env: EnvironmentInfo | undefined;
  try {
    env = (await session.send({ op: 'environment' })) as EnvironmentInfo;
    add({ name: 'this is Windows with an interactive session', ok: env.userInteractive, detail: `${env.os}, session "${env.sessionName || '(none)'}"`, hint: env.userInteractive ? undefined : 'UI Automation needs a logged-in interactive session, not a service or a scheduled task without a desktop.' });
    add({
      name: 'the desktop is unlocked and connected',
      ok: env.desktopAccessible,
      detail: env.desktopAccessible ? 'the input desktop can be opened' : 'the input desktop cannot be opened',
      hint: env.desktopAccessible ? undefined : 'Unlock the workstation / reconnect the RDP session. A locked or disconnected desktop makes every UI step fail with SESSION_LOST.',
    });
    add({ name: 'UI Automation works', ok: env.uiaAvailable, detail: `${env.topLevelWindows} top-level window(s) visible`, hint: env.uiaAvailable ? undefined : 'The UIAutomationClient assemblies could not be used by PowerShell.' });
    add({ name: 'the bridge is not elevated (or the programs are)', ok: true, warn: env.elevated, detail: env.elevated ? 'the bridge runs as administrator: it can automate elevated programs' : 'the bridge runs with normal rights: it cannot automate a program started "as administrator"' });
    add({
      name: 'COM allow-list',
      ok: env.allowedProgIds.length > 0,
      detail: env.allowedProgIds.join(', ') || '(empty)',
      hint: env.allowedProgIds.length > 0 ? undefined : 'SAS_COM_PROGIDS leaves nothing creatable.',
    });
  } catch (error) {
    add({ name: 'the bridge reports its environment', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  // Java Access Bridge (Management Console)
  try {
    const java = (await session.send({ op: 'diagnoseJava' })) as JavaDiagnosis;
    const empty = java.windows.filter((w) => w.suspectedBridgeMissing);
    if (java.windows.length === 0) {
      add({
        name: 'Java Access Bridge (Management Console)',
        ok: true,
        warn: !java.accessBridgeDll || !java.accessibilityProperties,
        detail: `no Java window is open to test; access bridge DLL ${java.accessBridgeDll ? 'present' : 'NOT found'}, .accessibility.properties ${java.accessibilityProperties ? 'enabled' : 'NOT enabled'}`,
        hint: java.accessBridgeDll && java.accessibilityProperties ? undefined : javaAccessBridgeHint(env),
      });
    } else if (empty.length > 0) {
      add({
        name: 'Java Access Bridge (Management Console)',
        ok: false,
        detail: `${empty.map((w) => `"${w.title}" (${w.process}, pid ${w.pid})`).join(', ')}: a Java window whose UI Automation tree is empty - the symptom of a disabled Java Access Bridge`,
        hint: javaAccessBridgeHint(env),
      });
    } else {
      add({ name: 'Java Access Bridge (Management Console)', ok: true, detail: `${java.windows.length} Java window(s) expose controls to UI Automation` });
    }
  } catch (error) {
    add({ name: 'Java Access Bridge (Management Console)', ok: true, warn: true, detail: `could not be checked: ${error instanceof Error ? error.message : String(error)}` });
  }

  // program paths
  const exists = options.exists ?? fs.existsSync;
  if (options.checkPaths !== false) {
    for (const [label, key, value] of [['Management Console', 'SAS_SMC_PATH', config.smcPath], ['Enterprise Guide', 'SAS_EG_PATH', config.egPath]] as const) {
      if (!value) add({ name: `${label} path`, ok: true, warn: true, detail: `${key} is not set (needed to launch it; attaching to a running one does not need it)` });
      else add({ name: `${label} path`, ok: exists(value), detail: value, hint: exists(value) ? undefined : `${key} points to a file that does not exist.` });
    }
  }

  // COM
  try {
    const com = new ComClient(session, { allowProgIds: config.comProgIds, driver: 'desktop-com' });
    const found = await discoverEgProgId(com, config.egProgId);
    const probe = await com.create(found.progId);
    await probe.release();
    add({ name: 'Enterprise Guide COM object can be created', ok: true, detail: `${found.progId} (${found.how})` });
  } catch (error) {
    add({
      name: 'Enterprise Guide COM object can be created',
      ok: false,
      detail: error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error),
      hint: 'Enterprise Guide installed? An older (32-bit) one needs SAS_DESKTOP_POWERSHELL=C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe. Set SAS_EG_PROGID to the exact name.',
    });
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map((c) => `  ${c.ok ? (c.warn ? 'WARN ' : 'OK   ') : 'FAIL '} ${c.name}: ${c.detail}${c.hint ? `\n         -> ${c.hint}` : ''}`);
  lines.push('', report.ok ? 'All checks passed (warnings, if any, do not stop the tests).' : 'Some checks failed: fix them in order from the top.');
  lines.push('NOT VERIFIED: this tool and the bridge have not run on a real Windows host with the real SAS programs; treat a green report as a first sign, not a guarantee.');
  return lines.join('\n');
}

