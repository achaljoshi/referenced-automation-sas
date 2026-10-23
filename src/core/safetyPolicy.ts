import { getLogger, loadEnv, scrubText, type ConfigReader } from '@automation/referenced-automation-utils';
import { AuditLog } from './audit';
import { EnvironmentRegistry, assertHostAllowed, loadEnvironments, type SasEnvironment } from './environments';
import { PolicyViolation } from './errors';
import { OPERATION_KINDS, type Operation, type OperationGuard, type OperationResult } from './operation';
import { getRunContext, targetInNamespace, type RunContext } from './runContext';

export type { Operation, OperationGuard, OperationKind, OperationOutcome, OperationResult } from './operation';

const log = getLogger('sas-policy');

const MIN_REASON_LENGTH = 8;

export interface SafetyPolicyOptions {
  environments?: EnvironmentRegistry;
  env?: ConfigReader;
  run?: RunContext;
  audit?: AuditLog;
  /** Overrides SAS_ALLOW_PROD_READS (tests, or code that decides itself). */
  allowProdReads?: boolean;
  /** Overrides SAS_ALLOW_OUTSIDE_NAMESPACE / SAS_ALLOW_OUTSIDE_NAMESPACE_REASON. */
  allowOutsideNamespace?: { reason?: string } | false;
}

/**
 * The gate in front of every privileged action (ADR 0001, "Security model"). `authorize(op)` decides; the decision uses ONLY the
 * operation, the declared environments and these settings - never anything a test can pass in to loosen it.
 *
 *  1. The environment must be declared (`unknown-environment`), the kind must be one of read/create/update/destructive.
 *  2. A host, when given, must be on the environment's allow-list (`host-not-allowed`). A mutating action must name a host or say it is
 *     purely local (`host-required`); a read in production must name a host too.
 *  3. `prod` is read-only (`prod-read-only`) and reads need SAS_ALLOW_PROD_READS=true (`prod-reads-disabled`). Nothing overrides this.
 *  4. On `nonprod`, a read is allowed. A mutation needs a target (`target-required`), a plain one (`invalid-target`: no "..", no wildcards
 *     for a destructive action) inside the run's test namespace (`outside-namespace`). SAS_ALLOW_OUTSIDE_NAMESPACE=true lifts only the
 *     namespace check, needs SAS_ALLOW_OUTSIDE_NAMESPACE_REASON (`override-reason-missing`), is logged as a warning and marked in the audit record.
 *
 * A refusal writes a `denied` audit record and throws a PolicyViolation naming the rule and how to proceed.
 */
export class SafetyPolicy implements OperationGuard {
  private readonly registry: EnvironmentRegistry;
  private readonly run: RunContext;
  readonly audit: AuditLog;
  private readonly allowProdReads: boolean;
  private readonly outside: { reason?: string | undefined } | false;

  constructor(options: SafetyPolicyOptions = {}) {
    const env = options.env ?? loadEnv();
    this.registry = options.environments ?? loadEnvironments(env);
    this.run = options.run ?? getRunContext();
    this.audit = options.audit ?? new AuditLog({ env, run: this.run });
    this.allowProdReads = options.allowProdReads ?? env.getBoolean('SAS_ALLOW_PROD_READS', false);
    if (options.allowOutsideNamespace !== undefined) this.outside = options.allowOutsideNamespace;
    else if (env.getBoolean('SAS_ALLOW_OUTSIDE_NAMESPACE', false)) this.outside = { reason: env.getOptional('SAS_ALLOW_OUTSIDE_NAMESPACE_REASON')?.trim() };
    else this.outside = false;
  }

  /** The declared environments (for fixtures and health checks). */
  get environments(): EnvironmentRegistry {
    return this.registry;
  }

