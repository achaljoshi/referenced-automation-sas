import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger } from '@automation/referenced-automation-utils';
import type { Operation, PolicyRule, SafetyPolicy } from '../core';
import type { GuardedOperation, GuardedResult, OperationGuard } from '../desktop';

const log = getLogger('sas-fixtures');

/**
 * Plugs the core safety policy (`SafetyPolicy` + its `AuditLog`) into the desktop layer's `OperationGuard`, so every privileged
 * step of every desktop driver passes the gate and leaves an audit record - the single place where the two vocabularies meet.
 *
 *  - ENVIRONMENT. The desktop layer does not know which SAS environment a run works against; the adapter supplies the selected one.
 *  - HOST. The desktop programs reach SAS through their own saved profiles (Management Console's connection profile, Enterprise
 *    Guide's server profile), so the framework cannot see the host. A step that names no host is passed as `local: true`: the host
 *    allow-list is therefore NOT enforced for desktop steps - the environment kind, the namespace rule and the audit log are. (A step
 *    that does name a host, `op.host`, is checked against the allow-list as usual.)
 *  - RESULTS. `record` forwards `ok` / `error` outcomes with their duration. A `denied` outcome is NOT forwarded again: the policy
 *    already wrote its `denied` record when it refused.
 *  - NAMESPACE. The policy refuses to change anything outside the run's namespace (`AUTO_<runId>_...`). That is judged on the SAS
 *    object an operation names (a project, a program, a folder). A RAW UI step (a click, a keystroke: driver `desktop-ui`) names a
 *    control, not an object, so for those three rules are not applicable - `outside-namespace`, `target-required`, `invalid-target` -
 *    while every other rule still applies: in production a raw click is `prod-read-only` and refused. Raw COM calls (driver
 *    `desktop-com`) are NOT exempt: their target is a member name, never inside a namespace, so they are refused unless the run says
 *    why with SAS_ALLOW_OUTSIDE_NAMESPACE (fail closed).
 *  - HOUSEKEEPING. Closing a program this run started is not a change to SAS. Inside `housekeeping(...)` the two operations that do
 *    that (`closeWindow`, `kill`) are judged as reads, so a test that only read production can still close what it opened.
 */

/** Rules about the TARGET of a change; a raw UI step has a control description as its target, so these do not apply to it. */
const TARGET_RULES: ReadonlySet<PolicyRule> = new Set<PolicyRule>(['outside-namespace', 'target-required', 'invalid-target']);

/** The driver name the desktop layer uses for raw UI steps. */
export const RAW_UI_DRIVER = 'desktop-ui';

/** The raw UI steps (the `label` of `session.act`, and the application-level close / kill). */
export const RAW_UI_OPERATIONS: ReadonlySet<string> = new Set(['click', 'doubleClick', 'rightClick', 'fill', 'select', 'expand', 'collapse', 'check', 'uncheck', 'focus', 'scrollIntoView', 'press', 'closeWindow', 'kill']);

/** What housekeeping may close or stop: only the programs this run started. */
const HOUSEKEEPING_OPERATIONS: ReadonlySet<string> = new Set(['closeWindow', 'kill']);

export class PolicyGuardAdapter implements OperationGuard {
  private readonly housekeepingScope = new AsyncLocalStorage<true>();

  constructor(
    readonly policy: SafetyPolicy,
    /** The selected SAS environment's name. */
    readonly environment: string,
  ) {}

  private inHousekeeping(op: GuardedOperation): boolean {
    return this.housekeepingScope.getStore() === true && op.driver === RAW_UI_DRIVER && HOUSEKEEPING_OPERATIONS.has(op.operation);
  }

  /** The core operation for a desktop operation: the environment is added, a step that names no host is local, housekeeping is a read. */
  toOperation(op: GuardedOperation): Operation {
    return {
      driver: op.driver,
      operation: op.operation,
      kind: this.inHousekeeping(op) ? 'read' : op.kind,
      ...(op.target === undefined ? {} : { target: op.target }),
      environment: this.environment,
      ...(op.host === undefined ? { local: true } : { host: op.host }),
    };
  }

  private isRawUiStep(op: GuardedOperation): boolean {
    return op.driver === RAW_UI_DRIVER && RAW_UI_OPERATIONS.has(op.operation);
  }

  /** Throws the policy's PolicyViolation (after it wrote a `denied` audit record) when the operation is not allowed. */
  authorize(op: GuardedOperation): void {
    const core = this.toOperation(op);
    if (this.isRawUiStep(op)) {
      const { violation } = this.policy.evaluate(core);
      if (violation === undefined || TARGET_RULES.has(violation.rule)) {
        this.policy.audit.ensureWritable(); // fail closed: no step without a working audit log
        if (violation) log.debug(`[sas-fixtures] ${op.operation} is a raw UI step: the target rule "${violation.rule}" does not apply to a control`);
        return;
      }
    }
    this.policy.authorize(core);
  }

  record(result: GuardedResult): void {
    if (result.outcome === 'denied' || result.op === undefined) return;
    const housekeeping = this.inHousekeeping(result.op);
    this.policy.record({
      op: this.toOperation(result.op),
      outcome: result.outcome,
      durationMs: result.durationMs,
      ...(housekeeping ? { detail: { housekeeping: true, requestedKind: result.op.kind } } : {}),
    });
  }

  /** Runs `run` (closing the programs this run started) with `closeWindow` and `kill` judged as reads. */
  housekeeping<T>(run: () => Promise<T>): Promise<T> {
    return this.housekeepingScope.run(true, run);
  }
}
