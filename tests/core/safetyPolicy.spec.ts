import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { AuditLog, PolicyViolation, guardedOperation, readAudit, type Operation } from '../../src/core';
import { RUN_ID, config, makePolicy, makeRun, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

const run = makeRun();
const ns = (name: string) => run.ns(name);
const HOST = 'sasmeta.dev.example.com';

const op = (over: Partial<Operation> = {}): Operation => ({
  driver: 'sas-process',
  operation: 'delete-group',
  kind: 'destructive',
  target: ns('Users'),
  environment: 'dev',
  host: HOST,
  ...over,
});

function refusal(fn: () => void): PolicyViolation {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyViolation);
    return error as PolicyViolation;
  }
  throw new Error('expected the policy to refuse');
}

test.describe('environment and host', () => {
  test('an unknown environment is refused, for a read as well', () => {
    const policy = makePolicy(tempDir());
    for (const kind of ['read', 'create'] as const) {
      const error = refusal(() => policy.authorize(op({ kind, environment: 'stage' })));
      expect(error.rule).toBe('unknown-environment');
      expect(error.message).toContain('How to proceed');
    }
  });

  test('a host that is not on the environment allow-list is refused - even for a read, even inside the namespace', () => {
    const policy = makePolicy(tempDir());
    expect(refusal(() => policy.authorize(op({ kind: 'read', host: 'sasmeta.example.com' }))).rule).toBe('host-not-allowed');
    expect(refusal(() => policy.authorize(op({ host: 'sasmeta.qa.example.com' }))).rule).toBe('host-not-allowed'); // qa's host, dev run
    expect(refusal(() => policy.authorize(op({ host: 'https://sasmeta.dev.example.com@evil.example.net/' }))).rule).toBe('host-not-allowed');
  });

  test('a mutating action must name a host or say it is local; a local one is allowed', () => {
    const policy = makePolicy(tempDir());
    expect(refusal(() => policy.authorize(op({ host: undefined }))).rule).toBe('host-required');
    expect(() => policy.authorize(op({ host: undefined, local: true }))).not.toThrow();
    expect(() => policy.authorize(op({ kind: 'read', host: undefined }))).not.toThrow(); // a nonprod read without host is fine
  });

  test('an invalid kind is refused', () => {
    expect(refusal(() => makePolicy(tempDir()).authorize(op({ kind: 'wipe' as never }))).rule).toBe('invalid-operation');
  });
});

test.describe('production is read-only', () => {
  const prod = (over: Partial<Operation> = {}) => op({ environment: 'prod', host: 'sasmeta.example.com', ...over });

  test('every mutating kind is refused in prod, with or without the override settings, inside the namespace or not', () => {
    const policy = makePolicy(tempDir(), { SAS_ALLOW_PROD_READS: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: 'a long enough reason' });
    for (const kind of ['create', 'update', 'destructive'] as const) {
      for (const target of [ns('Users'), '/Shared Data/Real']) {
        const error = refusal(() => policy.authorize(prod({ kind, target })));
        expect(error.rule, `${kind} ${target}`).toBe('prod-read-only');
        expect(error.message).toContain('never allowed there');
      }
    }
  });

  test('reads in prod are off unless SAS_ALLOW_PROD_READS=true, and need a host on the allow-list', () => {
    const off = makePolicy(tempDir());
    const error = refusal(() => off.authorize(prod({ kind: 'read' })));
    expect(error.rule).toBe('prod-reads-disabled');
    expect(error.message).toContain('SAS_ALLOW_PROD_READS=true');

    const on = makePolicy(tempDir(), { SAS_ALLOW_PROD_READS: 'true' });
    expect(() => on.authorize(prod({ kind: 'read' }))).not.toThrow();
    expect(refusal(() => on.authorize(prod({ kind: 'read', host: undefined }))).rule).toBe('host-required');
    expect(refusal(() => on.authorize(prod({ kind: 'read', host: 'sasmeta.dev.example.com' }))).rule).toBe('host-not-allowed');
  });

  test('SAS_ALLOW_PROD_READS is read as a strict boolean', () => {
    expect(() => makePolicy(tempDir(), { SAS_ALLOW_PROD_READS: 'ture' })).toThrow(/not a valid boolean/);
  });
});

