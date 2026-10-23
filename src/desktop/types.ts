/**
 * The vocabulary of the Windows desktop layer: what a bridge is asked to do (DesktopCommand) and what it answers.
 *
 * NOT VERIFIED on a real Windows host with the real SAS desktop applications: the PowerShell bridge
 * (bridge/sas-desktop-bridge.ps1) has never run on Windows from this repository's machine. Everything above the transport is
 * exercised against the in-memory stand-in (fakeDesktop.ts).
 */

/** A rectangle in physical screen pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One UI Automation element as the bridge reports it. `ref` is an opaque handle valid while the element lives: the bridge answers
 * NOT_FOUND for a handle whose element is gone (a closed dialog, a re-built tree), and the locator then resolves again.
 *
 * `find`, `children`, `windows` and `tree` return the light fields only; `info` adds value / states / patterns; `tree` adds `depth`.
 */
export interface ElementInfo {
  ref: string;
  name: string;
  automationId: string;
  /** UIA control type without the "ControlType." prefix: Button, Edit, Tree, TreeItem, Window, ... */
  controlType: string;
  className: string;
  enabled: boolean;
  offscreen: boolean;
  /** True for a password field. Its value is never read, listed or drawn into a screenshot. */
  isPassword: boolean;
  rect?: Rect;
  pid?: number;
  // ---- `info` only ----
  /** ValuePattern value (empty for a password field - never read). Absent when the control has no ValuePattern. */
  value?: string;
  focused?: boolean;
  toggleState?: 'On' | 'Off' | 'Indeterminate';
  /** SelectionItemPattern.IsSelected. */
  selected?: boolean;
  expandState?: 'Collapsed' | 'Expanded' | 'PartiallyExpanded' | 'LeafNode';
  /** The names of the UIA patterns the element supports (Invoke, Value, Toggle, ...). */
  patterns?: string[];
}

/** A top-level window: an element plus the process that owns it. */
export interface WindowInfo extends ElementInfo {
  /** The process name without ".exe". */
  process: string;
  /** The native window handle (HWND) as a number; 0 when unknown. */
  hwnd: number;
}

/** One node of a `tree` dump: the element and how deep it sits below the root of the dump. */
export interface TreeNode extends ElementInfo {
  depth: number;
}

/**
 * How to find elements below a root. Every field that is given must match (AND). Strings match exactly unless the field says
 * otherwise; `name` is case-sensitive.
 */
export interface FindCriteria {
  name?: string;
  /** Case-insensitive "contains" on the name. */
  nameContains?: string;
  nameRegex?: { pattern: string; ignoreCase: boolean };
  automationId?: string;
  /** Exact, case-insensitive, with or without the "ControlType." prefix. */
  controlType?: string;
  className?: string;
  /** Case-insensitive "contains" on the element's value (ValuePattern) or, without one, its name. */
  text?: string;
  /** Only the n-th match (0-based) in document order. */
  nth?: number;
  /** 'descendants' (default) or only the direct 'children'. */
  scope?: 'descendants' | 'children';
  /** Skip elements UI Automation reports as off-screen. */
  visibleOnly?: boolean;
}

export interface WindowFilter {
  pid?: number;
  processName?: string;
  /** Matched by the bridge with a .NET regular expression (case-insensitive). */
  titleRegex?: string;
}

/** A COM object the bridge holds, referred to by handle. */
export interface ComRef {
  __com: string;
}

/** What crosses the line protocol for COM arguments and results: primitives, arrays and COM object handles. */
export type ComValue = null | string | number | boolean | ComRef | ComValue[];

/**
 * Everything the framework ever asks the desktop bridge to do, as plain data. The names are the contract with
 * bridge/sas-desktop-bridge.ps1: tests/desktop/protocol.spec.ts fails when the two drift apart (see DESKTOP_OPS in bridgeProtocol.ts).
 */
