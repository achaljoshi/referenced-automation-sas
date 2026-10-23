import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { DesktopTransportError, FAKE_EG_PATH, FAKE_PROJECT_PATH, FAKE_SMC_PATH, ProcessTransport, startFakeDesktop, type DesktopCommand, type FakeSasDesktop } from '../../src/desktop';
import type { RawEvent, RawOf, RecordSnapshot, RecordStartResult, UserAction } from '../../src/recorder';
import { builtStandIn } from './support/built';

// The stand-in's recorder: what record.start / record.events / record.stop answer, and what simulateUserActions makes a "user" report. This is the
// equipment every other recorder test stands on, so it is tested for the same rules the PowerShell recorder has to keep (NOT VERIFIED on Windows).

const request = (fake: FakeSasDesktop, command: DesktopCommand) => fake.desktop.request(command);
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as DesktopTransportError);
const events = async (fake: FakeSasDesktop): Promise<RawEvent[]> => ((await request(fake, { op: 'record.events' })) as RecordSnapshot).events;

async function eg(options: Parameters<typeof startFakeDesktop>[0] = {}) {
  const fake = startFakeDesktop(options);
  const session = fake.session();
  await session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
  return { fake, session };
}

const startOn = (fake: FakeSasDesktop, extra: Partial<Extract<DesktopCommand, { op: 'record.start' }>> = {}) =>
  request(fake, { op: 'record.start', titleRegex: 'SAS Enterprise Guide', ...extra }) as Promise<RecordStartResult>;

const connectAndLogOn = (account: { user: string; password: string }): UserAction[] => [
  { do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } },
  { do: 'select', window: '^Select Profile$', find: 'Dev SAS Server' },
  { do: 'click', window: '^Select Profile$', find: { name: 'OK', controlType: 'Button' } },
  { do: 'type', window: '^SAS Logon$', find: { automationId: 'userIdField' }, text: account.user },
  { do: 'type', window: '^SAS Logon$', find: { automationId: 'passwordField' }, text: account.password, commit: 'enter' },
  { do: 'click', window: '^SAS Logon$', find: { name: 'OK', controlType: 'Button' } },
];

test.describe('record.start', () => {
  test('refuses without a target, without the program, and with bad settings - nothing is recorded in any of those cases', async () => {
    const { fake } = await eg();
    expect((await caught(request(fake, { op: 'record.start' })))?.message).toMatch(/needs a target.*never records without a chosen program/);
    expect(await caught(request(fake, { op: 'record.start', titleRegex: 'No Such Program' }))).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/start the program first/) });
    expect((await caught(startOn(fake, { mode: 'turbo' as never })))?.message).toMatch(/mode must be one of full, uia/);
    expect((await caught(startOn(fake, { maxQueue: 0 })))?.message).toMatch(/maxQueue must be a positive whole number/);
    expect((await caught(startOn(fake, { secretPatterns: ['('] })))?.message).toMatch(/not a valid regular expression/);
    expect((await caught(startOn(fake, { stopKey: 'Hyper+Q' })))?.message).toMatch(/not a key chord/);
    expect(fake.desktop.recording).toBe(false);
    expect((await caught(request(fake, { op: 'record.events' })))?.message).toMatch(/not recording/);
  });

  test('answers what it records, reports the windows already open, and refuses a second recording', async () => {
    const { fake } = await eg();
    const started = await startOn(fake, { mode: 'uia', maxQueue: 50 });
    expect(started).toMatchObject({ process: 'SEGuide', windows: 1, mode: 'uia', maxQueue: 50 });
    expect(started.pids).toHaveLength(1);
    expect(Number.isNaN(Date.parse(started.startedAt))).toBe(false);
    expect(await events(fake)).toMatchObject([{ type: 'windowOpened', title: 'SAS Enterprise Guide', process: 'SEGuide', t: expect.any(Number) }]);
    expect((await caught(startOn(fake)))?.message).toMatch(/already recording/);
  });

  test('a locked desktop is SESSION_LOST', async () => {
    const { fake } = await eg();
    fake.desktop.lock();
    expect(await caught(startOn(fake))).toMatchObject({ code: 'SESSION_LOST' });
  });
});

