#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { desktopConfig, FAKE_EG_PATH, FAKE_SMC_PATH, openDesktopSession } from '../../desktop';
import type { UserAction } from '../../desktop/recording';
import { DEFAULT_STOP_KEY, recorderConfig } from '../config';
import { RECORDING_EXTENSION } from '../format';
import { authorizeRecording, Recorder, saveRecording, summarizeRecording } from '../recorder';
import type { CliIo } from './convert';

export const RECORD_USAGE = `sas-desktop-record - record what you do in SAS Management Console or SAS Enterprise Guide

  sas-desktop-record --app smc|eg|<window title regex> --out recordings/name.sasrec.json [options]

Start the program first (Management Console: with the Java Access Bridge enabled - see sas-desktop-inspect doctor), then run this, then work in the
program as you normally would. The recorder only ever looks at the chosen program's windows. Stop with the stop key (default ${DEFAULT_STOP_KEY}) or Ctrl+C here.
When it stops it writes the file, prints a summary and reminds you what was NOT kept: nothing typed into a password field is ever recorded.

Options:
  --app <smc|eg|regex>     The program: smc (SAS Management Console), eg (SAS Enterprise Guide) or a regular expression for a window title. Required.
  --out <file>             Where to write the recording. Default: <SAS_RECORDER_DIR>/<app>-<time>${RECORDING_EXTENSION}.
  --stop-key <chord>       The chord that ends the recording, noticed in any window and recorded in none. Default ${DEFAULT_STOP_KEY} (SAS_RECORDER_STOP_KEY).
  --mode <full|uia>        full: mouse and keyboard hooks plus UI Automation events (default). uia: UI Automation events only (no hooks: use it where
                           hooks are not allowed; clicks on controls that raise no event are then missed) (SAS_RECORDER_MODE).
  --secret-pattern <regex> Also treat a field whose name or automation id matches as a secret. Repeatable (SAS_RECORDER_SECRET_PATTERNS). Use it when a
                           password field is not recognised (a Swing field whose accessible name does not say "password").
  --poll-ms <n>            How often events are collected from the bridge (SAS_RECORDER_POLL_MS).
  --force                  Overwrite the output file if it exists.
  --simulator              Use the built-in stand-in desktop instead of Windows (any OS): for trying the tools. Needs --simulate. Proves nothing about the real programs.
  --simulate <file.json>   With --simulator: a JSON array of user actions the stand-in's "user" performs while recording (see docs/RECORD_AND_PLAY.md).
  -h, --help

Against a real system the recorder only runs for an environment declared in SAS_ENVIRONMENTS_FILE (and production needs SAS_ALLOW_PROD_READS=true).
NOT VERIFIED on a real Windows host with the real programs.
`;

interface Options {
  app: string;
  out?: string;
  stopKey?: string;
  mode?: 'full' | 'uia';
  secretPatterns: string[];
  pollMs?: number;
  force: boolean;
  simulator: boolean;
  simulate?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { app: '', secretPatterns: [], force: false, simulator: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--app') opts.app = value();
    else if (arg === '--out') opts.out = value();
    else if (arg === '--stop-key') opts.stopKey = value();
    else if (arg === '--mode') {
      const mode = value();
      if (mode !== 'full' && mode !== 'uia') throw new Error(`--mode must be full or uia (found "${mode}")`);
      opts.mode = mode;
    } else if (arg === '--secret-pattern') {
      const pattern = value();
      try {
        new RegExp(pattern, 'i');
      } catch {
        throw new Error(`--secret-pattern "${pattern}" is not a valid regular expression`);
      }
      opts.secretPatterns.push(pattern);
    } else if (arg === '--poll-ms') {
      opts.pollMs = Number(value());
      if (!Number.isInteger(opts.pollMs) || opts.pollMs < 20) throw new Error('--poll-ms must be a whole number of at least 20');
    } else if (arg === '--force') opts.force = true;
    else if (arg === '--simulator') opts.simulator = true;
    else if (arg === '--simulate') opts.simulate = value();
    else throw new Error(`unknown option ${arg}`);
  }
  if (!opts.app) throw new Error('--app is required: smc, eg, or a regular expression for a window title');
  if (opts.simulator && !opts.simulate) throw new Error('--simulator has no user to record: give --simulate <actions.json>');
  if (opts.simulate && !opts.simulator) throw new Error('--simulate only works with --simulator');
  return opts;
}

