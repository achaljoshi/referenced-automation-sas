import { expect, test } from '@playwright/test';
import { DesktopElementNotFoundError } from '../../src/desktop';
import { button, startDemo } from './demoDesktop';

// Auto-waiting: the stand-in delays the appearance and enabling of controls, makes the application busy, and rebuilds trees.

test.describe('actions wait for the control (no sleeps in the test)', () => {
  test('a control that appears 250 ms late is clicked as soon as it is there - not before, not much after', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Late', log, { automationId: 'late', appearAfterMs: 250 })));
    const startedAt = Date.now();
    await d.app.window(/Demo/).getByName('Late').click();
    const took = Date.now() - startedAt;
    expect(d.log).toEqual(['invoked late']);
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(900);
  });

  test('waiting is polling, bounded: a control that never comes costs the timeout and one request per poll, not a flood', async () => {
    const d = await startDemo((w) => void w, { session: { timeoutMs: 300, pollMs: 50 } });
    const before = d.desktop.calls.length;
    const error = (await d.app.window(/Demo/).getByName('Never').click().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/no control matched/);
    const requests = d.desktop.calls.length - before;
    expect(requests).toBeLessThan(60); // ~6 polls x (windows + find ...) + diagnostics
  });

  test('a control that exists but is disabled is waited for until it is enabled; one that stays disabled says so', async () => {
    const d = await startDemo((w, { desktop, log }) => {
      desktop.attach(w, button('Soon', log, { automationId: 'soon', enableAfterMs: 250 }));
      desktop.attach(w, button('Never', log, { automationId: 'never', enabled: false }));
    }, { session: { timeoutMs: 700 } });
    const startedAt = Date.now();
    await d.app.window(/Demo/).getByName('Soon').click();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(240);
    expect(d.log).toEqual(['invoked soon']);
    const error = (await d.app.window(/Demo/).getByName('Never').click().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/is on the screen but stayed disabled for \d+ms/);
    expect(d.log).toEqual(['invoked soon']);
  });

  test('an action waits for the application to be idle BEFORE acting, and again AFTER', async () => {
    const d = await startDemo((w, { desktop, log, process }) => {
      desktop.attach(w, {
        controlType: 'Button',
        name: 'Work',
        automationId: 'work',
        on: {
          invoke: () => {
            log.push(`invoked at ${Date.now()}`);
            desktop.busyFor(process, 250); // the click starts 250 ms of work
          },
        },
      });
    });
    d.desktop.busyFor(d.process, 200); // already busy when the step starts
    const startedAt = Date.now();
    await d.app.window(/Demo/).getByName('Work').click();
    const finishedAt = Date.now();
    const invokedAt = Number((d.log[0] as string).replace('invoked at ', ''));
    expect(invokedAt - startedAt).toBeGreaterThanOrEqual(190); // waited for the application before clicking
    expect(finishedAt - invokedAt).toBeGreaterThanOrEqual(240); // and for the work it started before returning
  });

  test('a hung application is an error naming the process, not a silent hang', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Go', log)), { session: { timeoutMs: 300 } });
    d.desktop.busyFor(d.process, 60_000);
    const error = (await d.app.window(/Demo/).getByName('Go').click().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(new RegExp(`process ${d.process.pid}\\) did not become idle within 300ms`));
    expect(d.log).toEqual([]);
  });

  test('without the pid known to the bridge (no such process) the wait is skipped, and the control wait decides', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Go', log)));
    const real = d.desktop.request.bind(d.desktop);
    d.desktop.request = async (c) => (c.op === 'waitForIdle' ? Promise.reject(Object.assign(new Error('no message loop'), { code: 'ERROR' })) : real(c));
    await d.app.window(/Demo/).getByName('Go').click();
    expect(d.log).toEqual(['invoked Go']);
  });
});

