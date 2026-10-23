import { DesktopTransportError, type DesktopCommand, type DesktopErrorCode, type DesktopOp } from './types';

/**
 * The bridge's line protocol, shared by every transport that talks to a bridge (a local process, a process on a remote host):
 *
 *   -> {"rid": 7, "op": "getText", "ref": "e12"}
 *   <- {"rid": 7, "ok": true, "value": "abc"}        or   {"rid": 7, "ok": false, "error": "...", "code": "NOT_FOUND"}
 *
 * and the ready message {"rid": 0, "ok": true}. One JSON message per line each way; a line that is not JSON is ignored. Only the codes
 * in BRIDGE_ERROR_CODES survive; any other failure is ERROR.
 */
export type BridgeLine =
  | { kind: 'junk' }
  | { kind: 'ready' }
  | { kind: 'reply'; rid: number; ok: true; value: unknown }
  | { kind: 'reply'; rid: number; ok: false; error: DesktopTransportError };

/**
 * Bumped together with `$script:BridgeVersion` in bridge/sas-desktop-bridge.ps1 whenever a command or reply changes shape
 * (tests/desktop/protocol.spec.ts compares them). `ping` reports the bridge's own number.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Every operation the bridge speaks - the single list the PowerShell script's `switch` is checked against
 * (tests/desktop/protocol.spec.ts). A command type that is not here, or an op here the script does not handle, fails that test.
 */
export const DESKTOP_OPS = [
  'ping',
  'windows',
  'launch',
  'attach',
  'find',
  'children',
  'info',
  'invoke',
  'click',
  'doubleClick',
  'rightClick',
  'setText',
  'getText',
  'select',
  'expand',
  'collapse',
  'toggle',
  'scrollIntoView',
  'sendKeys',
  'focus',
  'waitForIdle',
  'screenshot',
  'tree',
  'close',
  'kill',
  'diagnoseJava',
  'environment',
  'com.create',
  'com.get',
  'com.set',
  'com.call',
  'com.release',
  'com.list',
  'record.start',
  'record.stop',
  'record.events',
  'quit',
] as const satisfies readonly DesktopOp[];

/** Compile-time check: every DesktopCommand `op` is in DESKTOP_OPS (this type is `never` when none is missing). */
export type MissingOps = Exclude<DesktopOp, (typeof DESKTOP_OPS)[number]>;
const noOpIsMissing: MissingOps extends never ? true : false = true;
void noOpIsMissing;

/** The recorder's operations (docs/adr/0002, docs/RECORD_AND_PLAY.md): `record.start` (a target: pid, processName or titleRegex), `record.events` (drain the queue), `record.stop`. */
export const RECORDER_OPS = ['record.start', 'record.stop', 'record.events'] as const satisfies readonly DesktopOp[];

/** @deprecated The recorder operations are implemented now (RECORDER_OPS); a bridge that still answers NOT_IMPLEMENTED for them predates the recorder. */
export const RESERVED_RECORDER_OPS = RECORDER_OPS;

/** The error codes a bridge may answer with (anything else is read as ERROR). */
export const BRIDGE_ERROR_CODES = ['NOT_FOUND', 'SESSION_LOST', 'DENIED', 'NOT_IMPLEMENTED', 'ERROR'] as const satisfies readonly DesktopErrorCode[];

/**
 * What an operation can do to the system under test, as the OperationGuard (guard.ts) sees it:
 *  read         looks, navigates, starts a client: nothing in SAS changes
 *  update       types, clicks, toggles, sets or calls: it may change something
 *  destructive  stops a process
 * (`create` is used by the application layers for operations that make new objects/files, such as exporting results.)
 */
export type OperationKind = 'read' | 'create' | 'update' | 'destructive';

/**
 * How the session classifies each bridge operation for the guard. `null`: protocol housekeeping the guard is not asked about.
 * COM calls default to `update` because a method may do anything (callers pass `kind: 'read'` for a method known to only read).
 */
export const OP_KIND: Record<DesktopOp, OperationKind | null> = {
  ping: null,
  windows: 'read',
  launch: 'read',
  attach: 'read',
  find: 'read',
  children: 'read',
  info: 'read',
  invoke: 'update',
  click: 'update',
  doubleClick: 'update',
  rightClick: 'read',
  setText: 'update',
  getText: 'read',
  select: 'read',
  expand: 'read',
  collapse: 'read',
  toggle: 'update',
  scrollIntoView: 'read',
  sendKeys: 'update',
  focus: 'read',
  waitForIdle: null,
  screenshot: 'read',
  tree: 'read',
  close: 'update',
  kill: 'destructive',
  diagnoseJava: 'read',
  environment: 'read',
  'com.create': 'read',
  'com.get': 'read',
  'com.set': 'update',
  'com.call': 'update',
  'com.release': null,
  'com.list': 'read',
  'record.start': 'read',
  'record.stop': 'read',
  'record.events': 'read',
  quit: null,
};

/** One request as the line the bridge reads (no line break inside: JSON.stringify escapes them). */
export function encodeRequest(rid: number, command: DesktopCommand): string {
  return JSON.stringify({ rid, ...command });
}

/** Reads one line the bridge printed. A line that is not JSON (a banner, a warning) is `junk`: ignored by the caller. */
export function decodeLine(line: string): BridgeLine {
  let message: { rid: number; ok: boolean; value?: unknown; error?: string; code?: string };
  try {
    message = JSON.parse(line);
  } catch {
    return { kind: 'junk' };
  }
  if (message === null || typeof message !== 'object' || typeof message.rid !== 'number') return { kind: 'junk' };
  if (message.rid === 0) return { kind: 'ready' };
  if (message.ok) return { kind: 'reply', rid: message.rid, ok: true, value: message.value ?? null };
  const code = (BRIDGE_ERROR_CODES as readonly string[]).includes(message.code ?? '') ? (message.code as DesktopErrorCode) : 'ERROR';
  return {
    kind: 'reply',
    rid: message.rid,
    ok: false,
    error: new DesktopTransportError(message.error ?? 'unknown bridge error', code),
  };
}
