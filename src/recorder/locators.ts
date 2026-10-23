import type { PathStep, Target } from '../desktop/recording';
import { quote } from './names';

/**
 * Picks the most stable way to find a recorded control again. The ladder, best first:
 *
 *   1. AutomationId        `.getByAutomationId('RunButton')`
 *   2. Name + control type `.getByRole('Button', { name: 'Run' })`
 *   3. ClassName + position `.locator({ controlType: 'Edit', className: 'JTextField' }).nth(2)`   (Swing controls often have nothing else)
 *   4. nothing             a screen position only: the converter cannot write a locator and says so (TODO(manual)).
 *
 * When a second way exists, it follows as `.orElse(...)`: the framework uses it when the first no longer matches and reports the drift.
 * Positional fallbacks are never added behind a better locator - a wrong control found by position is worse than a clear failure.
 * When the recorder saw that the id or the name matches more than one control, the locator is narrowed by the nearest named ancestor.
 */
export interface Candidate {
  kind: 'automationId' | 'nameAndType' | 'classAndIndex' | 'window';
  /** The call chain to add after the window locator, e.g. `.getByAutomationId('x')`. */
  code: string;
}

export interface LocatorPlan {
  /** Ancestors the control is searched inside (outermost first), as call chains. */
  scope: string[];
  primary: Candidate;
  alternates: Candidate[];
  /** Why a human should look: the locator is weak or may be ambiguous. */
  review?: { severity: 'todo' | 'info'; message: string };
}

export type LocatorResult = { ok: true; plan: LocatorPlan } | { ok: false; reason: string };

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** An automation id that looks assigned by hand, not generated: not a GUID, no long run of digits. */
export function isStableId(id: string | undefined): id is string {
  return !!id && id.trim() !== '' && !GUID.test(id) && !/\d{5,}/.test(id) && id.length <= 80;
}

/** A name that does not look like it holds changing data (a time, a long number, a GUID) and is not absurdly long. */
export function isStableName(name: string | undefined): name is string {
  return !!name && name.trim() !== '' && name.length <= 80 && !GUID.test(name) && !/\b\d{1,2}[:/.]\d{2}([:/.]\d{2,4})?\b/.test(name) && !/\d{6,}/.test(name);
}

function byAutomationId(step: PathStep): Candidate | undefined {
  return isStableId(step.automationId) ? { kind: 'automationId', code: `.getByAutomationId(${quote(step.automationId)})` } : undefined;
}

function byName(step: PathStep): Candidate | undefined {
  if (!isStableName(step.name)) return undefined;
  return { kind: 'nameAndType', code: step.controlType ? `.getByRole(${quote(step.controlType)}, { name: ${quote(step.name)} })` : `.getByName(${quote(step.name)})` };
}

function byClassAndIndex(step: PathStep): Candidate | undefined {
  if (!step.className || step.index === undefined) return undefined;
  const criteria = step.controlType ? `controlType: ${quote(step.controlType)}, className: ${quote(step.className)}` : `className: ${quote(step.className)}`;
  return { kind: 'classAndIndex', code: `.locator({ ${criteria} }).nth(${step.index})` };
}

/** A way to reach an ancestor that can be told apart: a stable automation id, else a name with its control type. */
function scopeStep(step: PathStep): string | undefined {
  return (byAutomationId(step) ?? (step.controlType ? byName(step) : undefined))?.code;
}

export function planLocator(target: Target): LocatorResult {
  const step = target.path[target.path.length - 1];
  if (!step) return { ok: true, plan: { scope: [], primary: { kind: 'window', code: '' }, alternates: [] } };
  const a = byAutomationId(step);
  const n = byName(step);
  const c = byClassAndIndex(step);
  const unique = target.unique ?? {};
  const singles = [a && unique.automationId !== false ? a : undefined, n && unique.nameAndType !== false ? n : undefined].filter((x): x is Candidate => x !== undefined);
  if (singles.length > 0) return { ok: true, plan: { scope: [], primary: singles[0] as Candidate, alternates: singles.slice(1) } };

  // the id and the name (the ones that exist) are not unique in the window: narrow by the nearest ancestor that can be told apart
  const ambiguous = [a, n].filter((x): x is Candidate => x !== undefined);
  if (ambiguous.length > 0) {
    for (let i = target.path.length - 2; i >= 0; i--) {
      const scope = scopeStep(target.path[i] as PathStep);
      if (scope) return { ok: true, plan: { scope: [scope], primary: ambiguous[0] as Candidate, alternates: ambiguous.slice(1) } };
    }
  }
  if (c) {
    return {
      ok: true,
      plan: {
        scope: [],
        primary: c,
        alternates: [],
        review: {
          severity: 'info',
          message: `found by class and position only (${step.controlType ?? 'control'} ${step.className} #${step.index}): the weakest locator - it breaks when the screen gains or loses a control of that kind; give it a name or id in the application if you can`,
        },
      },
    };
  }
  if (ambiguous.length > 0) {
    return {
      ok: true,
      plan: {
        scope: [],
        primary: ambiguous[0] as Candidate,
        alternates: ambiguous.slice(1),
        review: { severity: 'todo', message: 'its name / automation id matches more than one control in the window and nothing around it tells it apart: narrow the locator (chain from a container, or .nth(i)) after checking with sas-desktop-inspect' },
      },
    };
  }
  const where = target.fallbackPoint ? `a screen position (${target.fallbackPoint.x}, ${target.fallbackPoint.y}) in the window` : 'no name, automation id or class to find it by';
  return { ok: false, reason: `the recording only has ${where}` };
}
