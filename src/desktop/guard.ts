import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationKind } from './bridgeProtocol';

export type { OperationKind } from './bridgeProtocol';

/** What is about to happen, as the policy gate needs to judge it. */
export interface GuardedOperation {
  /** Which driver asks: 'desktop-ui', 'desktop-com', 'sas-eg', 'sas-smc'. */
  driver: string;
  /** The operation: 'click', 'setText', 'com.call', 'runProject', ... */
  operation: string;
  kind: OperationKind;
  /** What it is aimed at, in words: a control description, a project path, a profile name. Never a secret. */
  target?: string | readonly string[];
  /** True for an action on a local window that contacts no host (a UI step). Mirrors `Operation.local` of src/core. */
  local?: boolean;
  /** The host the action contacts, when the caller knows it. Mirrors `Operation.host` of src/core. */
  host?: string;
}

export interface GuardedResult {
  operation: string;
  outcome: 'ok' | 'denied' | 'error';
  durationMs: number;
  /** The operation this is the result of (lets an adapter to src/core's `record({ op, outcome, durationMs })` forward it as it is). */
  op?: GuardedOperation;
}

/**
 * The only thing the desktop layer knows about the policy gate (src/core). `authorize` throws (or rejects) to refuse the operation;
 * `record` is told how it ended. The real implementation (environment allow-list, non-production only for destructive
 * operations, audit log) is plugged in by the fixtures; the default allows everything and records nothing.
 */
export interface OperationGuard {
  authorize(op: GuardedOperation): void | Promise<void>;
  record(result: GuardedResult): void;
}

/** The default: allows everything, records nothing. */
export const permissiveGuard: OperationGuard = {
  authorize: () => undefined,
  record: () => undefined,
};

/**
 * A high-level operation (logon, runProject) is judged ONCE as a whole; the many low-level steps it takes (type into a field, click
 * OK) then run without asking again. Without this, a policy that refuses a click in production could never allow "log on".
 */
const authorizedScope = new AsyncLocalStorage<{ operation: string }>();

/** True while a higher-level operation that was already authorised is running. */
export function insideAuthorizedOperation(): boolean {
  return authorizedScope.getStore() !== undefined;
}

/**
 * Runs `run` after the guard authorised `op`, and tells the guard how it ended (ok, denied, error) and how long it took. A refusal
 * is recorded as `denied` and rethrown unchanged, so the caller sees the gate's own error. Inside an already authorised
 * higher-level operation the guard is not consulted again.
 */
export async function guarded<T>(guard: OperationGuard, op: GuardedOperation, run: () => Promise<T>): Promise<T> {
  if (insideAuthorizedOperation()) return run();
  const startedAt = Date.now();
  try {
    await guard.authorize(op);
  } catch (error) {
    guard.record({ operation: op.operation, outcome: 'denied', durationMs: Date.now() - startedAt, op });
    throw error;
  }
  try {
    const result = await authorizedScope.run({ operation: op.operation }, run);
    guard.record({ operation: op.operation, outcome: 'ok', durationMs: Date.now() - startedAt, op });
    return result;
  } catch (error) {
    guard.record({ operation: op.operation, outcome: 'error', durationMs: Date.now() - startedAt, op });
    throw error;
  }
}
