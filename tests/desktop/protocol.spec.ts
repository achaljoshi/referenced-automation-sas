import { expect, test } from '@playwright/test';
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_PROTOCOL_VERSION,
  decodeLine,
  DESKTOP_OPS,
  DesktopTransportError,
  encodeRequest,
  OP_KIND,
  RECORDER_OPS,
  startFakeDesktop,
  type DesktopCommand,
  type DesktopOp,
} from '../../src/desktop';
import { dispatchedOps, scriptText } from './bridgeScript';

/** One example of every command. Typed as a Record over DesktopOp: adding an op to the protocol without an example here does not compile. */
const SAMPLES: { [K in DesktopOp]: Extract<DesktopCommand, { op: K }> } = {
  ping: { op: 'ping' },
  windows: { op: 'windows', pid: 1, processName: 'p', titleRegex: 't' },
  launch: { op: 'launch', path: 'C:\\x.exe', args: ['a'], cwd: 'C:\\', waitForWindow: { titleRegex: 't', timeoutMs: 1 } },
  attach: { op: 'attach', pid: 1, processName: 'p', titleRegex: 't' },
  find: { op: 'find', root: 'e1', criteria: { name: 'n', nameContains: 'c', nameRegex: { pattern: 'p', ignoreCase: true }, automationId: 'a', controlType: 'Button', className: 'k', text: 't', nth: 0, scope: 'children', visibleOnly: true }, limit: 3 },
  children: { op: 'children', ref: 'e1' },
  info: { op: 'info', ref: 'e1' },
  invoke: { op: 'invoke', ref: 'e1' },
  click: { op: 'click', ref: 'e1' },
  doubleClick: { op: 'doubleClick', ref: 'e1' },
  rightClick: { op: 'rightClick', ref: 'e1' },
  setText: { op: 'setText', ref: 'e1', text: 't', secret: true },
  getText: { op: 'getText', ref: 'e1' },
  select: { op: 'select', ref: 'e1', add: true },
  expand: { op: 'expand', ref: 'e1' },
  collapse: { op: 'collapse', ref: 'e1' },
  toggle: { op: 'toggle', ref: 'e1', state: true },
  scrollIntoView: { op: 'scrollIntoView', ref: 'e1' },
  sendKeys: { op: 'sendKeys', ref: 'e1', keys: '{ENTER}', secret: true },
  focus: { op: 'focus', ref: 'e1' },
  waitForIdle: { op: 'waitForIdle', pid: 1, timeoutMs: 1 },
  screenshot: { op: 'screenshot', ref: 'e1' },
  tree: { op: 'tree', ref: 'e1', depth: 2, maxNodes: 3, pid: 1 },
  close: { op: 'close', ref: 'e1' },
  kill: { op: 'kill', pid: 1, processName: 'p' },
  diagnoseJava: { op: 'diagnoseJava', pid: 1 },
  environment: { op: 'environment' },
  'com.create': { op: 'com.create', progId: 'A.B' },
  'com.get': { op: 'com.get', handle: 'o1', path: 'A.B' },
  'com.set': { op: 'com.set', handle: 'o1', path: 'A', value: 1, secret: true },
  'com.call': { op: 'com.call', handle: 'o1', method: 'M', args: [1], secret: true },
  'com.release': { op: 'com.release', handle: 'o1' },
  'com.list': { op: 'com.list', prefix: 'A.' },
  'record.start': { op: 'record.start', pid: 1, processName: 'p', titleRegex: 't', mode: 'full', maxQueue: 10, secretPatterns: ['s'], stopKey: 'Ctrl+Alt+Q' },
  'record.stop': { op: 'record.stop' },
  'record.events': { op: 'record.events', drain: false },
  quit: { op: 'quit' },
};

