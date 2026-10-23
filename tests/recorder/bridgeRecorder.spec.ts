import { expect, test } from '@playwright/test';
import { SECRET_WORDS, RAW_EVENT_TYPES, type PathStep, type RawOf, type RecordSnapshot, type RecordStartResult, type Target, type TargetWindow } from '../../src/recorder';
import { functionBody, scriptText } from '../desktop/bridgeScript';

// STATIC checks of the recorder in bridge/sas-desktop-bridge.ps1. It has NEVER run on Windows (NOT VERIFIED): these tests only prove that the text has the
// safety properties its design promises - hooks on their own thread and always removed, nothing recorded without a chosen program, nothing from other
// programs, nothing typed into a secret field, no characters taken from key presses - and that it speaks the same vocabulary as the TypeScript side.

const script = scriptText();
/** The recorder's C#, comments removed (a commented-out line must not count as code). */
const cs = ((/\$recorderSource = @'\n([\s\S]*?)\n'@/.exec(script)?.[1] ?? '') as string).replace(/\/\/[^\n]*/g, '');

/** The source with string literals and comments blanked out (same length), for matching code and braces without being fooled by text. */
function masked(source: string): string {
  return source.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length)).replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${' '.repeat(m.length - 2)}"`);
}

/** The body (with braces) of the C# method whose declaration matches `signature`. */
function method(signature: RegExp): string {
  const code = masked(cs);
  const match = signature.exec(code);
  if (!match) throw new Error(`no method matching ${signature}`);
  let depth = 0;
  for (let i = code.indexOf('{', match.index); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return cs.slice(code.indexOf('{', match.index), i + 1);
  }
  throw new Error(`method ${signature} is not closed`);
}

const calls = (text: string, name: string) => masked(text).includes(name);

