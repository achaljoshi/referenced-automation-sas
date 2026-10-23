import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  CREATED_OBJECTS_FILE,
  CleanupFailed,
  CleanupRegistry,
  createdObjectsPath,
  findOrphans,
  orphansByRun,
  readCreatedEvents,
  recordClosed,
  recordCreated,
} from '../../src/core';
import { RUN_ID, config, makeRun, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

const registry = (dir: string, over: Partial<ConstructorParameters<typeof CleanupRegistry>[0]> = {}) =>
  new CleanupRegistry({ environment: 'dev', driver: 'sas-process', run: makeRun(), env: config(), stateDir: dir, timeoutMs: 200, graceMs: 100, testName: 'a test', ...over });

test.describe('running the clean-up', () => {
  test('undoes newest first, one at a time', async () => {
    const dir = tempDir();
    const reg = registry(dir);
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    for (const name of ['first', 'second', 'third']) {
      reg.register({
        type: 'group',
        name,
        undo: async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 15));
          order.push(name);
          running--;
        },
      });
    }
    const report = await reg.run();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(maxRunning).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual(['removed', 'removed', 'removed']);
    expect(reg.pending).toEqual([]);
  });

  test('a failing undo does not stop the others and is REPORTED, not swallowed (runAndThrow throws, listing each)', async () => {
    const reg = registry(tempDir());
    const done: string[] = [];
    reg.register({ type: 'folder', name: 'AUTO_x_folder', undo: () => void done.push('folder') });
    reg.register({ type: 'group', name: 'AUTO_x_group', undo: () => { throw new Error('delete refused: object in use password=hunter2hunter2'); } });
    reg.register({ type: 'library', name: 'AUTO_x_lib', undo: () => void done.push('library') });
    const error = (await reg.runAndThrow().catch((e: unknown) => e)) as CleanupFailed;
    expect(done).toEqual(['library', 'folder']);
    expect(error).toBeInstanceOf(CleanupFailed);
    expect(error.report.failed).toHaveLength(1);
    expect(error.message).toContain('1 object(s) could not be removed');
    expect(error.message).toContain('group "AUTO_x_group": failed - delete refused: object in use');
    expect(error.message).not.toContain('hunter2');
    expect(error.message).toContain(RUN_ID);
  });

  test('runs even when the test failed - the registry does not look at the test result; calling run twice does not repeat undone work', async () => {
    const reg = registry(tempDir());
    let calls = 0;
    reg.register({ type: 'folder', name: 'AUTO_x', undo: () => void calls++ });
    await Promise.all([reg.run(), reg.run()]);
    await reg.run();
    expect(calls).toBe(1);
  });

  test('an undo that runs out of time is asked to stop (abort signal); the rest continue when it stops', async () => {
    const reg = registry(tempDir());
    let aborted = false;
    const done: string[] = [];
    reg.register({ type: 'folder', name: 'AUTO_x_ok', undo: () => void done.push('ok') });
    reg.register({
      type: 'group',
      name: 'AUTO_x_slow',
      undo: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    });
    const report = await reg.run();
    expect(aborted).toBe(true);
    expect(report.results.map((r) => `${r.name}:${r.status}`)).toEqual(['AUTO_x_slow:timeout', 'AUTO_x_ok:removed']);
    expect(report.failed[0]?.error).toContain('ran out of time after 200 ms');
    expect(report.failed[0]?.error).not.toContain('did not stop');
  });

  test('an undo that ignores the abort is waited for only for the grace time; the remaining ones are NOT started (two undos in one desktop would corrupt each other) and are marked not-attempted', async () => {
    const reg = registry(tempDir());
    const started: string[] = [];
    reg.register({ type: 'folder', name: 'AUTO_x_never', undo: () => void started.push('never') });
    reg.register({ type: 'group', name: 'AUTO_x_stuck', undo: () => new Promise<void>(() => undefined) });
    const began = Date.now();
    const report = await reg.run();
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(started).toEqual([]);
    expect(report.results.map((r) => `${r.name}:${r.status}`)).toEqual(['AUTO_x_stuck:timeout', 'AUTO_x_never:not-attempted']);
    expect(report.failed[0]?.error).toContain('did not stop when asked');
    expect(report.failed[1]?.error).toContain('still running in SAS');
  });

  test('SAS_CLEANUP_TIMEOUT_MS and SAS_CLEANUP_GRACE_MS set the limits; nonsense is refused', async () => {
    const reg = new CleanupRegistry({ environment: 'dev', run: makeRun(), env: config({ SAS_CLEANUP_TIMEOUT_MS: '60', SAS_CLEANUP_GRACE_MS: '10' }), stateDir: false });
    reg.register({ type: 'x', name: 'AUTO_x', undo: () => new Promise<void>(() => undefined) });
    const began = Date.now();
    await reg.run();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(() => new CleanupRegistry({ environment: 'dev', env: config({ SAS_CLEANUP_TIMEOUT_MS: '0' }), stateDir: false })).toThrow(/SAS_CLEANUP_TIMEOUT_MS/);
  });
});