test.describe('only the chosen program is recorded', () => {
  test('another program running at the same time leaves no event, no window event and no key', async () => {
    const { fake, session } = await eg();
    await session.launch({ path: FAKE_SMC_PATH, windowTitle: /./ });
    const started = await startOn(fake);
    expect(started.windows).toBe(1); // Management Console is open, and is not counted
    await request(fake, { op: 'record.events' });
    await fake.desktop.simulateUserActions([
      { do: 'select', window: '^Connection Profile$', find: 'Dev Metadata Server' },
      { do: 'click', window: '^Connection Profile$', find: { name: 'OK', controlType: 'Button' } },
      { do: 'type', window: '^Log On$', find: { name: 'User ID:' }, text: 'someone' },
      { do: 'key', window: '^Log On$', keys: 'Ctrl+S' },
    ]);
    const snapshot = (await request(fake, { op: 'record.events' })) as RecordSnapshot;
    expect(snapshot.events).toEqual([]); // not even the windows the other program opened and closed
    expect(snapshot.foreignKeysIgnored).toBe(1);
    // ... but what the user did there really happened in that program
    expect(fake.smc.attempts).toEqual([]);
    expect(fake.desktop.windows.some((w) => w.name === 'Log On')).toBe(true);
    // and the recorded program is still recorded
    await fake.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }]);
    expect((await events(fake)).map((e) => e.type)).toEqual(['click', 'invoke', 'windowOpened']);
  });
});

