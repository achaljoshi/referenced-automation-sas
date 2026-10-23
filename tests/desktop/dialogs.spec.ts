import { expect, test } from '@playwright/test';
import { button, startDemo } from './demoDesktop';

/** A window "Notice" with a Close button, shown over the demo window. */
function showNotice(d: Awaited<ReturnType<typeof startDemo>>, title = 'Notice'): void {
  const notice = d.desktop.addWindow(d.process, { title });
  d.desktop.attach(notice, { controlType: 'Button', name: 'Close', on: { invoke: () => d.desktop.dispose(notice) } });
}

const build = (w: Parameters<Parameters<typeof startDemo>[0]>[0], { desktop, log }: Parameters<Parameters<typeof startDemo>[0]>[1]) => desktop.attach(w, button('Go', log, { automationId: 'go' }));

test.describe('dialog handlers (app.onDialog)', () => {
  test('a dialog in front of a step is handled first, then the step runs', async () => {
    const d = await startDemo(build);
    const handled: string[] = [];
    d.app.onDialog(/^Notice$/, async (dialog) => {
      handled.push('notice');
      await dialog.getByRole('Button', { name: 'Close' }).click();
    });
    showNotice(d);
    await d.app.window(/Demo/).getByName('Go').click();
    expect(handled).toEqual(['notice']);
    expect(d.log).toEqual(['invoked go']);
    expect(await d.app.window('Notice').exists()).toBe(false);
  });

  test('without a handler the dialog stays and is just another window: nothing dismisses it by itself', async () => {
    const d = await startDemo(build);
    showNotice(d);
    await d.app.window(/Demo/).getByName('Go').click();
    expect(await d.app.window('Notice').exists()).toBe(true);
  });

  test('`times` limits how often a handler fires, and the function it returns removes it', async () => {
    const d = await startDemo(build);
    let fired = 0;
    const off = d.app.onDialog(/Notice/, async (dialog) => {
      fired++;
      await dialog.getByName('Close').click();
    }, { times: 1 });
    showNotice(d, 'Notice 1');
    await d.app.window(/Demo/).getByName('Go').click();
    showNotice(d, 'Notice 2'); // the handler has used up its one time
    await d.app.window(/Demo/).getByName('Go').click();
    expect(fired).toBe(1);
    expect(await d.app.window('Notice 2').exists()).toBe(true);
    const off2 = d.app.onDialog(/Notice 2/, async (dialog) => {
      fired += 10;
      await dialog.getByName('Close').click();
    });
    off2();
    await d.app.window(/Demo/).getByName('Go').click();
    expect(fired).toBe(1);
    off();
  });

  test('a step aimed AT a window that has a handler is not intercepted (the test may want to look at that dialog)', async () => {
    const d = await startDemo(build);
    let fired = 0;
    d.app.onDialog(/^Notice$/, async () => void fired++);
    showNotice(d);
    await d.app.window('Notice').getByName('Close').click(); // the step is about the notice itself
    expect(fired).toBe(0);
    expect(await d.app.window('Notice').exists()).toBe(false);
  });

  test('a handler that raises an error fails the step with that error, and later steps are not stuck in "handling"', async () => {
    const d = await startDemo(build);
    d.app.onDialog(/Notice/, async () => {
      throw new Error('handler blew up');
    }, { times: 1 });
    showNotice(d);
    await expect(d.app.window(/Demo/).getByName('Go').click()).rejects.toThrow(/handler blew up/);
    d.app.clearDialogHandlers();
    await d.app.window(/Demo/).getByName('Go').click();
    expect(d.log).toEqual(['invoked go']);
  });

  test('handlers for several dialogs in a row each run (up to five)', async () => {
    const d = await startDemo(build);
    const order: string[] = [];
    d.app.onDialog(/^N\d$/, async (dialog) => {
      order.push(await dialog.title());
      await dialog.getByName('Close').click();
    });
    for (const n of ['N1', 'N2', 'N3']) showNotice(d, n);
    await d.app.window(/Demo/).getByName('Go').click();
    expect(order).toHaveLength(3);
    expect(d.log).toEqual(['invoked go']);
  });
});