test.describe('the orphan record (.sas-state/created-objects.jsonl)', () => {
  test('a registration writes a created line at once - a crash before the clean-up still leaves a trail', () => {
    const dir = tempDir();
    registry(dir).register({ type: 'group', name: 'AUTO_x_Users', id: 'A5ABC.123', undo: () => undefined });
    const [event] = readCreatedEvents(dir);
    expect(event).toMatchObject({ event: 'created', runId: RUN_ID, environment: 'dev', driver: 'sas-process', type: 'group', name: 'AUTO_x_Users', id: 'A5ABC.123', test: 'a test' });
    expect(Date.parse(event?.at ?? '')).not.toBeNaN();
    expect(createdObjectsPath(dir).endsWith(CREATED_OBJECTS_FILE)).toBe(true);
  });

  test('a removal closes it; a failed or unfinished one stays an orphan', async () => {
    const dir = tempDir();
    const reg = registry(dir);
    reg.register({ type: 'folder', name: 'AUTO_ok', undo: () => undefined });
    reg.register({ type: 'group', name: 'AUTO_bad', undo: () => { throw new Error('no'); } });
    await reg.run();
    expect(findOrphans(0, { dir }).map((o) => o.name)).toEqual(['AUTO_bad']);
    expect(readCreatedEvents(dir).map((e) => `${e.event}:${e.name}`)).toEqual(['created:AUTO_ok', 'created:AUTO_bad', 'removed:AUTO_ok']);
  });

  test('findOrphans: older than the limit only, oldest first, with their age; the sweeper closes one with recordClosed', () => {
    const dir = tempDir();
    const now = Date.parse('2026-10-23T12:00:00Z');
    const id = (name: string, runId = RUN_ID) => ({ runId, environment: 'dev', driver: 'd', type: 'group', name });
    recordCreated(id('AUTO_new'), dir, now - 5 * 60_000);
    recordCreated(id('AUTO_old2', 'r2'), dir, now - 3 * 3_600_000);
    recordCreated(id('AUTO_old1'), dir, now - 5 * 3_600_000);
    recordCreated(id('AUTO_gone'), dir, now - 6 * 3_600_000);
    recordClosed(id('AUTO_gone'), 'removed', dir, now - 5 * 3_600_000);
    recordCreated(id('AUTO_kept'), dir, now - 6 * 3_600_000);
    recordClosed(id('AUTO_kept'), 'kept', dir, now - 5 * 3_600_000);
    const orphans = findOrphans(3_600_000, { dir, now });
    expect(orphans.map((o) => o.name)).toEqual(['AUTO_old1', 'AUTO_old2']);
    expect(orphans[0]?.ageMs).toBe(5 * 3_600_000);
    expect([...orphansByRun(orphans).keys()].sort()).toEqual([RUN_ID, 'r2'].sort());
    recordClosed(orphans[0] as never, 'removed', dir, now);
    expect(findOrphans(3_600_000, { dir, now }).map((o) => o.name)).toEqual(['AUTO_old2']);
    expect(findOrphans(0, { dir, now }).map((o) => o.name)).toEqual(['AUTO_old2', 'AUTO_new']);
  });

  test('the same name in another run, environment or type is a different object', () => {
    const dir = tempDir();
    const base = { driver: 'd', type: 'group', name: 'AUTO_same' };
    recordCreated({ ...base, runId: 'r1', environment: 'dev' }, dir);
    recordCreated({ ...base, runId: 'r2', environment: 'dev' }, dir);
    recordCreated({ ...base, runId: 'r1', environment: 'qa' }, dir);
    recordClosed({ ...base, runId: 'r1', environment: 'dev' }, 'removed', dir);
    expect(findOrphans(0, { dir }).map((o) => `${o.runId}/${o.environment}`).sort()).toEqual(['r1/qa', 'r2/dev']);
  });

  test('no file means no orphans; a damaged line is an error naming it (skipping it would hide an orphan)', () => {
    const dir = tempDir();
    expect(findOrphans(0, { dir })).toEqual([]);
    registry(dir).register({ type: 'x', name: 'AUTO_x', undo: () => undefined });
    fs.appendFileSync(createdObjectsPath(dir), '{ torn\n');
    expect(() => findOrphans(0, { dir })).toThrow(/created-objects\.jsonl line 2 is not valid JSON.*damaged/);
  });

  test('names are scrubbed of credential-looking text; the file is owner-only; the folder default is .sas-state', () => {
    const dir = tempDir();
    recordCreated({ runId: 'r1', environment: 'dev', driver: 'd', type: 'library', name: 'AUTO_lib password=hunter2hunter2' }, dir);
    expect(fs.readFileSync(createdObjectsPath(dir), 'utf8')).not.toContain('hunter2');
    if (process.platform !== 'win32') expect(fs.statSync(createdObjectsPath(dir)).mode & 0o777).toBe(0o600);
    expect(createdObjectsPath().endsWith('.sas-state/created-objects.jsonl') || createdObjectsPath().endsWith('.sas-state\\created-objects.jsonl')).toBe(true);
  });

  test('stateDir: false writes no record (ordering tests only)', async () => {
    const reg = registry(tempDir(), { stateDir: false });
    reg.register({ type: 'x', name: 'AUTO_x', undo: () => undefined });
    expect((await reg.run()).ok).toBe(true);
  });
});
