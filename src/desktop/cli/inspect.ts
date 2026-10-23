#!/usr/bin/env node
import { desktopConfig } from '../config';
import { bridgeScriptPath } from '../bridgeFile';
import { BRIDGE_SHA256 } from '../bridgeHash.generated';
import { formatDoctor, runDoctor } from '../doctor';
import { FAKE_EG_PATH, FAKE_SMC_PATH } from '../fakeApps';
import { formatInspection, formatWindows, inspectWindows, windowPatternFor } from '../inspect';
import { openDesktopSession } from '../transportFactory';

const USAGE = `sas-desktop-inspect - see what the SAS desktop programs look like to the automation, and whether this machine is ready

  sas-desktop-inspect doctor                          check: bridge script, PowerShell, interactive desktop, UI Automation,
                                                      Java Access Bridge, program paths, Enterprise Guide COM
  sas-desktop-inspect windows                         list the open windows with their process
  sas-desktop-inspect inspect --app smc|eg|<regex> [--depth n]
                                                      print every control of the matching window(s): name, automation id, control type,
                                                      class and a locator to paste into the LOCATORS table (passwords are never read)
  sas-desktop-inspect --print-bridge                  where the bridge script is and the SHA-256 this version expects

Options: --simulator   use the built-in stand-in desktop (any OS) with its fake programs started
Settings come from the environment (see .env.example): SAS_DESKTOP_TRANSPORT, SAS_SMC_PATH, SAS_EG_PATH, ...

Start the program first (Management Console: logged on, and with the Java Access Bridge enabled), then run inspect.
NOT VERIFIED on a real Windows host with the real SAS programs.
`;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command === '--print-bridge') {
    process.stdout.write(`${bridgeScriptPath()}\nexpected SHA-256: ${BRIDGE_SHA256}\n`);
    return 0;
  }
  const config = { ...desktopConfig(), ...(args.includes('--simulator') ? { simulator: true } : {}) };
  const opened = await openDesktopSession({ config });
  try {
    if (config.simulator) {
      // the stand-in has nothing running: start its two programs so there is something to look at
      const smc = await opened.session.launch({ path: FAKE_SMC_PATH, windowTitle: /./ });
      const eg = await opened.session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
      void smc;
      void eg;
    }
    if (command === 'doctor') {
      const report = await runDoctor(opened.session, { config, checkPaths: !config.simulator });
      process.stdout.write(`${formatDoctor(report)}\n`);
      return report.ok ? 0 : 1;
    }
    if (command === 'windows') {
      process.stdout.write(`${formatWindows(await opened.session.listWindows())}\n`);
      return 0;
    }
    if (command === 'inspect') {
      const app = option(args, '--app');
      if (!app) {
        process.stderr.write('inspect needs --app smc|eg|<window title regex>\n');
        return 2;
      }
      const depth = Number(option(args, '--depth') ?? 6);
      if (!Number.isInteger(depth) || depth < 1) {
        process.stderr.write('--depth must be a whole number of at least 1\n');
        return 2;
      }
      process.stdout.write(`${formatInspection(await inspectWindows(opened.session, windowPatternFor(app), depth))}\n`);
      return 0;
    }
    process.stderr.write(`unknown command "${command}"\n${USAGE}`);
    return 2;
  } finally {
    await opened.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
