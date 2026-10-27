import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { governance } from '@automation/referenced-automation-utils';
import { expect, test } from '@playwright/test';
import { readAudit } from '../../src/core';
import { DesktopSession, FAKE_EG_PATH, FAKE_PROJECT_PATH, ProcessTransport, startFakeDesktop, type FakeSasDesktop } from '../../src/desktop';
import { authorizeRecording, parseRecording, Recorder, saveRecording, summarizeRecording, validateRecording, type RecorderProgress, type Recording, type UserAction } from '../../src/recorder';
import { config, makePolicy, tempDir } from '../core/support';
import { STARTUP_BUDGET_MS } from '../desktop/support';
import { builtStandIn } from './support/built';
import { egRunProject } from './support/scenarios';

const account = (fake: FakeSasDesktop) => fake.eg.options.accounts[0] as { user: string; password: string };

async function runningEg(options: Parameters<typeof startFakeDesktop>[0] = {}) {
  const fake = startFakeDesktop(options);
  const session = fake.session();
  await session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
  return { fake, session };
}

const logon = (fake: FakeSasDesktop): UserAction[] => egRunProject(account(fake), 'Dev SAS Server', FAKE_PROJECT_PATH).filter((a) => !('window' in a && a.window === '^Tip of the Day$'));

test.describe('Recorder against the stand-in desktop', () => {
  test('records a session, counts events live, and turns them into a valid recording that never holds the password', async () => {
    const { fake, session } = await runningEg();
    const progress: RecorderProgress[] = [];
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 20, onProgress: (p) => progress.push(p), startedAt: '2026-10-23T09:00:00.000Z' });
    expect(recorder.eventsSeen).toBe(0);
    await fake.desktop.simulateUserActions(logon(fake), { virtualTime: true });
    await expect.poll(() => recorder.eventsSeen, { timeout: 5000 }).toBeGreaterThan(20); // the timer collects by itself
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]?.eventsSeen).toBe(recorder.eventsSeen);
    const { recording, stats, warnings } = await recorder.stop();
    expect(warnings).toEqual([]);
    expect(validateRecording(recording)).toMatchObject({ ok: true });
    expect(recording).toMatchObject({ version: 1, app: 'eg', startedAt: '2026-10-23T09:00:00.000Z', tool: 'sas-desktop-record 1' });
    expect(recording.events.map((e) => e.type)).toEqual([
      'windowOpened', 'click', 'windowOpened', 'select', 'click', 'windowClosed', 'windowOpened', 'text', 'text', 'click', 'windowClosed', 'key', 'windowOpened', 'text', 'click', 'windowClosed', 'select', 'click',
    ]);
    expect(recording.events.filter((e) => e.type === 'text').map((e) => ('secret' in e && e.secret ? 'secret' : (e as { value: string }).value))).toEqual(['sasdemo', 'secret', FAKE_PROJECT_PATH]);
    expect(recording.stats).toMatchObject({ secretEntries: 1, secretKeysDiscarded: account(fake).password.length, dropped: 0 });
    expect(stats.secretEntries).toBe(1);
    expect(JSON.stringify(recording)).not.toContain(account(fake).password);
  });

  test('stop() collects what is left, ends the recording on the bridge, and may be called twice', async () => {
    const { fake, session } = await runningEg();
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 5000 }); // the timer will not fire in this test
    await fake.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }]);
    expect(recorder.eventsSeen).toBe(0);
    const first = await recorder.stop();
    expect(first.recording.events.map((e) => e.type)).toEqual(['windowOpened', 'click', 'windowOpened']);
    expect(fake.desktop.recording).toBe(false);
    const second = await recorder.stop();
    expect(second.recording.events).toEqual(first.recording.events);
    expect(fake.desktop.calls.filter((c) => c.op === 'record.stop')).toHaveLength(1);
    expect(recorder.preview().events).toHaveLength(3);
  });

  test('the stop chord resolves stopRequested, and the chord itself is not in the recording', async () => {
    const { fake, session } = await runningEg();
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 10, stopKey: 'ctrl+alt+q' });
    let stopped = false;
    void recorder.stopRequested.then(() => (stopped = true));
    await fake.desktop.simulateUserActions([{ do: 'key', window: '^SAS Enterprise Guide$', keys: 'Ctrl+Alt+Q' }]);
    await expect.poll(() => stopped, { timeout: 3000 }).toBe(true);
    expect((await recorder.stop()).recording.events.some((e) => e.type === 'key')).toBe(false);
  });

  test('a recorded program that goes away also ends the wait; a bridge that fails mid-way leaves what was collected, with a note', async () => {
    const { fake, session } = await runningEg();
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 10 });
    await fake.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }]);
    await recorder.collect();
    fake.desktop.lock(); // the desktop goes away
    await recorder.collect();
    await recorder.stopRequested; // ends the wait instead of hanging
    const result = await recorder.stop();
    expect(result.recording.events.map((e) => e.type)).toContain('click');
    expect(result.warnings.join('\n')).toMatch(/recording ended early: .*locked or the session is disconnected/);
  });

  test('refuses what cannot work, in words: a stopped program, an old bridge, a bad mode, a bad stop key', async () => {
    const { session } = await runningEg();
    await expect(Recorder.start(session, { app: 'No Such Program' })).rejects.toThrow(/no window of the chosen program is open[^]*looked for a window matching No Such Program; list what is open with: sas-desktop-inspect windows/);
    await expect(Recorder.start(session, { app: 'eg', mode: 'turbo' as never })).rejects.toThrow(/mode must be one of full, uia/);
    await expect(Recorder.start(session, { app: 'eg', stopKey: 'Hyper+Q' })).rejects.toThrow(/not a key chord/);
    await expect(Recorder.start(session, { app: '(' })).rejects.toThrow(/--app must be "smc", "eg" or a regular expression/);
  });

  test('a policy that refuses stops everything before the bridge is asked, and a policy that allows is told how it went', async () => {
    const { fake, session } = await runningEg();
    const seen: string[] = [];
    const guard = {
      authorize: (op: { driver: string; operation: string; kind: string; target?: unknown; local?: boolean }) => {
        seen.push(`${op.driver}.${op.operation}:${op.kind}:${String(op.target)}:${String(op.local)}`);
        throw new Error('policy says no');
      },
      record: (r: { outcome: string }) => void seen.push(`recorded ${r.outcome}`),
    };
    await expect(Recorder.start(session, { app: 'eg', guard })).rejects.toThrow('policy says no');
    expect(seen).toEqual(['sas-recorder.record:read:eg:true', 'recorded denied']);
    expect(fake.desktop.calls.some((c) => c.op === 'record.start')).toBe(false);
    seen.length = 0;
    const allow = { authorize: () => void seen.push('authorized'), record: (r: { outcome: string }) => void seen.push(`recorded ${r.outcome}`) };
    const recorder = await Recorder.start(session, { app: 'eg', guard: allow });
    await recorder.stop();
    expect(seen).toEqual(['authorized', 'recorded ok']);
  });
});