test.describe('the recorder source is there and is only compiled when it is used', () => {
  test('the C# is a here-string, ASCII only, compiled by Initialize-Recorder and nowhere else; a compile failure answers NOT_IMPLEMENTED instead of ending the bridge', () => {
    expect(cs.length).toBeGreaterThan(5000);
    expect(cs).toContain('public static class SasRecorder');
    expect(cs).not.toMatch(/[^\x20-\x7e\n]/);
    expect([...script.matchAll(/Add-Type -TypeDefinition \$recorderSource/g)]).toHaveLength(1);
    const init = functionBody(script, 'Initialize-Recorder');
    expect(init).toContain('Add-Type -TypeDefinition $recorderSource');
    expect(init).toMatch(/catch \{\s*\$script:RecorderError = /);
    expect(init).toContain('Op-NotImplemented $op');
    expect(functionBody(script, 'Op-NotImplemented')).toContain("Fail 'NOT_IMPLEMENTED'");
    for (const fn of ['Op-RecordStart', 'Op-RecordEvents']) expect(functionBody(script, fn)).toMatch(/^[^\n]*\n\s*Initialize-Recorder 'record\./);
    // nothing about the recorder runs at start-up: it is only called from inside the four functions that serve record.start / record.events / record.stop and the clean-up
    const lines = script.split('\n');
    const owners = new Set<string>();
    lines.forEach((line, index) => {
      if (!line.includes('[SasRecorder]::')) return;
      for (let i = index; i >= 0; i--) {
        const fn = /^function ([\w-]+)/.exec(lines[i] as string);
        if (fn) return void owners.add(fn[1] as string);
        if (i === 0) owners.add('(top level)');
      }
    });
    expect([...owners].sort()).toEqual(['Op-RecordEvents', 'Op-RecordStart', 'Op-RecordStop', 'Stop-RecorderQuietly']);
  });

  test('it is C# 5: nothing newer than the compiler of Windows PowerShell 5.1 understands', () => {
    const code = masked(cs);
    for (const [what, pattern] of [
      ['a null-conditional ?.', /\w\?\./],
      ['an interpolated string', /\$"/],
      ['nameof', /\bnameof\s*\(/],
      ['an expression-bodied member', /\)\s*=>\s*[^{\s]/],
      ['out var', /\bout\s+var\b/],
      ['a pattern match (is T x)', /\bis\s+[A-Z]\w*\s+[a-z]\w*\s*[)&|]/],
      ['a tuple', /\(\s*\w+\s+\w+\s*,\s*\w+\s+\w+\s*\)\s*=/],
      ['an auto-property initializer', /\{\s*get;\s*set;\s*\}\s*=/],
      ['async', /\basync\b/],
      ['a using static', /using\s+static\b/],
    ] as const) {
      expect(code, what).not.toMatch(pattern);
    }
  });
});

test.describe('hooks: their own thread, and always removed', () => {
  const hookLoop = method(/private static void HookLoop\(\)/);

  test('the two low-level hooks are installed on a dedicated STA thread with its own message loop - nowhere else', () => {
    expect([...masked(cs).matchAll(/SetWindowsHookEx\(/g)]).toHaveLength(3); // the declaration and the two calls
    expect(masked(hookLoop).match(/SetWindowsHookEx\(/g)).toHaveLength(2);
    expect(hookLoop).toContain('SetWindowsHookEx(14, mouseProc');
    expect(hookLoop).toContain('SetWindowsHookEx(13, keyboardProc');
    expect(hookLoop).toMatch(/while \(GetMessage\(out msg, IntPtr\.Zero, 0, 0\) > 0\)/);
    expect(hookLoop).toContain('PeekMessage(out msg'); // the thread's queue exists before anyone posts to it
    const start = method(/public static Dictionary<string, object> Start\(/);
    expect(start).toContain('hookThread = new Thread(HookLoop);');
    expect(start).toContain('hookThread.SetApartmentState(ApartmentState.STA);');
    expect(start).toContain('workThread.SetApartmentState(ApartmentState.MTA);'); // UI Automation is used from an MTA thread
    expect(start).toContain('IsBackground = true');
  });

  test('both hooks are removed in a finally block of that thread; Stop ends the message loop (WM_QUIT) and waits for it; the stand-by delegates stay referenced', () => {
    const fin = hookLoop.slice(hookLoop.indexOf('finally'));
    expect(fin).toContain('UnhookWindowsHookEx(mouseHook)');
    expect(fin).toContain('UnhookWindowsHookEx(keyboardHook)');
    expect(fin).toContain('mouseHook = IntPtr.Zero');
    const shutdown = method(/private static void Shutdown\(\)/);
    expect(shutdown).toContain('PostThreadMessage(hookThreadId, 0x0012');
    expect(shutdown).toContain('hookThread.Join(');
    expect(shutdown).toContain('workThread.Join(');
    expect(cs).toMatch(/private static LowLevelProc mouseProc;/); // a static field: the garbage collector cannot free the callback while it is hooked
    expect(cs).toMatch(/private static LowLevelProc keyboardProc;/);
    // the work thread removes the UI Automation handlers in a finally block too, and the bridge stops the recorder when it ends
    expect(method(/private static void WorkLoop\(\)/).slice(-400)).toContain('Automation.RemoveAllEventHandlers()');
    expect(script).toMatch(/finally \{\s*Stop-RecorderQuietly\s*\}/);
    expect(functionBody(script, 'Stop-RecorderQuietly')).toContain('[SasRecorder]::Stop()');
  });

  test('the hook procedures are quick and safe: no UI Automation, no waiting, never an exception out, always the next hook', () => {
    for (const name of ['MouseCallback', 'KeyboardCallback']) {
      const body = method(new RegExp(`private static IntPtr ${name}\\(`));
      for (const forbidden of ['AutomationElement', 'Automation.', 'AutomationElement.FromPoint', 'TryGetCurrentPattern', '.Current', 'Thread.Sleep', 'WaitOne', 'lock (OutboxLock)', 'Process.']) expect(calls(body, forbidden), `${name} calls ${forbidden}`).toBe(false);
      expect(body, name).toContain('try');
      expect(body, name).toMatch(/catch \(Exception\) \{ \}/);
      expect(body.trimEnd().endsWith('return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);\n    }'), name).toBe(true);
      expect(body, name).toContain('!stopping');
    }
  });
});

test.describe('nothing is recorded without a chosen program, and nothing from another one', () => {
  test('Start refuses an empty target before it creates a thread; record.start refuses a call without a target before it compiles anything it needs', () => {
    const start = method(/public static Dictionary<string, object> Start\(/);
    expect(start.indexOf('pids == null || pids.Length == 0')).toBeGreaterThan(-1);
    expect(start.indexOf('pids == null || pids.Length == 0')).toBeLessThan(start.indexOf('new Thread('));
    expect(start).toContain('the recorder never records without a chosen program');
    const op = functionBody(script, 'Op-RecordStart');
    expect(op.indexOf("record.start needs a target")).toBeGreaterThan(-1);
    expect(op.indexOf('record.start needs a target')).toBeLessThan(op.indexOf('[SasRecorder]::Start'));
    expect(op.indexOf("Fail 'NOT_FOUND'")).toBeLessThan(op.indexOf('[SasRecorder]::Start')); // no window of the program: no recording
    expect(op).toContain('Get-WindowList $cmd'); // the program is chosen with the same filter every other operation uses
  });

  test('a mouse click is looked at only when the window under the pointer belongs to a chosen process; a key only when the foreground window does; the stop chord is the one exception and is never recorded', () => {
    const mouse = method(/private static IntPtr MouseCallback\(/);
    expect(mouse).toContain('WindowBelongsToTarget(WindowFromPoint(info.pt))');
    expect(mouse.indexOf('WindowBelongsToTarget')).toBeLessThan(mouse.indexOf('Enqueue(item)'));
    const key = method(/private static IntPtr KeyboardCallback\(/);
    expect(key).toContain('WindowBelongsToTarget(GetForegroundWindow())');
    expect(key).toContain('Interlocked.Increment(ref foreignKeysIgnored)');
    const chord = key.indexOf('stopRequested = true');
    expect(chord).toBeGreaterThan(-1);
    expect(key.slice(chord - 250, chord + 40)).not.toContain('Enqueue'); // the chord sets a flag and queues nothing
    expect(method(/private static bool WindowBelongsToTarget\(/)).toContain('IsTargetPid((int)pid)');
    // UI Automation events are filtered by process before they are queued
    expect(method(/private static bool SenderInTarget\(/)).toContain('IsTargetPid(el.Current.ProcessId)');
    expect(method(/private static void OnFocus\(/)).toContain('IsTargetPid(el.Current.ProcessId)');
  });
});

test.describe('secrets', () => {
  test('a key pressed while a secret field has the focus is thrown away IN the hook procedure: counted, never queued with its key code', () => {
    const key = method(/private static IntPtr KeyboardCallback\(/);
    const secret = key.slice(key.indexOf('if (secretFocus && !IsNonContentKey(info.vkCode))'));
    expect(secret.slice(0, secret.indexOf('else'))).toContain('Interlocked.Increment(ref secretKeysDiscarded)');
    expect(secret.slice(0, secret.indexOf('else'))).not.toContain('Vk');
    expect(secret.slice(0, secret.indexOf('else'))).toContain('item.Kind = KindSecretKey'.replace('item', 'note'));
    expect(method(/private static bool IsNonContentKey\(/)).toMatch(/vk == 0x0D \|\| vk == 0x09 \|\| vk == 0x1B/); // Enter, Tab, Escape only
    // the flag is set from the focus event, in the callback itself, and fails SAFE
    const focus = method(/private static void OnFocus\(/);
    expect(focus).toContain('secretFocus = SecretKindOf(el) != null');
    expect(focus.slice(focus.indexOf('catch'))).toContain('secretFocus = true');
  });

  test('a secret is recognised by the control itself (IsPassword), by its name, automation id, help text or label, and by extra patterns - and an unreadable control counts as secret', () => {
    const kind = method(/private static string SecretKindOf\(AutomationElement el\)/);
    expect(kind).toContain('el.Current.IsPassword');
    expect(kind.slice(kind.indexOf('catch'), kind.indexOf('catch') + 60)).toContain('return "password"');
    for (const source of ['SafeName(el)', 'SafeId(el)', 'el.Current.HelpText', 'el.Current.LabeledBy']) expect(kind, source).toContain(source);
    expect(method(/private static string SecretKindOfName\(/)).toContain('ExtraSecret');
    expect(method(/private static string\[\] WordsOf\(/)).toContain('([a-z0-9])([A-Z])'); // names are judged by whole words, like the TypeScript side
  });

  test('the value of a secret field is never read: not when typing is flushed, not while idle, not by the focus watcher, and a secret field never becomes an ordinary typing record', () => {
    const flush = method(/private static void FlushTyping\(/);
    const secretBranch = flush.slice(flush.indexOf('if (t.Secret)'), flush.indexOf('else'));
    expect(secretBranch).not.toContain('ReadTypingValue');
    expect(secretBranch).not.toContain('.Value');
    expect(flush.slice(flush.indexOf('else'))).toContain('ReadTypingValue(t)');
    expect(method(/private static void Idle\(\)/)).toContain('!t.Secret');
    const watch = method(/private static void WatchFocus\(/);
    expect(watch.indexOf('SecretKindOf(el) != null')).toBeLessThan(watch.indexOf('TryGetCurrentPattern(ValuePattern.Pattern'));
    const note = method(/private static void NoteTyping\(\)/);
    expect(note.indexOf('SecretKindOf(focused)')).toBeLessThan(note.indexOf('new Typing()'));
    expect(note.slice(0, note.indexOf('new Typing()'))).toContain('NoteSecretTyping(focused, kind)');
    expect(method(/private static void HandleSecretKey\(\)/)).toContain('NoteSecretTyping(');
    // the only reads of a ValuePattern value: ReadTypingValue (guarded above) and WatchFocus / FlushWatched (after the secret check)
    const readers = [...masked(cs).matchAll(/\(\(ValuePattern\)pattern\)\.Current\.Value/g)].length;
    expect(readers).toBe(3);
  });

  test('no character is ever taken from a key press: only key codes are queued, and nothing translates them to text', () => {
    for (const forbidden of ['ToUnicode', 'ToAscii', 'MapVirtualKey', 'GetKeyboardState', 'VkKeyScan', 'GetKeyNameText', 'GetAsyncKeyState', 'Clipboard']) expect(calls(cs, forbidden), forbidden).toBe(false);
    const raw = cs.slice(cs.indexOf('private sealed class RawInput'), cs.indexOf('private sealed class PendingClick'));
    expect(raw).toContain('public uint Vk;');
    expect(raw).not.toMatch(/char|string Text|string Chars/);
    // a key becomes a `key` event only as a named key or a chord with Ctrl / Alt (what Printable and editing keys are is decided before)
    const handle = method(/private static void HandleKey\(RawInput item\)/);
    expect(handle.indexOf('NoteTyping();')).toBeLessThan(handle.indexOf('NewEvent("key")'));
    expect(handle).toContain('if (name == null) return;');
  });

  test('the secret words are the TypeScript ones and the kinds map the same way (a second guard beside secrets.spec.ts)', () => {
    for (const [word, kind] of Object.entries(SECRET_WORDS)) {
      expect(script.includes(`"${word}"`), word).toBe(true);
      if (word !== 'pwd' && !['pw', 'pass', 'passwd', 'password', 'passcode', 'passphrase', 'kennwort', 'credential', 'credentials'].includes(word)) expect(script, word).toContain(`SecretWords["${word}"] = "${kind}"`);
    }
  });
});

test.describe('the queue is bounded', () => {
  test('both the input queue and the event list refuse more than maxQueue and count what they refuse', () => {
    expect(method(/private static void Enqueue\(RawInput item\)/)).toMatch(/Inbox\.Count >= maxQueue[\s\S]*Interlocked\.Increment\(ref dropped\)[\s\S]*return;/);
    expect(method(/private static void Emit\(Dictionary<string, object> ev\)/)).toMatch(/Outbox\.Count >= maxQueue[\s\S]*Interlocked\.Increment\(ref dropped\)[\s\S]*return;/);
    expect(method(/private static Dictionary<string, object> BuildSnapshot\(/)).toContain('take > 2000'); // a drain is bounded too
    expect(functionBody(script, 'Op-RecordStart')).toContain('Get-IntArg (Get-Prop $cmd \'maxQueue\') 5000');
  });
});

test.describe('the same vocabulary as the TypeScript side', () => {
  /** One of every field a raw event, a target or a snapshot can have (typed: a field added or renamed in TypeScript stops this compiling until it is added here). */
  const window: Required<TargetWindow> = { titlePattern: '', title: '', className: '' };
  const step: Required<PathStep> = { controlType: '', name: '', automationId: '', className: '', index: 0 };
  const target: Required<Target> = { window, path: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, fallbackPoint: { x: 0, y: 0 }, unique: { automationId: true, nameAndType: true } };
  const typed: Required<RawOf<'typed'>> = { type: 'typed', t: 0, target, value: '', secret: true, secretKind: 'password', committedBy: 'blur' };
  const selected: Required<RawOf<'selected'>> = { type: 'selected', t: 0, target, container: target, added: true };
  const key: Required<RawOf<'key'>> = { type: 'key', t: 0, keys: '', window, target };
  const toggled: Required<RawOf<'toggled'>> = { type: 'toggled', t: 0, target, state: true };
  const windowEvent: Required<RawOf<'windowOpened'>> = { type: 'windowOpened', t: 0, title: '', className: '', process: '', owned: true };
  const snapshot: Required<RecordSnapshot> = { events: [], dropped: 0, secretKeysDiscarded: 0, foreignKeysIgnored: 0, recording: true, targetAlive: true, stopRequested: true, queued: 0, durationMs: 0 };
  const started: Required<RecordStartResult> = { pid: 0, pids: [], process: '', windows: 0, mode: 'full', startedAt: '', maxQueue: 0 };
  const known = new Set([...Object.keys(window), ...Object.keys(step), ...Object.keys(target), ...Object.keys(target.bounds), ...Object.keys(target.unique), ...Object.keys(typed), ...Object.keys(selected), ...Object.keys(key), ...Object.keys(toggled), ...Object.keys(windowEvent)]);

  test('every key the recorder writes into an event or a target is a field of the TypeScript types', () => {
    const code = cs.split('\n').filter((l) => !l.includes('SecretWords[')).join('\n'); // (the word table is not an event)
    const written = new Set([...code.matchAll(/\b\w+\["([A-Za-z]+)"\]\s*=/g)].map((m) => m[1] as string));
    // the snapshot and the start answer have their own vocabulary
    const answers = new Set([...Object.keys(snapshot), 'hooksRemoved', 'startedAt']);
    const events = [...written].filter((k) => !answers.has(k) || known.has(k));
    expect(events.filter((k) => !known.has(k))).toEqual([]);
    for (const k of ['type', 't', 'target', 'window', 'titlePattern', 'path', 'controlType', 'name', 'automationId', 'index', 'unique', 'bounds', 'fallbackPoint', 'value', 'secret', 'secretKind', 'committedBy', 'keys', 'container', 'added', 'state', 'owned']) expect(written.has(k), k).toBe(true);
  });

  test('the event types it creates are exactly the raw types (doubleClick is the TypeScript side\'s own: two clicks)', () => {
    const created = new Set([...cs.matchAll(/NewEvent\("([A-Za-z]+)"\)/g)].map((m) => m[1] as string));
    for (const m of cs.matchAll(/NewEvent\([\w.]+ == \d \? "([A-Za-z]+)" : "([A-Za-z]+)"\)|NewEvent\(state == [\w.]+ \? "([A-Za-z]+)" : "([A-Za-z]+)"\)|EmitWindowRec\("([A-Za-z]+)"|EmitWindow\("([A-Za-z]+)"/g)) for (const g of m.slice(1)) if (g) created.add(g);
    expect([...created].sort()).toEqual([...RAW_EVENT_TYPES].filter((t) => t !== 'doubleClick').sort());
  });

  test('the snapshot and the start answer carry the fields of RecordSnapshot and RecordStartResult', () => {
    const built = method(/private static Dictionary<string, object> BuildSnapshot\(/);
    const fields = [...built.matchAll(/snapshot\["([A-Za-z]+)"\]/g)].map((m) => m[1] as string);
    for (const k of Object.keys(snapshot)) expect(fields, k).toContain(k);
    const op = functionBody(script, 'Op-RecordStart');
    for (const k of Object.keys(started)) expect(op, k).toMatch(new RegExp(`\\b${k}\\s*=|'${k}'`));
    expect(functionBody(script, 'Op-RecordStop')).toContain('stopRequested = $false');
  });
});

test('the file says the recorder is NOT VERIFIED and names what it does and never does', () => {
  const header = script.split('param(')[0] as string;
  expect(header).toMatch(/recorder of ADR 0002.*NOT VERIFIED on Windows/s);
  expect(header).toMatch(/The recorder never records another program's windows, never records without a chosen program, never keeps a key press that went/);
  expect(script).toContain('// NOT VERIFIED on Windows. The recorder of ADR 0002.');
});
