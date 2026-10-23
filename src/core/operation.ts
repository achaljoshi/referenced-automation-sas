/** What an operation does to SAS. Every privileged action is classified; there is no "unknown". */
export type OperationKind = 'read' | 'create' | 'update' | 'destructive';

export const OPERATION_KINDS: readonly OperationKind[] = ['read', 'create', 'update', 'destructive'];

/** One privileged action a driver is about to take. */
export interface Operation {
  /** Which driver asks: 'sas-process', 'sas-com', 'sas-desktop', ... */
  driver: string;
  /** What it does, in the driver's words: 'export-package', 'run-project'. No secrets. */
  operation: string;
  kind: OperationKind;
  /** The SAS object(s) the action changes or reads: a name or a path (`/Shared Data/AUTO_<runId>_Users`). Required for every mutating kind. */
  target?: string | readonly string[];
  /** The name of the selected environment (`dev`, `qa`, ...). */
  environment: string;
  /** The host the action will contact: a metadata server, a URL, a UNC path. Checked against the environment's allow-list. */
  host?: string;
  /** True only for an action that contacts no host (a UI action on a local window). A mutating action needs `host` or `local: true`. */
  local?: boolean;
}

export type OperationOutcome = 'ok' | 'denied' | 'error';

/** What happened to an authorized operation. */
export interface OperationResult {
  op: Operation;
  outcome: Exclude<OperationOutcome, 'denied'>;
  durationMs: number;
  /** Short, secret-free facts for the audit record: `{ exitCode: 0 }`. */
  detail?: Record<string, unknown>;
}

/**
 * What drivers depend on. `authorize` throws PolicyViolation (and writes a `denied` audit record) when the operation is not allowed;
 * `record` writes the `ok` / `error` audit record once the operation has run. A driver calls `authorize` BEFORE it touches SAS and
 * `record` after, in a `finally` (see `guardedOperation` in safetyPolicy.ts).
 */
export interface OperationGuard {
  authorize(op: Operation): void;
  record(result: OperationResult): void;
}
