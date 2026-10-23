import { expect, test } from '@playwright/test';
import { isStableId, isStableName, planLocator, type Target } from '../../src/recorder';
import { step, target, win } from './support/events';

const plan = (t: Target) => {
  const result = planLocator(t);
  if (!result.ok) throw new Error(`expected a plan: ${result.reason}`);
  return result.plan;
};
const W = 'Dialog';

test.describe('the ladder: AutomationId > Name + type > ClassName + position > nothing', () => {
  test('an automation id comes first, the name and type follow as the .orElse fallback', () => {
    const p = plan(target(W, step.button('OK', { automationId: 'okButton' })));
    expect(p.primary).toEqual({ kind: 'automationId', code: ".getByAutomationId('okButton')" });
    expect(p.alternates).toEqual([{ kind: 'nameAndType', code: ".getByRole('Button', { name: 'OK' })" }]);
    expect(p.scope).toEqual([]);
    expect(p.review).toBeUndefined();
  });

  test('a name and a control type alone; a name without a type; no fallback behind it', () => {
    expect(plan(target(W, step.button('OK'))).primary.code).toBe(".getByRole('Button', { name: 'OK' })");
    expect(plan(target(W, { name: 'OK' })).primary.code).toBe(".getByName('OK')");
    expect(plan(target(W, step.button('OK'))).alternates).toEqual([]);
  });

  test('class and position are the third rung - alone, and never added behind a better locator', () => {
    const swing = plan(target(W, { controlType: 'Edit', className: 'JTextField', index: 2 }));
    expect(swing.primary).toEqual({ kind: 'classAndIndex', code: ".locator({ controlType: 'Edit', className: 'JTextField' }).nth(2)" });
    expect(swing.review).toMatchObject({ severity: 'info', message: expect.stringMatching(/weakest locator/) });
    const named = plan(target(W, step.edit('Name:', { className: 'JTextField', index: 2 })));
    expect(named.primary.kind).toBe('nameAndType');
    expect(named.alternates).toEqual([]); // no positional fallback behind a good locator
    expect(plan(target(W, { className: 'JTextField', index: 0 })).primary.code).toBe(".locator({ className: 'JTextField' }).nth(0)");
  });

  test('a screen position alone cannot be a locator: the reason says where the pointer was', () => {
    const result = planLocator({ ...target(W, { controlType: 'Pane' }), fallbackPoint: { x: 212, y: 340 } });
    expect(result).toEqual({ ok: false, reason: 'the recording only has a screen position (212, 340) in the window' });
    expect(planLocator(target(W, {}))).toEqual({ ok: false, reason: 'the recording only has no name, automation id or class to find it by' });
    expect(planLocator(target(W, { className: 'JPanel' }))).toMatchObject({ ok: false }); // a class without a position is not enough either
  });

  test('a click on the window itself needs no step', () => {
    expect(plan(target(W)).primary).toEqual({ kind: 'window', code: '' });
  });

  test('ids and names that look generated or hold changing data are not used', () => {
    for (const id of ['', 'a1b2c3d4-0000-4000-8000-123456789abc', 'button1234567', undefined]) expect(isStableId(id), String(id)).toBe(false);
    for (const id of ['okButton', '1148', 'PART_Close', 'RunButton']) expect(isStableId(id), id).toBe(true);
    for (const name of ['', 'Run at 10:45', 'Order 20261023123456', 'x'.repeat(81), undefined]) expect(isStableName(name), String(name)).toBe(false);
    for (const name of ['OK', 'User ID:', 'Sales (2026)', 'Project 5']) expect(isStableName(name), name).toBe(true);
    expect(plan(target(W, step.button('OK', { automationId: 'btn12345678' }))).primary.kind).toBe('nameAndType'); // the id is skipped, the name used
    expect(planLocator(target(W, { controlType: 'Button', name: 'Run at 10:45' }))).toMatchObject({ ok: false });
  });
});

test.describe('when the id or the name is not unique in the window', () => {
  test('the recorder\'s "not unique" is believed: the other one is used, else the nearest named ancestor narrows it', () => {
    const base = target(W, step.button('OK', { automationId: 'ok' }));
    expect(plan({ ...base, unique: { automationId: false } }).primary.kind).toBe('nameAndType');
    expect(plan({ ...base, unique: { nameAndType: false } }).primary.kind).toBe('automationId');
    const scoped = plan({ ...target(W, { controlType: 'Pane', name: 'Details' }, step.button('OK')), unique: { nameAndType: false } });
    expect(scoped.scope).toEqual([".getByRole('Pane', { name: 'Details' })"]);
    expect(scoped.primary.code).toBe(".getByRole('Button', { name: 'OK' })");
    const byId = plan({ ...target(W, { controlType: 'Pane', automationId: 'detailsPane' }, step.button('OK')), unique: { nameAndType: false } });
    expect(byId.scope).toEqual([".getByAutomationId('detailsPane')"]);
  });

  test('the nearest ancestor that can be told apart wins; an unnamed one is skipped', () => {
    const t = { ...target(W, { controlType: 'Pane', name: 'Outer' }, { controlType: 'Pane' }, { controlType: 'Pane', name: 'Inner' }, step.button('OK')), unique: { nameAndType: false } };
    expect(plan(t).scope).toEqual([".getByRole('Pane', { name: 'Inner' })"]);
    const unnamed = { ...target(W, { controlType: 'Pane' }, step.button('OK')), unique: { nameAndType: false } };
    expect(plan(unnamed).review).toMatchObject({ severity: 'todo', message: expect.stringMatching(/matches more than one control/) });
  });

  test('with nothing to narrow by it falls back to class and position when it has them', () => {
    const t = { ...target(W, step.button('OK', { className: 'JButton', index: 1 })), unique: { nameAndType: false } };
    expect(plan(t).primary.kind).toBe('classAndIndex');
  });
});

test.describe('quoting', () => {
  test('a name with quotes and backslashes cannot break the locator', () => {
    const p = plan(target(win('x').titlePattern, step.edit("O'Brien \\ \"x\"")));
    expect(p.primary.code).toBe(".getByRole('Edit', { name: 'O\\'Brien \\\\ \"x\"' })");
    expect(() => new Function('w', `return w${p.primary.code};`)).not.toThrow(); // still one valid JavaScript expression
  });
});