test.describe('the test namespace on nonprod', () => {
  test('reads are allowed anywhere on nonprod', () => {
    expect(() => makePolicy(tempDir()).authorize(op({ kind: 'read', target: '/Shared Data/Anything' }))).not.toThrow();
  });

  test('create, update and destructive are allowed inside the run namespace (a name, or a path with the namespace folder in it)', () => {
    const policy = makePolicy(tempDir());
    for (const kind of ['create', 'update', 'destructive'] as const) {
      expect(() => policy.authorize(op({ kind, target: ns('Users') })), kind).not.toThrow();
      expect(() => policy.authorize(op({ kind, target: `/Shared Data/${ns('Users')}/Group 1` })), kind).not.toThrow();
      expect(() => policy.authorize(op({ kind, target: `\\Shared Data\\${run.ns()}` })), kind).not.toThrow();
    }
  });

  test('outside the namespace is refused, and the message says which rule and how to proceed', () => {
    const error = refusal(() => makePolicy(tempDir()).authorize(op({ target: '/Shared Data/Finance/Users' })));
    expect(error.rule).toBe('outside-namespace');
    expect(error.message).toContain(`outside this run's test namespace "AUTO_${RUN_ID}"`);
    expect(error.message).toContain('run.ns(...)');
    expect(error.message).toContain('SAS_ALLOW_OUTSIDE_NAMESPACE=true together with SAS_ALLOW_OUTSIDE_NAMESPACE_REASON');
  });

  test('another run\'s namespace, a similar prefix and a different case-less boundary are outside', () => {
    const policy = makePolicy(tempDir());
    for (const target of ['AUTO_261023120000abce_Users', `AUTO_${RUN_ID}x_Users`, `AUTO_${RUN_ID.slice(0, -1)}`, 'auto', `XAUTO_${RUN_ID}_Users`])
      expect(refusal(() => policy.authorize(op({ target }))).rule, target).toBe('outside-namespace');
  });

  test('the namespace comparison ignores case', () => {
    expect(() => makePolicy(tempDir()).authorize(op({ target: `auto_${RUN_ID.toUpperCase()}_users` }))).not.toThrow();
  });

  test('a mutating action without a target is refused (the namespace cannot be checked)', () => {
    for (const target of [undefined, '', '  ', [] as string[]])
      expect(refusal(() => makePolicy(tempDir()).authorize(op({ target }))).rule).toBe('target-required');
  });

  test('every target of a list must be inside', () => {
    const policy = makePolicy(tempDir());
    expect(() => policy.authorize(op({ target: [ns('A'), ns('B')] }))).not.toThrow();
    expect(refusal(() => policy.authorize(op({ target: [ns('A'), '/Shared Data/Real'] }))).rule).toBe('outside-namespace');
  });

  test('a path that climbs out with .. is refused even when it starts inside the namespace', () => {
    const policy = makePolicy(tempDir());
    expect(refusal(() => policy.authorize(op({ target: `/${ns('Users')}/../Finance` }))).rule).toBe('invalid-target');
    expect(refusal(() => policy.authorize(op({ target: `${ns('Users')}\\..\\Finance` }))).rule).toBe('invalid-target');
    expect(refusal(() => policy.authorize(op({ target: `${ns('Users')}\u0000/x` }))).rule).toBe('invalid-target');
  });

  test('a wildcard is refused for a destructive action only', () => {
    const policy = makePolicy(tempDir());
    expect(refusal(() => policy.authorize(op({ target: `${ns('Users')}*` }))).rule).toBe('invalid-target');
    expect(() => policy.authorize(op({ kind: 'create', target: `${ns('Users')}*` }))).not.toThrow();
  });

  test('SAS_NAMESPACE_PATTERN changes the prefix', () => {
    const policy = makePolicy(tempDir(), { SAS_NAMESPACE_PATTERN: 'TST_{runId}' });
    expect(() => policy.authorize(op({ target: `TST_${RUN_ID}_Users` }))).not.toThrow();
    expect(refusal(() => policy.authorize(op({ target: ns('Users') }))).rule).toBe('outside-namespace');
  });
});