test.describe('the file', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sas-rec-'));

  async function aRecording(): Promise<{ recording: Recording; password: string }> {
    const { fake, session } = await runningEg();
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 5000 });
    await fake.desktop.simulateUserActions(logon(fake), { virtualTime: true });
    return { recording: (await recorder.stop()).recording, password: account(fake).password };
  }

  test('is written, read back, and passes the repository\'s secret scanner - the password is nowhere in it', async () => {
    const { recording, password } = await aRecording();
    const file = path.join(dir(), 'out', 'run.sasrec.json');
    expect(saveRecording(file, recording)).toBe(path.resolve(file));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(password);
    expect(parseRecording(text, file).events).toEqual(recording.events);
    expect(governance.scanFile(file, text)).toEqual([]);
  });

  test('is not overwritten unless asked; and a recording that holds a value in a secret entry is refused at the door', async () => {
    const { recording } = await aRecording();
    const file = path.join(dir(), 'run.sasrec.json');
    saveRecording(file, recording);
    expect(() => saveRecording(file, recording)).toThrow(/already exists: choose another name, or overwrite on purpose \(--force\)/);
    expect(() => saveRecording(file, recording, { overwrite: true })).not.toThrow();
    const leaky = JSON.parse(JSON.stringify(recording)) as Recording;
    const secret = leaky.events.find((e) => e.type === 'text' && e.secret === true);
    (secret as unknown as { value: string }).value = 'hunter2-Zq9!';
    expect(() => saveRecording(path.join(dir(), 'leak.sasrec.json'), leaky)).toThrow(/a secret entry must not carry a value/);
  });

  test('has a summary that says what is in it and reminds what was not kept', async () => {
    const { fake, session } = await runningEg();
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 5000 });
    await fake.desktop.simulateUserActions(logon(fake), { virtualTime: true });
    const result = await recorder.stop();
    const text = summarizeRecording(result, 'recordings/run.sasrec.json').join('\n');
    expect(text).toMatch(/Recorded recordings\/run\.sasrec\.json: \d+ event\(s\) from \d+ raw event\(s\)/);
    expect(text).toMatch(/\d+ click.*\d+ text.*\d+ select/);
    expect(text).toContain('windows seen: "SAS Enterprise Guide"');
    expect(text).toMatch(/nothing typed into a password field was kept - 1 entry\(ies\) are marked secret \(no value\); 8 key press\(es\) in such fields were thrown away/);
    expect(text).toContain('SAS_PASSWORD');
    expect(text).not.toContain(account(fake).password);
    const lossy = summarizeRecording({ ...result, stats: { ...result.stats, dropped: 3 }, warnings: ['something odd'] }).join('\n');
    expect(lossy).toMatch(/WARNING: 3 event\(s\) were lost/);
    expect(lossy).toContain('note: something odd');
  });
});