test.describe('what an event carries', () => {
  test('a click is aimed with a locator candidate chain: window, path, the control last, uniqueness, class and position when nothing else names it', async () => {
    const { fake } = await eg();
    await startOn(fake);
    await request(fake, { op: 'record.events' });
    await fake.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }]);
    const [click] = (await events(fake)) as Array<RawOf<'click'>>;
    expect(click?.target.window).toEqual({ titlePattern: '^SAS Enterprise Guide$', title: 'SAS Enterprise Guide', className: 'HwndWrapper[SEGuide.exe;;fake]' });
    expect(click?.target.path).toEqual([{ controlType: 'Button', name: 'Connect', automationId: 'ConnectButton' }]);
    expect(click?.target.unique).toEqual({ automationId: true, nameAndType: true });
    expect(click?.target.bounds).toMatchObject({ width: 100, height: 24 });
    expect(click?.target.fallbackPoint).toEqual({ x: 50, y: 12 });
  });

  test('a control with neither name nor id carries its class and its position among controls of that kind; ones with a name never do', async () => {
    const fake = startFakeDesktop();
    const process_ = fake.desktop.addProcess('demo');
    fake.desktop.registerProgram('C:\\demo.exe', { process: 'demo', onLaunch: () => undefined });
    const window = fake.desktop.addWindow(process_, {
      title: 'Demo',
      children: [
        { controlType: 'Edit', className: 'JTextField', value: '' },
        { controlType: 'Edit', className: 'JTextField', value: '' },
        { controlType: 'Edit', className: 'JTextField', name: 'Named', value: '' },
      ],
    });
    await request(fake, { op: 'record.start', titleRegex: 'Demo' });
    await request(fake, { op: 'record.events' });
    await fake.desktop.simulateUserActions([{ do: 'click', window: 'Demo', find: { controlType: 'Edit', className: 'JTextField' }, nth: 1 }, { do: 'click', window: 'Demo', find: 'Named' }]);
    const clicks = (await events(fake)) as Array<RawOf<'click'>>;
    expect(clicks[0]?.target.path).toEqual([{ controlType: 'Edit', className: 'JTextField', index: 1 }]);
    expect(clicks[1]?.target.path).toEqual([{ controlType: 'Edit', name: 'Named', className: 'JTextField' }]);
    expect(window.children).toHaveLength(3);
  });

  test('when two controls share a name the click says it is not unique', async () => {
    const fake = startFakeDesktop();
    const process_ = fake.desktop.addProcess('demo');
    fake.desktop.addWindow(process_, { title: 'Demo', children: [{ controlType: 'Button', name: 'OK' }, { controlType: 'Button', name: 'OK' }] });
    await request(fake, { op: 'record.start', titleRegex: 'Demo' });
    await fake.desktop.simulateUserActions([{ do: 'click', window: 'Demo', find: 'OK', nth: 0 }]);
    const all = (await events(fake)) as Array<RawOf<'click'>>;
    expect(all.find((e) => e.type === 'click')?.target.unique).toEqual({ nameAndType: false });
    // and asking for "OK" without saying which is an error (a person points at one)
    expect((await caught(fake.desktop.simulateUserActions([{ do: 'click', window: 'Demo', find: 'OK' }])))?.message).toMatch(/matches 2 controls.*say which with nth/);
  });

  test('windows opening and closing are events, a dialog owned by its window says so', async () => {
    const { fake } = await eg();
    await startOn(fake);
    await request(fake, { op: 'record.events' });
    const account = fake.eg.options.accounts[0] as { user: string; password: string };
    await fake.desktop.simulateUserActions(connectAndLogOn(account));
    const kinds = (await events(fake)).filter((e) => e.type === 'windowOpened' || e.type === 'windowClosed').map((e) => `${e.type}:${(e as { title: string }).title}`);
    expect(kinds).toEqual(['windowOpened:Select Profile', 'windowClosed:Select Profile', 'windowOpened:SAS Logon', 'windowClosed:SAS Logon']);
    const owned = startFakeDesktop({ eg: { dialogMode: 'owned' } });
    const session = owned.session();
    await session.launch({ path: FAKE_EG_PATH, windowTitle: /./ });
    await startOn(owned);
    await request(owned, { op: 'record.events' });
    await owned.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }]);
    expect((await events(owned)).find((e) => e.type === 'windowOpened')).toMatchObject({ title: 'Select Profile', owned: true });
  });

  test('a click on a control that does something also reports the invoke; a checkbox reports its toggle; a list item its selection and container', async () => {
    const { fake } = await eg();
    await startOn(fake);
    await request(fake, { op: 'record.events' });
    await fake.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }, { do: 'click', window: '^Select Profile$', find: 'Dev SAS Server' }]);
    const all = await events(fake);
    expect(all.map((e) => e.type)).toEqual(['click', 'invoke', 'windowOpened', 'click', 'selected']);
    const selected = all.find((e) => e.type === 'selected') as RawOf<'selected'>;
    expect(selected.container?.path).toEqual([{ controlType: 'List', name: 'Profiles' }]);

    const demo = startFakeDesktop();
    const process_ = demo.desktop.addProcess('demo');
    demo.desktop.addWindow(process_, { title: 'Demo', children: [{ controlType: 'CheckBox', name: 'Remember me', toggle: 'Off' }] });
    await request(demo, { op: 'record.start', titleRegex: 'Demo' });
    await request(demo, { op: 'record.events' });
    await demo.desktop.simulateUserActions([{ do: 'toggle', window: 'Demo', find: 'Remember me', state: true }, { do: 'toggle', window: 'Demo', find: 'Remember me', state: true }]);
    expect((await events(demo)).map((e) => `${e.type}${'state' in e ? `:${e.state}` : ''}`)).toEqual(['click', 'toggled:true']); // the second is already so: nothing to click
  });
});

test.describe('secrets', () => {
  const secret = startFakeDesktop().eg.options.accounts[0]?.password as string; // the fake program's own password

  test('a password typed in a password field reaches the program and leaves nothing but the fact in the events', async () => {
    const { fake } = await eg();
    await startOn(fake);
    await request(fake, { op: 'record.events' });
    const account = fake.eg.options.accounts[0] as { user: string; password: string };
    await fake.desktop.simulateUserActions(connectAndLogOn(account));
    const snapshot = (await request(fake, { op: 'record.events' })) as RecordSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain(account.password);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    const typed = snapshot.events.filter((e) => e.type === 'typed') as Array<RawOf<'typed'>>;
    expect(typed.map((e) => ({ secret: e.secret, kind: e.secretKind, hasValue: e.value !== undefined }))).toEqual([
      ...Array.from({ length: account.user.length }, () => ({ secret: undefined, kind: undefined, hasValue: true })),
      { secret: true, kind: 'password', hasValue: false },
    ]);
    expect(snapshot.secretKeysDiscarded).toBe(account.password.length);
    // the program did get it: the logon went through
    expect(fake.eg.attempts).toEqual([{ user: account.user, accepted: true }]);
  });

  test('a field named like a secret, or matching a pattern given at start, is secret even though the program does not mark it', async () => {
    const fake = startFakeDesktop();
    const process_ = fake.desktop.addProcess('demo');
    fake.desktop.addWindow(process_, {
      title: 'Demo',
      children: [
        { controlType: 'Edit', name: 'Your PIN', value: '' },
        { controlType: 'Edit', name: 'Account code', value: '' },
        { controlType: 'Edit', name: 'Nickname', value: '' },
      ],
    });
    await request(fake, { op: 'record.start', titleRegex: 'Demo', secretPatterns: ['account'] });
    await request(fake, { op: 'record.events' });
    await fake.desktop.simulateUserActions([
      { do: 'type', window: 'Demo', find: 'Your PIN', text: '4711' },
      { do: 'type', window: 'Demo', find: 'Account code', text: 'ZX-99' },
      { do: 'type', window: 'Demo', find: 'Nickname', text: 'ada' },
    ]);
    const snapshot = (await request(fake, { op: 'record.events' })) as RecordSnapshot;
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('4711');
    expect(text).not.toContain('ZX-99');
    expect(text).toContain('"value":"ada"'); // negative control: an ordinary field is recorded
    expect(snapshot.secretKeysDiscarded).toBe('4711'.length + 'ZX-99'.length);
  });
});

