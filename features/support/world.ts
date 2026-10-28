import type { ProcessResult } from '../../src/process';

/**
 * What the steps of THIS repository (features/support/*.ts) carry from one step of a scenario to the next, on top of the
 * `DesktopScenario` the shipped vocabulary uses. A fresh one for every scenario (the `world` fixture).
 */
export class SasWorld {
  /** What the last `I try to ...` step ended with: `error` is the failure, or undefined when the attempt worked. */
  attempt?: { error: unknown };
  /** The files the last export reported. */
  written: string[] = [];
  /** The last command the process driver ran. */
  command?: ProcessResult;
  /** A file the stand-in tool writes when - and only when - it starts. */
  marker?: string;
  /** The command the real-machine samples run (SAS_SAMPLE_TOOL and friends). */
  sample?: { tool: string; args: string[]; successExit: number; expected: string | undefined };
}
