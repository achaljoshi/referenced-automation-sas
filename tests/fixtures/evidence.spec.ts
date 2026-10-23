import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { clearRegisteredSecrets, registerSecret } from '../../src/core';
import { DesktopSession, DesktopTransportError, FAKE_SMC_PATH, SasManagementConsole, startFakeDesktop, type DesktopCommand, type DesktopTransport, type JournalEntry } from '../../src/desktop';
import { TestEvidence, journalText, testFailed, type EvidenceTestInfo } from '../../src/fixtures';
import { settingsFor, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

// What the report gets about the desktop, decided by SAS_EVIDENCE. Screenshots are the bridge's job to mask; the journal is masked here.

function rig(evidence: string, status: string, expectedStatus = 'passed') {
  const dir = tempDir();
  const settings = settingsFor({ SAS_EVIDENCE: evidence, SAS_EVIDENCE_DIR: dir });
  const fake = startFakeDesktop();
  const session = fake.session({ evidenceDir: settings.run.evidenceDir, timeoutMs: 400 });
  const attached: Array<{ name: string; body?: string; path?: string }> = [];
  const testInfo: EvidenceTestInfo = { title: 'logs on and looks', status, expectedStatus, attach: async (name, options) => void attached.push({ name, ...options }) };
  return { dir, settings, fake, session, attached, testInfo, evidence: new TestEvidence({ session, run: settings.run, testInfo, startedAt: 0 }) };
}

test.describe('SAS_EVIDENCE decides what a test leaves behind', () => {
  test('failure (the default): a failed test gets a screenshot under its run folder and the step journal; a passed one gets nothing', async () => {
    const failed = rig('failure', 'failed');
    const smc = await SasManagementConsole.launch(failed.session, { path: FAKE_SMC_PATH });
    await expect(smc.mainWindow.getByName('Nothing Like This').click()).rejects.toThrow(/no control matched/); // a step that fails ends up in the journal
    const files = await failed.evidence.capture();
    expect(files).toHaveLength(1);
    expect(files[0]?.startsWith(failed.settings.run.evidenceDir)).toBe(true);
    expect(files[0]).toContain('FAILED');
    expect(fs.readFileSync(files[0] as string).subarray(1, 4).toString()).toBe('PNG');
    expect(failed.attached.map((a) => a.name)).toContain('desktop-steps');
    expect(failed.attached.find((a) => a.name === 'desktop-steps')?.body).toContain('FAILED');

    const passed = rig('failure', 'passed');
    expect(await passed.evidence.capture()).toEqual([]);
    expect(passed.attached).toEqual([]);
    expect(fs.existsSync(passed.settings.run.evidenceDir)).toBe(false);
  });

  test('on: a passed test gets a screenshot too, but no failure journal', async () => {
    const r = rig('on', 'passed');
    expect(await r.evidence.capture()).toHaveLength(1);
    expect(r.attached.find((a) => a.name === 'desktop-steps')).toBeUndefined();
  });

  test('off: nothing automatic, even for a failed test', async () => {
    const r = rig('off', 'failed');
    expect(await r.evidence.capture()).toEqual([]);
    expect(r.attached).toEqual([]);
  });

  test('a skipped test leaves nothing, whatever the mode; a test that failed as expected (test.fail) is not a failure', async () => {
    expect(await rig('on', 'skipped').evidence.capture()).toEqual([]);
    expect(await rig('failure', 'failed', 'failed').evidence.capture()).toEqual([]);
    expect(testFailed({ status: 'timedOut', expectedStatus: 'passed' })).toBe(true);
    expect(testFailed({ status: 'interrupted', expectedStatus: 'passed' })).toBe(true);
    expect(testFailed({ status: undefined, expectedStatus: 'passed' })).toBe(false);
  });

  test('capturing twice takes one screenshot (the app fixtures and the evidence fixture both call it)', async () => {
    const r = rig('on', 'passed');
    const first = await r.evidence.capture();
    const second = await r.evidence.capture();
    expect(second).toEqual(first);
    expect(fs.readdirSync(r.settings.run.evidenceDir)).toHaveLength(1);
  });

  test('it never throws: a desktop that cannot take a screenshot must not hide the real failure', async () => {
    const transport: DesktopTransport = { request: async (c: DesktopCommand) => { throw new DesktopTransportError(`no ${c.op}`, 'BRIDGE_EXITED'); }, close: async () => undefined };
    const settings = settingsFor({ SAS_EVIDENCE: 'on', SAS_EVIDENCE_DIR: tempDir() });
    const evidence = new TestEvidence({ session: new DesktopSession(transport), run: settings.run, testInfo: { title: 't', status: 'failed', expectedStatus: 'passed', attach: async () => undefined } });
    await expect(evidence.capture()).resolves.toEqual([]);
  });
});

test.describe('the step journal', () => {
  const entry = (label: string, ms: number, ok: boolean, error?: string, at = 100): JournalEntry => ({ at, label, target: `window "X" > ${label}`, ms, ok, ...(error ? { error } : {}) });

  test('lists what the test did, newest steps only, with timings and the first line of each error', () => {
    const text = journalText([entry('click', 5, true, undefined, 10), entry('fill', 12, true, undefined, 200), entry('click', 30000, false, 'no control matched Button "OK"', 300)], 150);
    expect(text).not.toContain('window "X" > click  \n'); // the step of an earlier test is cut
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('FAILED');
    expect(text).toContain('no control matched Button "OK"');
  });

  test('a secret that reached a journal line is masked', () => {
    clearRegisteredSecrets();
    registerSecret('Zx9-journal-secret');
    expect(journalText([entry('fill', 1, false, 'could not type Zx9-journal-secret')], 0)).not.toContain('Zx9-journal-secret');
    clearRegisteredSecrets();
  });
});
