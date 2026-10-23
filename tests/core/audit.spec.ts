import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { AuditLog, AuditUnavailable, Credentials, defaultAuditFile, readAudit, type AuditEntry } from '../../src/core';
import { config, makeRun, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  driver: 'sas-process',
  environment: 'dev',
  operation: 'export-package',
  kind: 'read',
  outcome: 'ok',
  ...over,
});

test.describe('the record', () => {
  test('has time, run id, correlation id, driver, environment, operation, kind, target, outcome and duration - one JSON object per line', () => {
    const dir = tempDir();
    const run = makeRun();
    const log = new AuditLog({ file: path.join(dir, 'a.jsonl'), run, env: config(), now: () => new Date('2026-10-23T10:00:00Z') });
    log.append(entry({ target: '/Shared Data/AUTO_x', durationMs: 42, host: 'h.example.com' }));
    log.append(entry({ outcome: 'denied', reason: 'outside-namespace' }));
    const lines = fs.readFileSync(log.file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: '2026-10-23T10:00:00.000Z',
      runId: run.runId,
      correlationId: run.correlationId,
      driver: 'sas-process',
      environment: 'dev',
      operation: 'export-package',
      kind: 'read',
      outcome: 'ok',
      target: '/Shared Data/AUTO_x',
      durationMs: 42,
      host: 'h.example.com',
    });
    expect(readAudit(log.file)).toHaveLength(2);
  });

  test('is written with mode 0600 (owner only)', () => {
    test.skip(process.platform === 'win32', 'POSIX file modes');
    const log = new AuditLog({ file: path.join(tempDir(), 'a.jsonl'), run: makeRun(), env: config() });
    log.append(entry());
    expect(fs.statSync(log.file).mode & 0o777).toBe(0o600);
  });
});

test.describe('no secrets', () => {
  test('values under secret-looking keys, credential text in strings, and a registered password are removed from the record', () => {
    const credentials = new Credentials({ application: 'smc', user: 'ajoshi', password: 'S3cr3t-Pa55word' });
    const log = new AuditLog({ file: path.join(tempDir(), 'a.jsonl'), run: makeRun(), env: config() });
    log.append(
      entry({
        operation: 'logon with password=hunter2hunter2',
        reason: `failed: bad password ${credentials.reveal()} for user`,
        target: 'https://admin:Sup3rPass@h.example.com/x',
        detail: { password: 'abc12345', nested: { apiKey: 'k-123456', note: `echo ${credentials.reveal()}` }, token: 'tok', exitCode: 1 },
      }),
    );
    const text = fs.readFileSync(log.file, 'utf8');
    for (const secret of ['S3cr3t-Pa55word', 'hunter2hunter2', 'Sup3rPass', 'abc12345', 'k-123456', '"tok"']) expect(text, secret).not.toContain(secret);
    const record = readAudit(log.file)[0];
    expect(record?.detail).toMatchObject({ password: '[REDACTED]', exitCode: 1 });
    expect(record?.reason).toBe('failed: bad password *** for user');
  });
});

test.describe('where it is written and rotation', () => {
  test('the default is test-results/sas-audit/audit-<runId>.jsonl; SAS_AUDIT_FILE overrides it', () => {
    const run = makeRun();
    expect(path.relative(process.cwd(), defaultAuditFile(run, config()))).toBe(path.join('test-results', 'sas-audit', `audit-${run.runId}.jsonl`));
    const fixed = path.join(tempDir(), 'x', 'audit.jsonl');
    expect(defaultAuditFile(run, config({ SAS_AUDIT_FILE: fixed }))).toBe(fixed);
    const log = new AuditLog({ run, env: config({ SAS_AUDIT_FILE: fixed }) });
    log.append(entry());
    expect(fs.existsSync(fixed)).toBe(true);
  });

  test('old runs\' files are rotated away in the default folder (the newest N are kept, the current one always); a fixed file is never rotated', () => {
    const cwd = process.cwd();
    const work = tempDir();
    process.chdir(work);
    try {
      const folder = path.join(work, 'test-results', 'sas-audit');
      fs.mkdirSync(folder, { recursive: true });
      for (let i = 0; i < 5; i++) {
        const file = path.join(folder, `audit-old${i}.jsonl`);
        fs.writeFileSync(file, '');
        const t = new Date(Date.now() - (10 - i) * 3_600_000);
        fs.utimesSync(file, t, t);
      }
      fs.writeFileSync(path.join(folder, 'notes.txt'), 'not an audit file');
      const run = makeRun();
      const log = new AuditLog({ run, env: config(), keepRuns: 3 });
      log.append(entry());
      const left = fs.readdirSync(folder).sort();
      expect(left).toEqual(['audit-old3.jsonl', 'audit-old4.jsonl', `audit-${run.runId}.jsonl`, 'notes.txt'].sort());

      const fixedDir = tempDir();
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(fixedDir, `audit-old${i}.jsonl`), '');
      new AuditLog({ file: path.join(fixedDir, 'mine.jsonl'), run, env: config(), keepRuns: 1 }).append(entry());
      expect(fs.readdirSync(fixedDir)).toHaveLength(6);
    } finally {
      process.chdir(cwd);
    }
  });

  test('SAS_AUDIT_KEEP_RUNS must be 1 or more', () => {
    expect(() => new AuditLog({ run: makeRun(), env: config({ SAS_AUDIT_KEEP_RUNS: '0' }) })).toThrow(/SAS_AUDIT_KEEP_RUNS/);
  });
});

test.describe('failure and reading', () => {
  test('an audit log that cannot be written is AuditUnavailable, with the file and how to fix it', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    const log = new AuditLog({ file: path.join(dir, 'blocker', 'a.jsonl'), run: makeRun(), env: config() });
    const error = (() => {
      try {
        log.append(entry());
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(AuditUnavailable);
    expect(error?.message).toContain('No privileged action runs without an audit record');
    expect(error?.message).toContain('SAS_AUDIT_FILE');
  });

  test('readAudit filters, returns [] for a missing file, and names the line of a damaged record', () => {
    const dir = tempDir();
    const log = new AuditLog({ file: path.join(dir, 'a.jsonl'), run: makeRun(), env: config() });
    log.append(entry());
    log.append(entry({ outcome: 'denied', driver: 'sas-com', kind: 'create' }));
    expect(readAudit(log.file, { outcome: 'denied' })).toHaveLength(1);
    expect(readAudit(log.file, { driver: 'sas-process', kind: 'read' })).toHaveLength(1);
    expect(readAudit(log.file, { runId: 'other' })).toHaveLength(0);
    expect(readAudit(path.join(dir, 'missing.jsonl'))).toEqual([]);
    fs.appendFileSync(log.file, '{ broken\n');
    expect(() => readAudit(log.file)).toThrow(/a\.jsonl line 3 is not valid JSON/);
  });
});