test.describe('closing and ending applications', () => {
  test('close() closes every window, answering a "save changes?" prompt through the handler, and waits until the program is gone', async () => {
    const d = await startDemo((w, { desktop }) => {
      w.on.close = (el) => {
        const prompt = desktop.addWindow(d.process, { title: 'Save changes?' });
        desktop.attach(prompt, { controlType: 'Button', name: 'No', on: { invoke: () => { desktop.dispose(prompt); desktop.dispose(el); } } });
      };
    });
    d.app.onDialog(/Save changes/, async (dialog) => dialog.getByName('No').click());
    await d.app.close({ timeoutMs: 2000 });
    expect(await d.app.windows()).toEqual([]);
  });

  test('close() with an unanswered prompt says which window is still open; force kills the process', async () => {
    const d = await startDemo((w, { desktop }) => {
      w.on.close = () => void desktop.addWindow(d.process, { title: 'Really quit?' });
    });
    const error = (await d.app.close({ timeoutMs: 200 }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/still has \d+ window\(s\) open after 200ms.*"Really quit\?"/s);
    expect(error.message).toMatch(/app\.onDialog/);
    await d.app.close({ force: true, timeoutMs: 200 });
    expect(d.process.alive).toBe(false);
    expect(d.desktop.windows).toHaveLength(0);
  });

  test('dispose() also stops a launched program that has no window left (after a cancelled logon) - it used to be left running', async () => {
    const d = await startDemo(build);
    for (const window of [...d.desktop.windows]) d.desktop.dispose(window); // the program's last window is gone but the process lives on
    expect(d.process.alive).toBe(true);
    await d.app.dispose();
    expect(d.process.alive).toBe(false);
  });

  test('dispose() closes a program this framework started, and never one it only attached to', async () => {
    const d = await startDemo(build);
    const attached = await d.session.attach({ processName: 'demo' });
    expect(attached.launched).toBe(false);
    await attached.dispose();
    expect(d.process.alive).toBe(true); // somebody else's program: left alone
    await d.app.dispose();
    expect(d.process.alive).toBe(false);
  });

  test('kill is refused by the bridge for a process it did not start or attach to', async () => {
    const d = await startDemo(build);
    const stranger = d.desktop.addProcess('stranger');
    await expect(d.session.send({ op: 'kill', pid: stranger.pid })).rejects.toMatchObject({ code: 'DENIED' });
    expect(stranger.alive).toBe(true);
    await expect(d.session.send({ op: 'kill', processName: 'stranger' })).rejects.toMatchObject({ code: 'DENIED' });
  });
});

test.describe('launch and attach', () => {
  test('launch waits for the window by title (a launcher whose window belongs to another process still works) and reports the window\'s process', async () => {
    const d = await startDemo(build);
    expect(d.app.process).toBe('demo');
    expect(d.app.launched).toBe(true);
    await expect(d.session.launch({ path: 'C:\\no\\such.exe' })).rejects.toThrow(/does not exist/);
  });

  test('launch fails with a TIMEOUT-style message when no window shows up', async () => {
    const d = await startDemo(build);
    await expect(d.session.launch({ path: 'C:\\demo\\demo.exe', windowTitle: /Never shown/, windowTimeoutMs: 150 })).rejects.toThrow(/no window appeared within 150 ms/);
  });

  test('attach finds a running program by process name, title or pid; none is NOT_FOUND', async () => {
    const d = await startDemo(build);
    expect((await d.session.attach({ processName: 'demo.exe' })).pid).toBe(d.process.pid);
    expect((await d.session.attach({ windowTitle: /Demo wind/ })).pid).toBe(d.process.pid);
    expect((await d.session.attach({ pid: d.process.pid })).pid).toBe(d.process.pid);
    await expect(d.session.attach({ processName: 'nothing' })).rejects.toThrow(/no top-level window matches/);
  });
});