test.describe('the queue, drain and stop', () => {
  test('the queue is bounded: what does not fit is dropped and counted, never kept', async () => {
    const { fake } = await eg();
    await startOn(fake, { maxQueue: 5 });
    await fake.desktop.simulateUserActions(Array.from({ length: 6 }, () => ({ do: 'key', window: '^SAS Enterprise Guide$', keys: 'F5' }) as UserAction));
    const snapshot = (await request(fake, { op: 'record.events' })) as RecordSnapshot;
    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.dropped).toBe(2); // 1 window + 6 keys = 7 events for 5 places
    expect(snapshot.queued).toBe(0);
  });

  test('events are drained by default and kept with drain: false; stop returns the rest once and ends the recording', async () => {
    const { fake } = await eg();
    await startOn(fake);
    await fake.desktop.simulateUserActions([{ do: 'key', window: '^SAS Enterprise Guide$', keys: 'F5' }]);
    expect(((await request(fake, { op: 'record.events', drain: false })) as RecordSnapshot).events).toHaveLength(2);
    expect(((await request(fake, { op: 'record.events', drain: false })) as RecordSnapshot).queued).toBe(2);
    expect(((await request(fake, { op: 'record.events' })) as RecordSnapshot).events).toHaveLength(2);
    expect(((await request(fake, { op: 'record.events' })) as RecordSnapshot).events).toHaveLength(0);
    await fake.desktop.simulateUserActions([{ do: 'key', window: '^SAS Enterprise Guide$', keys: 'F6' }]);
    const stopped = (await request(fake, { op: 'record.stop' })) as RecordSnapshot;
    expect(stopped).toMatchObject({ recording: false, events: [{ type: 'key', keys: 'F6' }], durationMs: expect.any(Number) });
    expect(fake.desktop.recording).toBe(false);
    expect(((await request(fake, { op: 'record.stop' })) as RecordSnapshot).events).toEqual([]); // stopping twice is fine
    expect((await caught(request(fake, { op: 'record.events' })))?.message).toMatch(/not recording/);
    expect((await caught(fake.desktop.simulateUserActions([{ do: 'key', window: 'x', keys: 'F5' }])))?.message).toMatch(/not recording/);
  });

  test('the stop chord is noticed in any window and recorded in none; the program that was recorded going away is reported', async () => {
    const { fake, session } = await eg();
    const smc = await session.launch({ path: FAKE_SMC_PATH, windowTitle: /./ });
    await startOn(fake, { stopKey: 'ctrl+alt+q' });
    await request(fake, { op: 'record.events' });
    await fake.desktop.simulateUserActions([{ do: 'key', window: '^Connection Profile$', keys: 'Ctrl+Alt+Q' }]); // pressed in the other program
    const snapshot = (await request(fake, { op: 'record.events' })) as RecordSnapshot;
    expect(snapshot).toMatchObject({ stopRequested: true, events: [], foreignKeysIgnored: 0, targetAlive: true });
    await smc.dispose();
    const egApp = await session.attach({ processName: 'SEGuide' });
    await egApp.close({ force: true });
    expect(((await request(fake, { op: 'record.events' })) as RecordSnapshot).targetAlive).toBe(false);
  });

  test('with a virtual clock the same session gives the same events every time', async () => {
    const run = async () => {
      const { fake } = await eg();
      await startOn(fake);
      await fake.desktop.simulateUserActions(
        [{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }, { do: 'pause', ms: 1000 }, { do: 'select', window: '^Select Profile$', find: 'QA SAS Server' }],
        { virtualTime: true, stepMs: 100 },
      );
      return ((await request(fake, { op: 'record.events' })) as RecordSnapshot).events;
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first.map((e) => e.t)).toEqual([0, 0, 100, 200, 1300, 1400]);
  });
});