test.describe('over the real line protocol', () => {
  test('the Recorder works against the stand-in bridge as a child process: the same recording as in-process', async () => {
    const probe = startFakeDesktop();
    const actions = logon(probe);
    const file = path.join(tempDir(), 'actions.json');
    fs.writeFileSync(file, JSON.stringify(actions));
    const transport = await ProcessTransport.start({
      command: process.execPath,
      args: [builtStandIn(), '--simulate-actions', file],
      label: 'Stand-in',
      env: { ...process.env, LOG_TO_FILE: 'false' },
      requestTimeoutMs: 8000,
      startupTimeoutMs: STARTUP_BUDGET_MS,
    });
    const session = new DesktopSession(transport, { timeoutMs: 5000, pollMs: 10 });
    await session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
    const recorder = await Recorder.start(session, { app: 'eg', pollMs: 5000 });
    const { recording } = await recorder.stop();
    expect(recording.events.length).toBeGreaterThan(8);
    expect(recording.events.filter((e) => e.type === 'text').map((e) => ('secret' in e && e.secret ? 'secret' : 'value'))).toEqual(['value', 'secret', 'value']);
    expect(JSON.stringify(recording)).not.toContain(account(probe).password);
    await session.close();
  });
});

test.describe('the environment gate for the real recorder', () => {
  test('a declared non-production environment is allowed and audited; an unknown one, and production, are refused', () => {
    const dir = tempDir();
    const policy = makePolicy(dir);
    expect(authorizeRecording('eg', { policy, env: config({ SAS_ENVIRONMENT: 'dev' }) })).toBe('dev');
    const audit = readAudit(path.join(dir, 'audit.jsonl'));
    expect(audit).toMatchObject([{ driver: 'sas-recorder', operation: 'record', kind: 'read', environment: 'dev', target: 'eg', outcome: 'ok' }]);
    expect(() => authorizeRecording('eg', { policy, env: config({ SAS_ENVIRONMENT: 'mystery' }) })).toThrow(/environment "mystery" is not declared/);
    expect(() => authorizeRecording('eg', { policy, env: config({ SAS_ENVIRONMENT: 'prod' }) })).toThrow(/production environment and reads there are switched off/);
    const allowedProd = makePolicy(tempDir(), { SAS_ALLOW_PROD_READS: 'true' });
    expect(authorizeRecording('eg', { policy: allowedProd, env: config({ SAS_ENVIRONMENT: 'prod', SAS_ALLOW_PROD_READS: 'true' }) })).toBe('prod');
  });
});