test.describe('the outside-namespace override', () => {
  const outside = op({ target: '/Shared Data/Finance/Users' });
  const reason = 'cleaning up objects left by ticket SAS-123';

  test('needs the reason: on without a reason (or a tiny one) is refused', () => {
    expect(refusal(() => makePolicy(tempDir(), { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true' }).authorize(outside)).rule).toBe('override-reason-missing');
    expect(refusal(() => makePolicy(tempDir(), { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: 'because' }).authorize(outside)).rule).toBe('override-reason-missing');
  });

  test('a reason alone (without SAS_ALLOW_OUTSIDE_NAMESPACE=true) changes nothing', () => {
    expect(refusal(() => makePolicy(tempDir(), { SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: reason }).authorize(outside)).rule).toBe('outside-namespace');
  });

  test('allows it, and the audit record carries the override name and the reason', () => {
    const dir = tempDir();
    const policy = makePolicy(dir, { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: reason });
    expect(() => policy.authorize(outside)).not.toThrow();
    policy.record({ op: outside, outcome: 'ok', durationMs: 5 });
    const [record] = readAudit(path.join(dir, 'audit.jsonl'));
    expect(record).toMatchObject({ outcome: 'ok', override: 'outside-namespace', reason, target: '/Shared Data/Finance/Users', kind: 'destructive' });
  });

  test('does not lift anything else: not production, not the host list, not "..", not a missing target', () => {
    const policy = makePolicy(tempDir(), { SAS_ALLOW_OUTSIDE_NAMESPACE: 'true', SAS_ALLOW_OUTSIDE_NAMESPACE_REASON: reason, SAS_ALLOW_PROD_READS: 'true' });
    expect(refusal(() => policy.authorize({ ...outside, environment: 'prod', host: 'sasmeta.example.com' })).rule).toBe('prod-read-only');
    expect(refusal(() => policy.authorize({ ...outside, host: 'evil.example.net' })).rule).toBe('host-not-allowed');
    expect(refusal(() => policy.authorize({ ...outside, target: '/Shared Data/../x' })).rule).toBe('invalid-target');
    expect(refusal(() => policy.authorize({ ...outside, target: undefined })).rule).toBe('target-required');
  });
});

test.describe('the audit trail of decisions', () => {
  test('a refusal writes a denied record naming the rule; the call that was allowed writes nothing until record()', () => {
    const dir = tempDir();
    const file = path.join(dir, 'audit.jsonl');
    const policy = makePolicy(dir);
    refusal(() => policy.authorize(op({ target: '/Shared Data/Real' })));
    expect(readAudit(file)).toHaveLength(1);
    expect(readAudit(file)[0]).toMatchObject({ outcome: 'denied', reason: 'outside-namespace', driver: 'sas-process', environment: 'dev', operation: 'delete-group', kind: 'destructive', target: '/Shared Data/Real', host: HOST });
    policy.authorize(op());
    expect(readAudit(file)).toHaveLength(1);
  });

  test('an unwritable audit log stops the action before it starts (fail closed)', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'blocker'), 'a file where a folder is needed');
    const run = makeRun();
    const audit = new AuditLog({ file: path.join(dir, 'blocker', 'audit.jsonl'), run, env: config() });
    const policy = makePolicy(dir, {}, { audit });
    expect(() => policy.authorize(op())).toThrow(/cannot be written.*No privileged action runs without an audit record/s);
    expect(() => policy.authorize(op({ target: '/x' }))).toThrow(/cannot be written/); // even a refusal needs the audit log first
  });

  test('guardedOperation: authorize, run, record ok with a duration; record error and rethrow on failure; nothing runs when refused', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'audit.jsonl');
    const policy = makePolicy(dir);
    let ran = 0;
    expect(await guardedOperation(policy, op(), () => (ran++, 'done'), (r) => ({ r }))).toBe('done');
    await expect(guardedOperation(policy, op({ kind: 'update' }), () => { ran++; throw new Error('tool failed password=hunter2hunter2'); })).rejects.toThrow('tool failed');
    await expect(guardedOperation(policy, op({ target: '/x/y' }), () => { ran++; })).rejects.toBeInstanceOf(PolicyViolation);
    expect(ran).toBe(2);
    const records = readAudit(file);
    expect(records.map((r) => r.outcome)).toEqual(['ok', 'error', 'denied']);
    expect(records[0]?.detail).toEqual({ r: 'done' });
    expect(typeof records[0]?.durationMs).toBe('number');
    expect(JSON.stringify(records[1])).not.toContain('hunter2');
  });
});
