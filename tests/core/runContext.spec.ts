import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { getCorrelationId, withCorrelationId } from '@automation/referenced-automation-utils';
import { RunContext, generateRunId, getRunContext, initRunContext, namespacePrefix, resetRunContext, runIdTime, targetInNamespace } from '../../src/core';
import { config, makeRun, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

test.describe('the run id', () => {
  test('is a UTC time stamp plus 4 random hex digits, alphanumeric only, and the time can be read back', () => {
    const id = generateRunId(new Date(Date.UTC(2026, 9, 23, 21, 45, 1)), Buffer.from([0xa3, 0xf9]));
    expect(id).toBe('261023214501a3f9');
    expect(runIdTime(id)?.toISOString()).toBe('2026-10-23T21:45:01.000Z');
    expect(generateRunId()).toMatch(/^\d{12}[0-9a-f]{4}$/);
    expect(generateRunId()).not.toBe(generateRunId());
    expect(runIdTime('pipeline123')).toBeUndefined();
  });

  test('SAS_RUN_ID is honoured; an id with "_" or "-" or spaces is refused (the namespace boundary depends on it)', () => {
    expect(new RunContext({ env: config({ SAS_RUN_ID: 'ci4711' }) }).runId).toBe('ci4711');
    for (const bad of ['a_b', 'a-b', 'a b', 'ab', '', 'x'.repeat(25), '../x']) expect(() => new RunContext({ env: config({ SAS_RUN_ID: bad }) }), bad).toThrow(/SAS_RUN_ID/);
  });

  test('initRunContext exports SAS_RUN_ID so workers started afterwards share it, and getRunContext returns the same one', () => {
    resetRunContext();
    const first = initRunContext({ env: config() });
    expect(process.env.SAS_RUN_ID).toBe(first.runId);
    expect(getRunContext()).toBe(first);
    resetRunContext();
    expect(new RunContext({ env: config({ SAS_RUN_ID: process.env.SAS_RUN_ID as string }) }).runId).toBe(first.runId);
    resetRunContext();
  });
});

test.describe('the test namespace', () => {
  test('ns("Users") is AUTO_<runId>_Users; ns() is the prefix', () => {
    const run = makeRun();
    expect(run.ns('Users')).toBe('AUTO_261023120000abcd_Users');
    expect(run.ns()).toBe('AUTO_261023120000abcd');
    expect(run.namespacePrefix).toBe('AUTO_261023120000abcd');
  });

  test('a name with separators, "..", or a bad first character is refused', () => {
    const run = makeRun();
    for (const bad of ['a/b', 'a\\b', '..', 'a..b', '_x', ' x', 'a;b', 'a*']) expect(() => run.ns(bad), bad).toThrow(/ns\(/);
    expect(run.ns('Group 1.a-b_c')).toContain('Group 1.a-b_c');
  });

  test('SAS_NAMESPACE_PATTERN: needs {runId} once and a literal start of 3+ characters', () => {
    expect(makeRun({ SAS_NAMESPACE_PATTERN: 'TST_{runId}' }).ns('X')).toBe('TST_261023120000abcd_X');
    for (const bad of ['{runId}', 'A_{runId}', 'AUTO_', 'AUTO_{runId}{runId}', 'AUTO/{runId}', 'AUTO_{runId}*'])
      expect(() => makeRun({ SAS_NAMESPACE_PATTERN: bad }), bad).toThrow(/SAS_NAMESPACE_PATTERN/);
    expect(namespacePrefix('r1', 'AUTO_{runId}')).toBe('AUTO_r1');
  });

  test('targetInNamespace: any path segment, boundary at "_" or the end, case-insensitive, never with ".." or empty', () => {
    const p = 'AUTO_r1';
    expect(targetInNamespace('AUTO_r1_Users', p)).toBe(true);
    expect(targetInNamespace('AUTO_r1', p)).toBe(true);
    expect(targetInNamespace('/Shared Data/AUTO_r1_Users/Group', p)).toBe(true);
    expect(targetInNamespace('auto_R1_x', p)).toBe(true);
    expect(targetInNamespace('AUTO_r12_Users', p)).toBe(false);
    expect(targetInNamespace('AUTO_r1x', p)).toBe(false);
    expect(targetInNamespace('/Shared Data/Users', p)).toBe(false);
    expect(targetInNamespace('xAUTO_r1_Users', p)).toBe(false);
    expect(targetInNamespace('/AUTO_r1_Users/../Other', p)).toBe(false);
    expect(targetInNamespace('', p)).toBe(false);
    expect(targetInNamespace('///', p)).toBe(false);
  });
});

test.describe('the correlation id', () => {
  test('inside a test it is the active one from the shared logger; outside it is the run\'s own', async () => {
    const run = makeRun();
    expect(getCorrelationId()).toBeUndefined();
    expect(run.correlationId).toBe(run.runCorrelationId);
    await withCorrelationId('11111111-1111-4111-8111-111111111111', () => {
      expect(run.correlationId).toBe('11111111-1111-4111-8111-111111111111');
    });
    expect(run.correlationId).toBe(run.runCorrelationId);
  });
});

test.describe('evidence', () => {
  test('SAS_EVIDENCE: failure (default) captures only for a failed test; on always; off never; anything else is an error', () => {
    expect(makeRun().evidenceMode).toBe('failure');
    expect(makeRun().shouldCaptureEvidence(true)).toBe(true);
    expect(makeRun().shouldCaptureEvidence(false)).toBe(false);
    expect(makeRun({ SAS_EVIDENCE: 'on' }).shouldCaptureEvidence(false)).toBe(true);
    expect(makeRun({ SAS_EVIDENCE: 'off' }).shouldCaptureEvidence(true)).toBe(false);
    expect(() => makeRun({ SAS_EVIDENCE: 'sometimes' }).evidenceMode).toThrow(/must be off, failure or on/);
  });

  test('the evidence folder is <SAS_EVIDENCE_DIR>/<runId>, and a label can never climb out of it', () => {
    const root = tempDir();
    const run = makeRun({ SAS_EVIDENCE_DIR: root });
    expect(run.evidenceDir).toBe(path.join(root, run.runId));
    for (const label of ['../../etc/passwd', '..\\..\\x', '/abs/path', 'a/b c*d', '....']) {
      const file = run.evidencePath(label, 'png', new Date(0));
      expect(path.dirname(file), label).toBe(run.evidenceDir);
      expect(path.basename(file), label).toMatch(/^19700101T000000000Z-[A-Za-z0-9._-]+\.png$/);
    }
    expect(fs.existsSync(run.evidenceDir)).toBe(true);
    expect(() => run.evidencePath('x', '../png')).toThrow(/extension/);
    expect(() => run.evidencePath('x', 'toolongext')).toThrow(/extension/);
  });

  test('old runs\' evidence is pruned after SAS_EVIDENCE_RETENTION_DAYS; the current run and foreign folders are never touched; 0 keeps everything', () => {
    const root = tempDir();
    const run = makeRun({ SAS_EVIDENCE_DIR: root, SAS_EVIDENCE_RETENTION_DAYS: '2' });
    const make = (name: string, ageDays: number) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      const t = new Date(Date.now() - ageDays * 86_400_000);
      fs.utimesSync(dir, t, t);
      return dir;
    };
    const oldRun = make('260101000000aaaa', 5);
    const recent = make('261022000000bbbb', 1);
    const current = make(run.runId, 9);
    const foreign = make('not a run id', 9);
    const removed = run.pruneEvidence();
    expect(removed).toEqual([oldRun]);
    expect(fs.existsSync(oldRun)).toBe(false);
    for (const kept of [recent, current, foreign]) expect(fs.existsSync(kept), kept).toBe(true);

    const keep = makeRun({ SAS_EVIDENCE_DIR: root, SAS_EVIDENCE_RETENTION_DAYS: '0' });
    make('250101000000cccc', 400);
    expect(keep.pruneEvidence()).toEqual([]);
    expect(() => makeRun({ SAS_EVIDENCE_RETENTION_DAYS: '-1' }).evidenceRetentionDays).toThrow(/SAS_EVIDENCE_RETENTION_DAYS/);
  });
});
