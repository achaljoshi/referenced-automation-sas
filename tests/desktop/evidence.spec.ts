import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { button, startDemo } from './demoDesktop';
import { tempDir } from './support';

const build = (w: Parameters<Parameters<typeof startDemo>[0]>[0], { desktop, log }: Parameters<Parameters<typeof startDemo>[0]>[1]) => {
  desktop.attach(w, button('Save', log));
  desktop.attach(w, { controlType: 'Edit', name: 'Name:', value: '' });
};

test.describe('evidence screenshots', () => {
  test('are off unless requested: no screenshot is taken by ordinary steps', async () => {
    const dir = tempDir();
    const d = await startDemo(build, { session: { evidenceDir: dir } });
    await d.app.window(/Demo/).getByName('Save').click();
    await d.app.window(/Demo/).getByName('Name:').fill('x');
    expect(d.desktop.screenshots).toBe(0);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  test('a screenshot you ask for is written as a PNG named by its label, for the whole screen or for one control', async () => {
    const dir = tempDir();
    const d = await startDemo(build, { session: { evidenceDir: dir } });
    const whole = await d.app.evidence('after login / step 1');
    const control = await d.app.window(/Demo/).getByName('Save').screenshot('save button');
    expect(path.basename(whole)).toBe('001-after-login-step-1.png');
    expect(path.basename(control)).toBe('002-save-button.png');
    for (const file of [whole, control]) expect(fs.readFileSync(file).subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(d.session.evidenceFiles.map((e) => e.label)).toEqual(['after login / step 1', 'save button']);
    expect(d.desktop.calls.filter((c) => c.op === 'screenshot')).toEqual([{ op: 'screenshot' }, { op: 'screenshot', ref: expect.any(String) }]);
  });

  test('steps mode takes one after each step that may change something, none after a read', async () => {
    const dir = tempDir();
    const d = await startDemo(build, { session: { evidence: 'steps', evidenceDir: dir } });
    const win = d.app.window(/Demo/);
    await win.getByName('Save').click();
    await win.getByName('Name:').fill('x');
    await win.getByName('Save').exists();
    await win.getByName('Name:').text();
    await win.getByName('Name:').focus(); // a read-kind step
    expect(d.desktop.screenshots).toBe(2);
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  test('the label is the only text in the file name: a path trick in a label stays inside the folder', async () => {
    const dir = tempDir();
    const d = await startDemo(build, { session: { evidenceDir: dir } });
    const file = await d.app.evidence('../../etc/passwd');
    expect(path.dirname(file)).toBe(path.resolve(dir));
    expect(path.basename(file)).toBe('001-etc-passwd.png');
  });
});
