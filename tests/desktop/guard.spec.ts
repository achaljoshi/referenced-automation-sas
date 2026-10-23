import { expect, test } from '@playwright/test';
import { guarded, insideAuthorizedOperation, permissiveGuard, type GuardedOperation, type GuardedResult, type OperationGuard } from '../../src/desktop';
import { button, startDemo } from './demoDesktop';

function recordingGuard(deny?: (op: GuardedOperation) => boolean): OperationGuard & { asked: GuardedOperation[]; results: GuardedResult[] } {
  const asked: GuardedOperation[] = [];
  const results: GuardedResult[] = [];
  return {
    asked,
    results,
    authorize(op) {
      asked.push(op);
      if (deny?.(op)) throw new Error(`policy: ${op.driver}.${op.operation} on ${String(op.target)} refused`);
    },
    record: (r) => void results.push(r),
  };
}

const build = () => (w: Parameters<Parameters<typeof startDemo>[0]>[0], { desktop, log }: Parameters<Parameters<typeof startDemo>[0]>[1]) => {
  desktop.attach(w, button('Save', log, { automationId: 'save' }));
  desktop.attach(w, { controlType: 'Edit', name: 'Name:', value: '' });
  desktop.attach(w, { controlType: 'CheckBox', name: 'Flag', toggle: 'Off' });
  desktop.attach(w, { controlType: 'TreeItem', name: 'Node', selectable: true, expand: 'Collapsed' });
};

test.describe('the OperationGuard is consulted for mutating operations', () => {
  test('each action asks first with its kind, the driver and a description of its target; the outcome is recorded', async () => {
    const guard = recordingGuard();
    const d = await startDemo(build(), { session: { guard } });
    const win = d.app.window(/Demo/);
    await win.getByName('Save').click();
    await win.getByName('Name:').fill('x');
    await win.getByName('Flag').check();
    await win.getByName('Node').select();
    await win.getByName('Node').expand();
    await win.press('{ENTER}');
    const seen = guard.asked.filter((a) => !['launch'].includes(a.operation)).map((a) => `${a.operation}:${a.kind}`);
    expect(seen).toEqual(['click:update', 'fill:update', 'check:update', 'select:read', 'expand:read', 'press:update']);
    expect(guard.asked.find((a) => a.operation === 'click')).toMatchObject({ driver: 'desktop-ui', target: 'window /Demo/ > control named "Save"', local: true });
    expect(guard.results.filter((r) => r.operation !== 'launch').map((r) => r.outcome)).toEqual(Array(6).fill('ok'));
    expect(guard.results.every((r) => r.durationMs >= 0 && r.op !== undefined)).toBe(true);
  });

  test('reads do not ask: exists, count, text, info, snapshot, windows, waitFor', async () => {
    const guard = recordingGuard();
    const d = await startDemo(build(), { session: { guard } });
    const before = guard.asked.length;
    const win = d.app.window(/Demo/);
    await win.getByName('Save').exists();
    await win.getByName('Save').count();
    await win.getByName('Name:').text();
    await win.getByName('Name:').info();
    await win.getByName('Name:').snapshot();
    await win.getByName('Save').waitFor();
    await d.app.windows();
    expect(guard.asked.length).toBe(before);
  });

  test('a refusal stops the step before the application is touched, is recorded as denied, and reaches the caller unchanged', async () => {
    const guard = recordingGuard((op) => op.operation === 'click' || op.operation === 'fill');
    const d = await startDemo(build(), { session: { guard } });
    const win = d.app.window(/Demo/);
    const before = d.desktop.calls.length;
    await expect(win.getByName('Save').click()).rejects.toThrow(/policy: desktop-ui.click on window \/Demo\/ > control named "Save" refused/);
    await expect(win.getByName('Name:').fill('x')).rejects.toThrow(/policy: desktop-ui.fill/);
    expect(d.desktop.calls.length).toBe(before); // not one request reached the bridge
    expect(d.log).toEqual([]);
    expect(guard.results.filter((r) => r.outcome === 'denied').map((r) => r.operation)).toEqual(['click', 'fill']);
    await win.getByName('Flag').check(); // other operations still work
  });

  test('a step that fails is recorded as error', async () => {
    const guard = recordingGuard();
    const d = await startDemo(build(), { session: { guard, timeoutMs: 150 } });
    await expect(d.app.window(/Demo/).getByName('Missing').click()).rejects.toThrow();
    expect(guard.results.at(-1)).toMatchObject({ operation: 'click', outcome: 'error' });
  });

  test('closing a window is an update and killing a process is destructive; launching and attaching are reads', async () => {
    const guard = recordingGuard();
    const d = await startDemo(build(), { session: { guard } });
    await d.app.close({ force: true, timeoutMs: 200 });
    const kinds = guard.asked.map((a) => `${a.operation}:${a.kind}`);
    expect(kinds[0]).toBe('launch:read');
    expect(kinds).toContain('closeWindow:update');
    const attached = await d.session.attach({ processName: 'demo' }).catch(() => undefined);
    void attached;
    expect(guard.asked.some((a) => a.operation === 'attach' && a.kind === 'read')).toBe(true);
  });

  test('kill is destructive and denied kills nothing', async () => {
    const guard = recordingGuard((op) => op.kind === 'destructive');
    const d = await startDemo(build(), { session: { guard } });
    await expect(d.app.kill()).rejects.toThrow(/policy/);
    expect(d.process.alive).toBe(true);
    expect(guard.asked.at(-1)).toMatchObject({ operation: 'kill', kind: 'destructive' });
  });

  test('a higher-level operation is judged ONCE: the low-level steps inside it do not ask again', async () => {
    const guard = recordingGuard();
    await guarded(guard, { driver: 'sas-eg', operation: 'logon', kind: 'read' }, async () => {
      expect(insideAuthorizedOperation()).toBe(true);
      await guarded(guard, { driver: 'desktop-ui', operation: 'click', kind: 'update' }, async () => undefined);
      await guarded(guard, { driver: 'desktop-ui', operation: 'fill', kind: 'update' }, async () => undefined);
    });
    expect(insideAuthorizedOperation()).toBe(false);
    expect(guard.asked.map((a) => a.operation)).toEqual(['logon']);
    expect(guard.results).toHaveLength(1);
    // and a refusal of the outer operation never lets the inner ones run
    const deny = recordingGuard(() => true);
    let ran = false;
    await expect(guarded(deny, { driver: 'x', operation: 'outer', kind: 'update' }, async () => void (ran = true))).rejects.toThrow(/policy/);
    expect(ran).toBe(false);
  });

  test('the default guard allows everything and records nothing', async () => {
    expect(await permissiveGuard.authorize({ driver: 'x', operation: 'y', kind: 'destructive' })).toBeUndefined();
    expect(permissiveGuard.record({ operation: 'y', outcome: 'ok', durationMs: 1 })).toBeUndefined();
    const d = await startDemo(build());
    await d.app.window(/Demo/).getByName('Save').click();
    expect(d.log).toEqual(['invoked save']);
  });
});