test.describe('protocol drift (TypeScript <-> PowerShell bridge)', () => {
  test('the operations the PowerShell script handles are exactly DESKTOP_OPS', () => {
    const handled = dispatchedOps(scriptText());
    expect([...handled].sort()).toEqual([...DESKTOP_OPS].sort());
  });

  test('every DesktopCommand has an example, and every op is in DESKTOP_OPS and classified for the guard', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...DESKTOP_OPS].sort());
    expect(Object.keys(OP_KIND).sort()).toEqual([...DESKTOP_OPS].sort());
    expect(new Set(DESKTOP_OPS).size).toBe(DESKTOP_OPS.length);
  });

  test('every field of every command is read by the script: a renamed field on either side fails here', () => {
    const text = scriptText();
    const ignored = new Set(['op']);
    const missing: string[] = [];
    const visit = (op: string, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [key, inner] of Object.entries(value)) {
        if (!ignored.has(key) && !new RegExp(`'${key}'|\\$[A-Za-z]+\\.${key}\\b`).test(text)) missing.push(`${op}.${key}`);
        visit(op, inner);
      }
    };
    for (const [op, command] of Object.entries(SAMPLES)) visit(op, command);
    // `secret` is read by nobody on purpose: the bridge never echoes text whether or not it is flagged
    expect(missing.filter((m) => !m.endsWith('.secret'))).toEqual([]);
  });

  test('the fields the script writes for an element are the ones ElementInfo reads', async () => {
    const fake = startFakeDesktop();
    const app = await fake.session().launch({ path: 'C:\\Program Files\\SASHome\\SASEnterpriseGuide\\8\\SEGuide.exe', windowTitle: /./ });
    const window = (await app.window(/Enterprise Guide/).resolve()) as unknown as Record<string, unknown>;
    const info = (await fake.desktop.request({ op: 'info', ref: window.ref as string })) as Record<string, unknown>;
    const text = scriptText();
    for (const key of [...Object.keys(window), ...Object.keys(info)]) {
      if (key === 'process' || key === 'hwnd') expect(text, key).toMatch(new RegExp(`\\$o\\['${key}'\\]`));
      else expect(text, key).toMatch(new RegExp(`\\b${key}\\s*=|\\['${key}'\\]`));
    }
  });

  test('the protocol version and the error codes agree', () => {
    const text = scriptText();
    expect(text).toMatch(new RegExp(`\\$script:BridgeVersion = ${BRIDGE_PROTOCOL_VERSION}\\b`));
    const used = new Set([...text.matchAll(/Fail '([A-Z_]+)'/g)].map((m) => m[1]));
    for (const code of used) expect(BRIDGE_ERROR_CODES as readonly string[], `PowerShell can answer ${code}`).toContain(code);
    for (const code of BRIDGE_ERROR_CODES) expect(text, code).toContain(code);
  });

  test('the recorder operations exist in the script and in the stand-in; without a target the stand-in refuses to record, and nothing is recorded before record.start', async () => {
    expect([...RECORDER_OPS]).toEqual(['record.start', 'record.stop', 'record.events']);
    for (const op of RECORDER_OPS) expect(scriptText()).toMatch(new RegExp(`'${op.replace('.', '\\.')}' \\{ Op-Record`));
    const fake = startFakeDesktop();
    const noTarget = (await fake.desktop.request({ op: 'record.start' }).catch((e: unknown) => e)) as DesktopTransportError;
    expect(noTarget).toBeInstanceOf(DesktopTransportError);
    expect(noTarget.message).toMatch(/needs a target/);
    const notRecording = (await fake.desktop.request({ op: 'record.events' }).catch((e: unknown) => e)) as DesktopTransportError;
    expect(notRecording.message).toMatch(/not recording/);
  });

  test('encodeRequest is one line per command with the rid; decodeLine reads replies, the ready line, errors and junk', () => {
    const line = encodeRequest(7, { op: 'setText', ref: 'e1', text: 'line1\nline2 "quoted"' });
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)).toEqual({ rid: 7, op: 'setText', ref: 'e1', text: 'line1\nline2 "quoted"' });
    expect(decodeLine('{"rid":0,"ok":true,"value":"ready"}')).toEqual({ kind: 'ready' });
    expect(decodeLine('{"rid":3,"ok":true,"value":{"a":1}}')).toEqual({ kind: 'reply', rid: 3, ok: true, value: { a: 1 } });
    expect(decodeLine('{"rid":3,"ok":true}')).toEqual({ kind: 'reply', rid: 3, ok: true, value: null });
    for (const code of BRIDGE_ERROR_CODES) {
      const reply = decodeLine(`{"rid":4,"ok":false,"error":"x","code":"${code}"}`);
      expect(reply).toMatchObject({ kind: 'reply', ok: false, error: { code, message: 'x' } });
    }
    expect(decodeLine('{"rid":4,"ok":false,"error":"x","code":"TIMEOUT"}')).toMatchObject({ error: { code: 'ERROR' } }); // only the bridge's own codes survive
    expect(decodeLine('{"rid":4,"ok":false}')).toMatchObject({ error: { code: 'ERROR', message: 'unknown bridge error' } });
    for (const junk of ['', 'banner text', '{"no":"rid"}', '[1]', 'null', '{"rid":"7"}']) expect(decodeLine(junk), junk).toEqual({ kind: 'junk' });
  });

  test('every example is plain JSON a line can carry (nothing a PowerShell ConvertFrom-Json would choke on)', () => {
    for (const [op, command] of Object.entries(SAMPLES)) {
      const line = encodeRequest(1, command);
      expect(JSON.parse(line).op, op).toBe(op);
      expect(line).not.toMatch(/\n/);
    }
  });
});