  /** Decides without writing or throwing: `undefined` = allowed, a PolicyViolation = refused. `override` says what was lifted. */
  evaluate(op: Operation): { violation?: PolicyViolation; override?: { name: string; reason: string } } {
    const v = (rule: ConstructorParameters<typeof PolicyViolation>[0], what: string, how: string) => ({ violation: new PolicyViolation(rule, op.driver, op.operation, what, how) });
    let environment: SasEnvironment;
    try {
      environment = this.registry.require(op.environment, op.driver, op.operation);
    } catch (error) {
      return { violation: error as PolicyViolation };
    }
    if (!OPERATION_KINDS.includes(op.kind))
      return v('invalid-operation', `operation kind "${String(op.kind)}" is not one of ${OPERATION_KINDS.join(', ')}.`, 'classify the action as read, create, update or destructive in the driver.');
    const mutating = op.kind !== 'read';

    if (op.host !== undefined) {
      try {
        assertHostAllowed(environment, op.host, op);
      } catch (error) {
        return { violation: error as PolicyViolation };
      }
    } else if (mutating && op.local !== true) {
      return v('host-required', `a ${op.kind} action must say which host it contacts, so the allow-list of "${environment.name}" can be checked.`, 'pass the host (metadata server, URL or UNC path) in the operation, or local: true for an action that contacts no host.');
    } else if (environment.kind === 'prod' && op.local !== true) {
      return v('host-required', `a read in production ("${environment.name}") must say which host it contacts.`, 'pass the host in the operation.');
    }

    if (environment.kind === 'prod') {
      if (mutating)
        return v('prod-read-only', `"${environment.name}" is a production environment: a ${op.kind} action ("${op.operation}") is never allowed there.`, 'run this against a nonprod environment. There is no setting that allows changes in production.');
      if (!this.allowProdReads)
        return v('prod-reads-disabled', `"${environment.name}" is a production environment and reads there are switched off.`, 'set SAS_ALLOW_PROD_READS=true for a run that only reads (it still cannot change anything).');
      return {};
    }

    if (!mutating) return {};

    const targets = op.target === undefined ? [] : typeof op.target === 'string' ? [op.target] : [...op.target];
    if (targets.length === 0 || targets.some((t) => t.trim() === ''))
      return v('target-required', `a ${op.kind} action ("${op.operation}") must name the object it changes, so it can be checked against the test namespace.`, `pass the object name or path as the operation target (for example run.ns('Users') = ${this.run.ns('Users')}).`);
    for (const target of targets) {
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f]/.test(target) || target.split(/[\\/]/).some((s) => s.trim() === '..' || s.trim() === '.') || (op.kind === 'destructive' && /[*?%]/.test(target)))
        return v('invalid-target', `target "${scrubText(target)}" is not a plain object name or path (control characters, "." / ".." segments, and wildcards on a destructive action are refused).`, 'pass the exact name or path of one test object.');
    }
    const outsideTargets = targets.filter((t) => !targetInNamespace(t, this.run.namespacePrefix));
    if (outsideTargets.length === 0) return {};
    if (this.outside === false)
      return v(
        'outside-namespace',
        `${op.kind} on "${scrubText(outsideTargets.join('", "'))}" is outside this run's test namespace "${this.run.namespacePrefix}": tests may only change objects they created under that name.`,
        `create and change only objects named with run.ns(...) (for example ${this.run.ns('Users')}). To touch something else deliberately, set SAS_ALLOW_OUTSIDE_NAMESPACE=true together with SAS_ALLOW_OUTSIDE_NAMESPACE_REASON (the reason is written to the audit log).`,
      );
    const reason = this.outside.reason ?? '';
    if (reason.length < MIN_REASON_LENGTH)
      return v('override-reason-missing', `SAS_ALLOW_OUTSIDE_NAMESPACE is on but SAS_ALLOW_OUTSIDE_NAMESPACE_REASON is ${reason === '' ? 'not set' : 'too short'} (at least ${MIN_REASON_LENGTH} characters).`, 'state why this run may change objects outside its namespace; the text is written to the audit log.');
    return { override: { name: 'outside-namespace', reason } };
  }

  authorize(op: Operation): void {
    this.audit.ensureWritable(); // fail closed: no privileged action without a working audit log
    const { violation, override } = this.evaluate(op);
    if (violation) {
      log.warn(`[sas-policy] DENIED ${op.driver}.${op.operation} (${op.kind}) in "${op.environment}": rule ${violation.rule}`);
      this.audit.append({ ...base(op), outcome: 'denied', reason: violation.rule });
      throw violation;
    }
    if (override) log.warn(`[sas-policy] OVERRIDE ${override.name}: ${op.driver}.${op.operation} (${op.kind}) on ${describeTarget(op)} in "${op.environment}" - reason: ${scrubText(override.reason)}`);
  }

  record(result: OperationResult): void {
    const { op } = result;
    const override = this.evaluate(op).override;
    this.audit.append({
      ...base(op),
      outcome: result.outcome,
      durationMs: result.durationMs,
      ...(override ? { override: override.name, reason: override.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }
}

function describeTarget(op: Operation): string {
  return op.target === undefined ? '(no target)' : typeof op.target === 'string' ? `"${op.target}"` : op.target.map((t) => `"${t}"`).join(', ');
}

function base(op: Operation) {
  return {
    driver: op.driver,
    environment: op.environment,
    operation: op.operation,
    kind: op.kind,
    ...(op.target === undefined ? {} : { target: typeof op.target === 'string' ? op.target : op.target.join(' | ') }),
    ...(op.host === undefined ? {} : { host: op.host }),
  };
}

/**
 * The way a driver uses a guard: authorize, run, record - the record is written whether the action returns or throws.
 * A PolicyViolation from `authorize` propagates untouched (it is already audited as `denied`).
 */
export async function guardedOperation<T>(guard: OperationGuard, op: Operation, action: () => Promise<T> | T, describe?: (result: T) => Record<string, unknown> | undefined): Promise<T> {
  guard.authorize(op);
  const startedAt = Date.now();
  let result: T;
  try {
    result = await action();
  } catch (error) {
    guard.record({ op, outcome: 'error', durationMs: Date.now() - startedAt, detail: { error: scrubText(error instanceof Error ? error.message : String(error)).slice(0, 300) } });
    throw error;
  }
  const detail = describe?.(result);
  guard.record({ op, outcome: 'ok', durationMs: Date.now() - startedAt, ...(detail ? { detail } : {}) });
  return result;
}