test.describe('NOT_FOUND mid-transition is retried (bounded)', () => {
  test('a control whose handle goes stale twice (the application rebuilt its tree) is resolved again and the step succeeds once', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Go', log, { automationId: 'go' })));
    d.desktop.injectStale(2);
    await d.app.window(/Demo/).getByName('Go').click();
    expect(d.log).toEqual(['invoked go']); // clicked exactly once
    expect(d.desktop.calls.filter((c) => c.op === 'click')).toHaveLength(3); // two attempts that found the handle stale, one that worked
  });

  test('a control that keeps vanishing is an error after a bounded number of rounds - not an endless loop', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Go', log)), { session: { retryRounds: 3 } });
    d.desktop.injectStale(1000);
    const startedAt = Date.now();
    const error = (await d.app.window(/Demo/).getByName('Go').click().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/kept disappearing while it was being used \(3 attempts\)/);
    expect(d.desktop.calls.filter((c) => c.op === 'click')).toHaveLength(3);
    expect(d.log).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  test('a window that closes under the step is not found any more: the error says what is on the screen instead of hanging', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Go', log)), { session: { timeoutMs: 300 } });
    const go = d.app.window(/Demo/).getByName('Go');
    expect(await go.exists()).toBe(true);
    d.desktop.dispose(d.window);
    const error = (await go.click().catch((e: unknown) => e)) as DesktopElementNotFoundError;
    expect(error).toBeInstanceOf(DesktopElementNotFoundError);
    expect(error.screen).toMatch(/no window of process/);
  });
});

test.describe('a locked desktop', () => {
  test('is SESSION_LOST at once - not retried, not waited for', async () => {
    const d = await startDemo((w, { desktop, log }) => desktop.attach(w, button('Go', log)));
    d.desktop.lock();
    const startedAt = Date.now();
    const error = (await d.app.window(/Demo/).getByName('Go').click().catch((e: unknown) => e)) as Error & { cause?: { code?: string } };
    expect(error.cause?.code ?? (error as unknown as { code?: string }).code).toBe('SESSION_LOST');
    expect(error.message).toMatch(/locked or the session is disconnected/);
    expect(Date.now() - startedAt).toBeLessThan(500);
    d.desktop.unlock();
    await d.app.window(/Demo/).getByName('Go').click();
    expect(d.log).toEqual(['invoked Go']);
  });
});

test('fill, select, expand, check and press wait for their control too, and check() twice is safe', async () => {
  const d = await startDemo((w, { desktop, log }) => {
    desktop.attach(w, { controlType: 'Edit', name: 'Name:', value: '', appearAfterMs: 120, on: { setValue: (_e, t) => void log.push(`typed ${t}`) } });
    desktop.attach(w, { controlType: 'CheckBox', name: 'Remember', toggle: 'Off', appearAfterMs: 120, on: { toggle: () => void log.push('toggled') } });
    desktop.attach(w, { controlType: 'TreeItem', name: 'Node', expand: 'Collapsed', selectable: true, appearAfterMs: 120, on: { select: () => void log.push('selected'), expand: () => void log.push('expanded') } });
    w.on.keys = (_el, keys) => void log.push(`keys ${keys}`);
  });
  const win = d.app.window(/Demo/);
  await win.getByName('Name:').fill('hello', { verify: true });
  await win.getByName('Remember').check();
  await win.getByName('Remember').check(); // already on: nothing happens
  await win.getByName('Node').select();
  await win.getByName('Node').expand();
  await win.getByName('Node').expand(); // already expanded
  await win.press('{ENTER}');
  expect(d.log).toEqual(['typed hello', 'toggled', 'selected', 'expanded', 'keys {ENTER}']);
  expect(await win.getByName('Remember').isChecked()).toBe(true);
  await win.getByName('Remember').uncheck();
  expect(await win.getByName('Remember').isChecked()).toBe(false);
  await expect(win.getByName('Name:').fill('x', { verify: true })).resolves.toBeUndefined();
});

test('fill with verify fails when the control kept something else', async () => {
  const d = await startDemo((w, { desktop }) => {
    const edit = desktop.attach(w, { controlType: 'Edit', name: 'Code:', value: '' });
    edit.on.setValue = (el) => {
      el.value = 'TRUNCATED'; // the application rewrites what was typed
    };
  });
  await expect(d.app.window(/Demo/).getByName('Code:').fill('abcdef', { verify: true })).rejects.toThrow(/did not keep the value: it holds "TRUNCATED" after typing "abcdef"/);
});
