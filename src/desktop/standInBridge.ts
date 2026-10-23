#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { startFakeDesktop } from './fakeApps';
import type { UserAction } from './recording';
import { DesktopTransportError, type DesktopCommand } from './types';

/**
 * A STAND-IN for bridge/sas-desktop-bridge.ps1: a Node program that speaks the same line protocol on stdin/stdout, backed by the
 * in-memory desktop with a fake Management Console and a fake Enterprise Guide installed. It lets ProcessTransport, RemoteTransport
 * and the whole TypeScript side run for real on any machine. `-AllowProgIds a,b` sets the COM allow-list, like the real script.
 *
 * Fault injection through the environment (read with the shared ConfigReader; the real bridge has no such switches):
 *
 *   BRIDGE_JUNK=1                  print a non-JSON line before the ready message
 *   BRIDGE_NO_READY=1              never say ready
 *   BRIDGE_DELAY_OPS=ping:300      answer `ping` 300 ms late (others immediately) -> out-of-order replies
 *   BRIDGE_HANG_OPS=find           never answer `find`
 *   BRIDGE_CRASH_OP=find           write to stderr and exit(3) when `find` arrives
 *   BRIDGE_CLOSE_STDIN=1           after saying ready, close the read end of stdin but stay alive -> the next write is EPIPE
 *   BRIDGE_SESSION_LOST_OP=find    answer that op with code SESSION_LOST
 *
 * `--without-recorder` makes record.start / record.events / record.stop answer NOT_IMPLEMENTED, like a bridge whose recorder could not be compiled
 * (or one that predates it).
 *
 * Recording: `record.start` / `record.events` / `record.stop` are answered by the stand-in's recorder. `--simulate-actions <file.json>` (a
 * JSON array of UserAction, see recording.ts) makes the stand-in's "user" perform those actions right after `record.start` succeeded and before
 * it answers, so a test over the real line protocol finds the raw events waiting for `record.events`.
 */
export function runStandInBridge(argv: string[] = process.argv.slice(2), env: ConfigReader = loadEnv()): void {
  const allowIndex = argv.indexOf('-AllowProgIds');
  const allowProgIds = allowIndex >= 0 && argv[allowIndex + 1] ? (argv[allowIndex + 1] as string).split(/[,;]/).map((p) => p.trim()).filter(Boolean) : undefined;
  const withoutRecorder = argv.includes('--without-recorder');
  const simulateIndex = argv.indexOf('--simulate-actions');
  const simulateFile = simulateIndex >= 0 ? argv[simulateIndex + 1] : undefined;
  const fake = startFakeDesktop({ ...(allowProgIds ? { allowProgIds } : {}) });
  const table = (name: string): Record<string, string> =>
    Object.fromEntries(
      env
        .getList(name, [])
        .map((entry) => entry.split(':'))
        .map(([op, ms]) => [op as string, ms ?? '']),
    );
  const delays = table('BRIDGE_DELAY_OPS');
  const hang = new Set(env.getList('BRIDGE_HANG_OPS', []));
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

  if (env.getBoolean('BRIDGE_JUNK', false)) process.stdout.write('this is not json\n');
  if (!env.getBoolean('BRIDGE_NO_READY', false)) send({ rid: 0, ok: true, value: 'ready' });
  if (env.getBoolean('BRIDGE_CLOSE_STDIN', false)) {
    setInterval(() => undefined, 1000); // stay alive without reading
    process.stdin.destroy();
    try {
      fs.closeSync(0); // really close the read end, so the parent's next write fails with EPIPE
    } catch {
      // already closed
    }
  }

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (line.trim().length === 0) return; // like the PowerShell bridge: a blank line is ignored (the remote transport sends one to read the ready line)
    const { rid, ...command } = JSON.parse(line) as { rid: number } & DesktopCommand;
    if (env.getOptional('BRIDGE_CRASH_OP') === command.op) {
      process.stderr.write(`stand-in bridge crashed on ${command.op}\n`);
      process.exit(3);
    }
    if (hang.has(command.op)) return;
    if (env.getOptional('BRIDGE_SESSION_LOST_OP') === command.op) {
      send({ rid, ok: false, error: 'the desktop is locked or the session is disconnected', code: 'SESSION_LOST' });
      return;
    }
    const reply = async () => {
      if (withoutRecorder && command.op.startsWith('record.')) {
        send({ rid, ok: false, error: `"${command.op}" is not available in this bridge: the recorder is not installed`, code: 'NOT_IMPLEMENTED' });
        return;
      }
      try {
        const value = await fake.desktop.request(command as DesktopCommand);
        if (command.op === 'record.start' && simulateFile) await fake.desktop.simulateUserActions(JSON.parse(fs.readFileSync(simulateFile, 'utf8')) as UserAction[]);
        send({ rid, ok: true, value: value === undefined ? null : value });
      } catch (error) {
        send({ rid, ok: false, error: (error as Error).message, code: error instanceof DesktopTransportError ? error.code : 'ERROR' });
      }
      if (command.op === 'quit') process.exit(0);
    };
    if (delays[command.op]) setTimeout(reply, Number(delays[command.op]));
    else void reply();
  });
}

if (require.main === module) runStandInBridge();
