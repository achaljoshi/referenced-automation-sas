import { AdapterError } from '@automation/referenced-automation-utils';

/**
 * The rules of the safety policy (see safetyPolicy.ts and docs/SECURITY.md). A test or a driver can match on `PolicyViolation.rule`
 * to tell a refusal (a decision) from a failure (a fault).
 */
export type PolicyRule =
  | 'unknown-environment'
  | 'invalid-operation'
  | 'host-not-allowed'
  | 'host-required'
  | 'prod-read-only'
  | 'prod-reads-disabled'
  | 'target-required'
  | 'invalid-target'
  | 'outside-namespace'
  | 'override-reason-missing';

/**
 * The safety policy refused an operation. Nothing was sent to SAS. The message names the rule and says how to proceed, so a person
 * reading a failed run knows whether to change the test, the configuration or nothing at all.
 */
export class PolicyViolation extends AdapterError {
  constructor(
    readonly rule: PolicyRule,
    driver: string,
    operation: string,
    what: string,
    howToProceed: string,
  ) {
    super(driver, operation, `REFUSED by safety policy rule "${rule}": ${what}\nHow to proceed: ${howToProceed}`);
    this.name = 'PolicyViolation';
    Object.setPrototypeOf(this, PolicyViolation.prototype);
  }
}

/** A setting is missing, malformed or contradictory. The message names the setting; it never contains a secret value. */
export class ConfigurationError extends AdapterError {
  constructor(operation: string, message: string) {
    super('sas-core', operation, message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}
