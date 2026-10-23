import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { CleanupFailed, findOrphans } from '../../src/core';
import { FixtureCleanup, surfaceCleanupFailures } from '../../src/fixtures';
import { makeRun, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

// The per-test registry: undone after the test (pass or fail), reported once whoever flushes first, and a failure fails the test.

const make = (dir: string) => new FixtureCleanup({ environment: 'simulator', driver: 'sas-desktop', run: makeRun(), stateDir: dir, testName: 'a test' });

test('flush() undoes everything once, newest first, and every caller sees the same report', async () => {
  const dir = tempDir();
  const cleanup = make(dir);
  const order: string[] = [];
  cleanup.register({ type: 'folder', name: 'AUTO_x_one', undo: () => void order.push('one') });
  cleanup.register({ type: 'folder', name: 'AUTO_x_two', undo: () => void order.push('two') });
  const [a, b] = await Promise.all([cleanup.flush(), cleanup.flush()]);
  expect(order).toEqual(['two', 'one']);
  expect(a).toBe(b);
  expect(await cleanup.flush()).toBe(a);
  expect(order).toHaveLength(2); // not undone a second time
  expect(findOrphans(0, { dir })).toEqual([]); // both are closed in the orphan record
});

test('a failed undo is reported and the object stays in the orphan record; the other undos still run', async () => {
  const dir = tempDir();
  const cleanup = make(dir);
  const ran: string[] = [];
  cleanup.register({ type: 'user', name: 'AUTO_x_user', undo: () => void ran.push('user') });
  cleanup.register({ type: 'group', name: 'AUTO_x_group', undo: () => { throw new Error('the group is in use'); } });
  const report = await cleanup.flush();
  expect(report.ok).toBe(false);
  expect(ran).toEqual(['user']);
  expect(report.failed.map((r) => `${r.type}:${r.status}`)).toEqual(['group:failed']);
  expect(findOrphans(0, { dir }).map((o) => o.name)).toEqual(['AUTO_x_group']);
});

test.describe('surfaceCleanupFailures', () => {
  const failedReport = { ok: false, results: [], failed: [{ type: 'group', name: 'AUTO_x_group', status: 'failed' as const, error: 'in use', durationMs: 3 }] };

  test('fail (the default) throws CleanupFailed naming the object and the run, and annotates the test', () => {
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    expect(() => surfaceCleanupFailures(failedReport, testInfo, 'fail', 'run123')).toThrow(CleanupFailed);
    expect(() => surfaceCleanupFailures(failedReport, testInfo, 'fail', 'run123')).toThrow(/AUTO_x_group[\s\S]*run123/);
    expect(testInfo.annotations[0]).toMatchObject({ type: 'sas-cleanup-failed', description: expect.stringContaining('AUTO_x_group') });
  });

  test('warn only annotates', () => {
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    expect(() => surfaceCleanupFailures(failedReport, testInfo, 'warn', 'run123')).not.toThrow();
    expect(testInfo.annotations).toHaveLength(1);
  });

  test('a clean report does nothing at all', () => {
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    surfaceCleanupFailures({ ok: true, results: [], failed: [] }, testInfo, 'fail', 'run123');
    expect(testInfo.annotations).toEqual([]);
  });
});

test('the registry writes its orphan record where the settings say (SAS_STATE_DIR), not in the repository', async () => {
  const dir = tempDir();
  const cleanup = make(path.join(dir, 'state'));
  cleanup.register({ type: 'folder', name: 'AUTO_x_f', undo: () => undefined });
  expect(fs.existsSync(path.join(dir, 'state', 'created-objects.jsonl'))).toBe(true);
  await cleanup.flush();
});