const stdio: CliIo = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) };

/** The recorder as a function (the bin calls it with the process arguments). Returns the exit code: 0 recorded, 1 failed, 2 usage. */
export async function runRecordCli(argv: string[], io: CliIo = stdio): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.out(RECORD_USAGE);
    return 0;
  }
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${RECORD_USAGE}`);
    return 2;
  }
  let actions: UserAction[] | undefined;
  if (opts.simulate) {
    try {
      actions = JSON.parse(fs.readFileSync(opts.simulate, 'utf8')) as UserAction[];
      if (!Array.isArray(actions)) throw new Error('not an array');
    } catch (error) {
      io.err(`--simulate ${opts.simulate}: ${(error as Error).message}\n`);
      return 2;
    }
  }
  try {
    const config = recorderConfig();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = opts.out ?? path.join(config.dir, `${opts.app.replace(/[^A-Za-z0-9_-]+/g, '_')}-${stamp}${RECORDING_EXTENSION}`);
    if (!out.toLowerCase().endsWith(RECORDING_EXTENSION)) {
      io.err(`--out must end in ${RECORDING_EXTENSION} (found "${out}")\n`);
      return 2;
    }
    if (fs.existsSync(out) && !opts.force) {
      io.err(`${out} already exists: choose another name, or overwrite it on purpose with --force\n`);
      return 2;
    }
    if (!opts.simulator) {
      const environment = authorizeRecording(opts.app);
      io.out(`environment: ${environment} (allowed)\n`);
    }
    const desktop = { ...desktopConfig(), ...(opts.simulator ? { simulator: true } : {}) };
    const opened = await openDesktopSession({ config: desktop });
    try {
      if (opened.simulator) {
        // the stand-in has nothing running: start the program(s) so there is something to record
        const programs = opts.app === 'smc' ? [FAKE_SMC_PATH] : opts.app === 'eg' ? [FAKE_EG_PATH] : [FAKE_SMC_PATH, FAKE_EG_PATH];
        for (const program of programs) await opened.session.launch({ path: program, windowTitle: /./ });
      }
      const isTty = Boolean(process.stdout.isTTY) && io === stdio;
      const recorder = await Recorder.start(opened.session, {
        app: opts.app,
        mode: opts.mode ?? config.mode,
        stopKey: opts.stopKey ?? config.stopKey,
        pollMs: opts.pollMs ?? config.pollMs,
        maxQueue: config.maxQueue,
        secretPatterns: [...config.secretPatterns, ...opts.secretPatterns],
        onProgress: (progress) => {
          if (isTty) process.stdout.write(`\r  events seen: ${progress.eventsSeen}   `);
        },
      });
      const stopKey = opts.stopKey ?? config.stopKey;
      io.out(`Recording ${opts.app} (${recorder.started.process}, ${recorder.started.windows} window(s) open).\n`);
      if (actions) {
        io.out('The stand-in desktop performs the simulated user actions now.\n');
        await opened.simulator?.desktop.simulateUserActions(actions);
        await recorder.collect();
      } else {
        io.out(`Work in the program as you normally would. Stop with ${stopKey} (or Ctrl+C here). Nothing typed into a password field is kept.\n`);
        const interrupted = new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
        await Promise.race([recorder.stopRequested, interrupted]);
        if (isTty) process.stdout.write('\n');
      }
      const result = await recorder.stop();
      const file = saveRecording(out, result.recording, { overwrite: opts.force });
      for (const line of summarizeRecording(result, file)) io.out(`${line}\n`);
      io.out(`Next: sas-desktop-to-playwright ${file} --expect-text "<something that proves it worked>"\n`);
      return 0;
    } finally {
      await opened.close();
    }
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runRecordCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