test.describe('simulateUserActions', () => {
  test('says what is wrong: no such window, no such control', async () => {
    const { fake } = await eg();
    await startOn(fake);
    expect((await caught(fake.desktop.simulateUserActions([{ do: 'click', window: 'Nowhere', find: 'x' }])))?.message).toMatch(/no window with a title matching Nowhere \(open: "SAS Enterprise Guide"\)/);
    expect((await caught(fake.desktop.simulateUserActions([{ do: 'click', window: '^SAS Enterprise Guide$', find: 'Nothing' }])))?.message).toMatch(/no control \{"name":"Nothing"\}/);
    expect((await caught(fake.desktop.simulateUserActions([{ do: 'key', window: '^SAS Enterprise Guide$', keys: 'Hyper+Q' }])))?.message).toMatch(/not a key chord/);
    expect((await caught(fake.desktop.simulateUserActions([{ do: 'toggle', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }])))?.message).toMatch(/cannot be toggled/);
  });

  test('a whole Enterprise Guide session works: logon, open a project with Ctrl+O, run it', async () => {
    const { fake } = await eg();
    await startOn(fake);
    const account = fake.eg.options.accounts[0] as { user: string; password: string };
    await fake.desktop.simulateUserActions([
      ...connectAndLogOn(account),
      { do: 'key', window: 'SAS Enterprise Guide$', keys: 'ctrl+o' },
      { do: 'type', window: '^Open$', find: { automationId: '1148' }, text: FAKE_PROJECT_PATH },
      { do: 'click', window: '^Open$', find: { automationId: '1' } },
      { do: 'select', window: 'Sales - SAS Enterprise Guide$', find: 'Summary' },
      { do: 'click', window: 'Sales - SAS Enterprise Guide$', find: { automationId: 'RunButton' } },
    ]);
    expect(fake.eg.openProjectPath).toBe(FAKE_PROJECT_PATH);
    await expect.poll(() => fake.eg.ran).toEqual(['program:Summary']);
  });
});

test.describe('over the real line protocol (the stand-in bridge as a child process)', () => {
  test('--simulate-actions makes the stand-in user act after record.start; --without-recorder answers NOT_IMPLEMENTED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-sim-'));
    const file = path.join(dir, 'actions.json');
    fs.writeFileSync(file, JSON.stringify([{ do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } }]));
    const start = (args: string[]) => ProcessTransport.start({ command: process.execPath, args: [builtStandIn(), ...args], label: 'Stand-in', env: { ...process.env, LOG_TO_FILE: 'false' }, requestTimeoutMs: 5000, startupTimeoutMs: 8000 });
    const transport = await start(['--simulate-actions', file]);
    await transport.request({ op: 'launch', path: FAKE_EG_PATH, waitForWindow: { titleRegex: '.' } });
    await transport.request({ op: 'record.start', titleRegex: 'SAS Enterprise Guide' });
    const snapshot = (await transport.request({ op: 'record.events' })) as RecordSnapshot;
    expect(snapshot.events.map((e) => e.type)).toEqual(['windowOpened', 'click', 'invoke', 'windowOpened']);
    expect(((await transport.request({ op: 'record.stop' })) as RecordSnapshot).recording).toBe(false);
    await transport.close();
    const without = await start(['--without-recorder']);
    for (const op of ['record.start', 'record.events', 'record.stop'] as const) {
      expect(await caught(without.request({ op, titleRegex: 'x' } as never))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    }
    await without.close();
  });
});