export type DesktopCommand =
  | { op: 'ping' }
  | ({ op: 'windows' } & WindowFilter)
  | { op: 'launch'; path: string; args?: string[]; cwd?: string; waitForWindow?: { titleRegex?: string; timeoutMs?: number } }
  | ({ op: 'attach' } & WindowFilter)
  | { op: 'find'; root?: string | null; criteria: FindCriteria; limit?: number }
  | { op: 'children'; ref: string }
  | { op: 'info'; ref: string }
  | { op: 'invoke'; ref: string }
  | { op: 'click'; ref: string }
  | { op: 'doubleClick'; ref: string }
  | { op: 'rightClick'; ref: string }
  | { op: 'setText'; ref: string; text: string; secret?: boolean }
  | { op: 'getText'; ref: string }
  | { op: 'select'; ref: string; add?: boolean }
  | { op: 'expand'; ref: string }
  | { op: 'collapse'; ref: string }
  | { op: 'toggle'; ref: string; state?: boolean }
  | { op: 'scrollIntoView'; ref: string }
  | { op: 'sendKeys'; ref?: string; keys: string; secret?: boolean }
  | { op: 'focus'; ref: string }
  | { op: 'waitForIdle'; pid?: number; timeoutMs?: number }
  | { op: 'screenshot'; ref?: string }
  | { op: 'tree'; ref?: string | null; depth?: number; maxNodes?: number; pid?: number }
  | { op: 'close'; ref: string }
  | { op: 'kill'; pid?: number; processName?: string }
  | { op: 'diagnoseJava'; pid?: number }
  | { op: 'environment' }
  | { op: 'com.create'; progId: string }
  | { op: 'com.get'; handle: string; path?: string }
  | { op: 'com.set'; handle: string; path: string; value: ComValue; secret?: boolean }
  | { op: 'com.call'; handle: string; method: string; args?: ComValue[]; secret?: boolean }
  | { op: 'com.release'; handle: string }
  | { op: 'com.list'; prefix?: string }
  | ({ op: 'record.start'; mode?: 'full' | 'uia'; maxQueue?: number; secretPatterns?: string[]; stopKey?: string } & WindowFilter)
  | { op: 'record.stop' }
  | { op: 'record.events'; drain?: boolean }
  | { op: 'quit' };

export type DesktopOp = DesktopCommand['op'];

export interface LaunchResult {
  /** The pid of the process that owns the window the launch waited for (may differ from the started process: a launcher starts javaw). */
  pid: number;
  process: string;
  window?: WindowInfo;
}

export interface AttachResult {
  pid: number;
  process: string;
  window: WindowInfo;
}

export interface ScreenshotResult {
  pngBase64: string;
  width: number;
  height: number;
}

export interface PingResult {
  bridge: string;
  version: number;
  powershell?: string;
  is64BitProcess?: boolean;
  pid?: number;
}

/** What `diagnoseJava` found for one top-level Java window. */
export interface JavaWindowDiagnosis {
  title: string;
  pid: number;
  process: string;
  className: string;
  /** Looks like a Java (AWT / Swing / SWT) window: class SunAwt*, a javaw / java / sasmc process. */
  isJava: boolean;
  /** Elements found below the window apart from its native title bar (capped). */
  elementCount: number;
  /** A Java window whose UI Automation subtree is empty or tiny: the Java Access Bridge symptom. */
  suspectedBridgeMissing: boolean;
}

export interface JavaDiagnosis {
  windows: JavaWindowDiagnosis[];
  /** WindowsAccessBridge-64.dll is present in System32 (a Java runtime with the access bridge is installed). */
  accessBridgeDll: boolean;
  /** %USERPROFILE%\.accessibility.properties has the assistive_technologies line that `jabswitch -enable` writes. */
  accessibilityProperties: boolean;
}

/** What the bridge's `environment` op reports: the facts `doctor` checks. */
export interface EnvironmentInfo {
  powershell: string;
  is64BitProcess: boolean;
  is64BitOS: boolean;
  os: string;
  userInteractive: boolean;
  sessionName: string;
  /** False when the workstation is locked or the session is disconnected. */
  desktopAccessible: boolean;
  uiaAvailable: boolean;
  topLevelWindows: number;
  elevated: boolean;
  accessBridgeDll: boolean;
  accessibilityProperties: boolean;
  /** Paths of jabswitch.exe found (the tool that enables the Java Access Bridge). */
  jabswitch: string[];
  allowedProgIds: string[];
}

/**
 * The seam between the framework and the desktop. Production uses PowerShellTransport / RemoteTransport (the PowerShell bridge);
 * tests use FakeDesktop. Anything implementing this interface works.
 */
export interface DesktopTransport {
  request(command: DesktopCommand): Promise<unknown>;
  close(): Promise<void>;
}

export type DesktopErrorCode = 'NOT_FOUND' | 'SESSION_LOST' | 'ERROR' | 'TIMEOUT' | 'BRIDGE_EXITED' | 'DENIED' | 'NOT_IMPLEMENTED';

/**
 * Thrown by a transport when the desktop (or the bridge) reports a failure. `code`:
 *  - NOT_FOUND       the element handle / window / process / COM class does not exist (any more): the one code the session retries
 *  - SESSION_LOST    the application is gone (its process ended, the desktop is locked or disconnected, the COM server died): retrying is pointless
 *  - DENIED          the bridge refused on purpose (a COM class outside the allow-list, killing a process it did not start)
 *  - NOT_IMPLEMENTED the operation is not available in this bridge (an older bridge that predates the recorder answers it for record.start / record.stop / record.events)
 *  - TIMEOUT         the bridge did not answer in time; the transport kills the bridge, so every later request fails fast
 *  - BRIDGE_EXITED   the bridge process is gone (crashed, killed, pipe closed)
 *  - ERROR           anything else
 */
export class DesktopTransportError extends Error {
  constructor(
    message: string,
    readonly code: DesktopErrorCode = 'ERROR',
  ) {
    super(message);
    this.name = 'DesktopTransportError';
  }
}
