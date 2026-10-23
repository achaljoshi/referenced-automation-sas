import { SMC_LOCATORS } from './apps/managementConsole';
import { EG_UI_LOCATORS } from './apps/enterpriseGuideUi';
import { titleMatcher } from './locator';
import type { DesktopSession } from './session';
import type { TreeNode, WindowInfo } from './types';

/**
 * The way users adapt the LOCATORS tables to their SAS version: list what UI Automation sees and print, for every control, a locator to
 * paste. Never prints a password: a password field is marked and nothing it holds is read (the bridge's `tree` has no values at all).
 */

/** The value of `--app`: a shortcut for one of the two SAS programs, or a window title regular expression. */
export function windowPatternFor(app: string): RegExp {
  if (app === 'smc') return SMC_LOCATORS.windows.launch;
  if (app === 'eg') return EG_UI_LOCATORS.windows.launch;
  try {
    return new RegExp(app, 'i');
  } catch {
    throw new Error(`--app must be "smc", "eg" or a regular expression for a window title (found "${app}")`);
  }
}

const q = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A locator expression that finds this control from its window: the most stable property first (automation id, then role + name, then name, then class). */
export function locatorFor(node: Pick<TreeNode, 'automationId' | 'name' | 'controlType' | 'className'>): string {
  if (node.automationId) return `.getByAutomationId(${q(node.automationId)})`;
  if (node.name && node.controlType) return `.getByRole(${q(node.controlType)}, { name: ${q(node.name)} })`;
  if (node.name) return `.getByName(${q(node.name)})`;
  if (node.controlType && node.className) return `.getByRole(${q(node.controlType)}).getByClassName(${q(node.className)})`;
  if (node.controlType) return `.getByRole(${q(node.controlType)})`;
  return '(no name, id or type: use a container and .nth(i))';
}

export interface InspectedWindow {
  window: WindowInfo;
  nodes: TreeNode[];
}

export async function inspectWindows(session: DesktopSession, titlePattern: RegExp, depth = 6, maxNodes = 600): Promise<InspectedWindow[]> {
  const matcher = titleMatcher(titlePattern);
  const windows = (await session.listWindows()).filter((w) => matcher.test(w.name));
  const out: InspectedWindow[] = [];
  for (const window of windows) {
    const nodes = (await session.send({ op: 'tree', ref: window.ref, depth, maxNodes })) as TreeNode[];
    out.push({ window, nodes });
  }
  return out;
}

/** One line per control, indented by depth. */
export function formatInspection(inspected: InspectedWindow[]): string {
  if (inspected.length === 0) return 'No window matches. List what is open with: sas-desktop-inspect windows';
  const lines: string[] = [];
  for (const { window, nodes } of inspected) {
    lines.push(`WINDOW "${window.name}"  process ${window.process} (pid ${window.pid ?? '?'})  class ${window.className || '-'}  ->  window(${q(window.name)})`);
    if (nodes.every((n) => n.controlType === 'TitleBar')) {
      lines.push('  (no controls visible to UI Automation. For a Java program such as Management Console this is the Java Access Bridge symptom: run `sas-desktop-inspect doctor`)');
    }
    for (const n of nodes) {
      const flags = [n.isPassword ? 'PASSWORD FIELD - value never read' : '', n.enabled ? '' : 'disabled', n.offscreen ? 'offscreen' : ''].filter(Boolean).join(', ');
      lines.push(
        `${'  '.repeat(n.depth + 1)}${n.controlType.padEnd(12)} name=${JSON.stringify(n.name)} id=${JSON.stringify(n.automationId)} class=${JSON.stringify(n.className)}${flags ? `  [${flags}]` : ''}  ->  ${locatorFor(n)}`,
      );
    }
  }
  return lines.join('\n');
}

/** `windows`: every top-level window and dialog with its process. */
export function formatWindows(windows: WindowInfo[]): string {
  if (windows.length === 0) return 'No windows are visible to UI Automation (is the desktop locked or disconnected?).';
  return windows.map((w) => `pid ${String(w.pid ?? '?').padEnd(6)} ${w.process.padEnd(18)} ${JSON.stringify(w.name)}  class=${w.className || '-'}`).join('\n');
}
