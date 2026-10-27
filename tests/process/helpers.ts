import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog, SafetyPolicy, type OperationGuard, type Operation, type OperationResult } from '../../src/core';
import { ProcessDriver, type ProcessDriverOptions, type ProcessResult, type RunOptions } from '../../src/process';
import { config, makeRun, registry, tempDir } from '../core/support';

export const FAKE_TOOL_SOURCE = path.join(__dirname, 'support', 'fake-batch-tool.js');

/**
 * Windows runs only .exe files, so a script with a shebang cannot be started by its bare name there. On Windows the fake tool is started
 * as `node <script>` by absolute path instead. SAS_TEST_NODE_LAUNCH=1 takes the same route on any system, which is how that path is
 * exercised on macOS and Linux (NOT VERIFIED on Windows itself until the suite has run there).
 */
export const LAUNCH_BY_NODE = process.platform === 'win32' || process.env.SAS_TEST_NODE_LAUNCH === '1';

/** The reason shown for a test that needs the fake tool started by its bare name, which Windows cannot do. */
export const BARE_NAME_NEEDS_UNIX = 'needs the fake tool started by its own name: a script cannot be on Windows (only .exe files run), and SAS_TEST_NODE_LAUNCH=1 starts it through node instead; resolution with .exe is covered by the fake-platform test';

/** A tool folder holding the fake batch tool under the name `fakebatch` (a script with an absolute-path shebang, executable). */
export function toolDir(): string {
  const dir = tempDir('sas-tools-');
  const file = path.join(dir, 'fakebatch');
  const body = fs.readFileSync(FAKE_TOOL_SOURCE, 'utf8').replace(/^#!.*\n/, '');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  return dir;
}

/** A guard that allows everything and remembers what it saw - for tests of the driver alone. The real policy is used where the policy is the subject. */
export class RecordingGuard implements OperationGuard {
  authorized: Operation[] = [];
  recorded: OperationResult[] = [];
  deny?: Error;
  authorize(op: Operation): void {
    if (this.deny) throw this.deny;
    this.authorized.push(op);
  }
  record(result: OperationResult): void {
    this.recorded.push(result);
  }
}

/** Where the bare-name script cannot run, `fakebatch` is started as `node <script>` by absolute path: same arguments, same driver rules. */
class NodeLaunchDriver extends ProcessDriver {
  override async run(options: RunOptions): Promise<ProcessResult> {
    if (!LAUNCH_BY_NODE || options.command !== 'fakebatch') return super.run(options);
    return super.run({ ...options, command: process.execPath, args: [FAKE_TOOL_SOURCE, ...(options.args ?? [])] });
  }
}

export function driver(options: Partial<ProcessDriverOptions> = {}, guard: OperationGuard = new RecordingGuard()): ProcessDriver {
  return new NodeLaunchDriver({ guard, environment: 'dev', env: config(), toolDirs: [], killGraceMs: 150, drainMs: 150, ...options });
}

/** The real policy writing to a temp audit file. */
export function realPolicy(values: Record<string, string> = {}): { policy: SafetyPolicy; file: string; run: ReturnType<typeof makeRun> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-proc-audit-'));
  const run = makeRun(values);
  const file = path.join(dir, 'audit.jsonl');
  const policy = new SafetyPolicy({ env: config(values), run, environments: registry(), audit: new AuditLog({ file, run, env: config(values) }) });
  return { policy, file, run };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return condition();
}
