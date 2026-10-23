import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog, SafetyPolicy, type OperationGuard, type Operation, type OperationResult } from '../../src/core';
import { ProcessDriver, type ProcessDriverOptions } from '../../src/process';
import { config, makeRun, registry, tempDir } from '../core/support';

export const FAKE_TOOL_SOURCE = path.join(__dirname, 'support', 'fake-batch-tool.js');

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

export function driver(options: Partial<ProcessDriverOptions> = {}, guard: OperationGuard = new RecordingGuard()): ProcessDriver {
  return new ProcessDriver({ guard, environment: 'dev', env: config(), toolDirs: [], killGraceMs: 150, drainMs: 150, ...options });
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
