import * as fs from 'node:fs';
import * as path from 'node:path';
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';
import { expect, test } from '@playwright/test';
import { recordDataSteps, recordSteps } from './stepRig';

// The step TEXTS are a public contract: features in other repositories are written against them. Changing, renaming or removing one
// must be a deliberate act (a major version and a CHANGELOG line) - which is what this list makes visible.

const VOCABULARY = [
  'Given SAS Enterprise Guide is available through its automation interface',
  'Given SAS Enterprise Guide is open',
  'Given SAS Enterprise Guide is open and I am logged on',
  'Given SAS Management Console is open',
  'Given SAS Management Console is open and I am logged on',
  'Given I make up the test object name {string} as {string}',
  'When I click the button named {string}',
  'When I click the control named {string}',
  'When I click the control with the automation id {string}',
  'When I enter {string} in the field named {string}',
  'When I enter {string} in the field with the automation id {string}',
  'When I enter the secret {string} in the field named {string}',
  'When I expand the item named {string}',
  'When I export the log of the program {string} to the file {string}',
  'When I export the results of the program {string} to the folder {string}',
  'When I log on to SAS Enterprise Guide',
  'When I log on to SAS Management Console',
  'When I open the {string} plug-in',
  'When I open the Enterprise Guide project {string}',
  'When I press the keys {string}',
  'When I remember the status of the program {string} as {string}',
  'When I remember the text of the control named {string} as {string}',
  'When I remember the title of the window as {string}',
  'When I run the process flow {string}',
  'When I run the program {string}',
  'When I run the project',
  'When I select the item named {string}',
  'When I switch back to the main window',
  'When I switch to the window {string}',
  'When I try to log on to SAS Management Console with a wrong password',
  'Then the control named {string} contains the text {string}',
  'Then the control named {string} is enabled',
  'Then the control named {string} is not shown',
  'Then the control named {string} is shown',
  'Then the group {string} is listed',
  'Then the library {string} is listed',
  'Then the log of the program {string} contains {string}',
  'Then the logon is rejected',
  'Then the program {string} finished with the status {string}',
  'Then the program {string} finished without errors',
  'Then the same logon is not attempted again',
  'Then the server {string} has the status {string}',
  'Then the user {string} is listed',
  'Then the user {string} is not listed',
  'Then the window {string} is not open',
  'Then the window {string} is open',
  'Then the window title contains {string}',
].sort();

const registry = new ParameterTypeRegistry();
const expression = (pattern: string) => new CucumberExpression(pattern, registry);
const matches = (pattern: string, text: string): boolean => expression(pattern).match(text) !== null;
/** A step text that matches the pattern: every {string} becomes "x", every {int} 7. */
const sample = (pattern: string): string => pattern.replace(/\{string\}/g, '"x"').replace(/\{int\}/g, '7');

const ours = recordSteps();
const data = recordDataSteps();

test.describe('the vocabulary is a public contract', () => {
  test('exactly these steps exist: a change here is a breaking change for every feature that uses it', () => {
    expect(ours.map((s) => `${s.keyword} ${s.pattern}`).sort()).toEqual(VOCABULARY);
  });

  test('a step text is registered once (the keyword does not tell Gherkin steps apart)', () => {
    const texts = ours.map((s) => s.pattern);
    expect(texts.filter((t, i) => texts.indexOf(t) !== i)).toEqual([]);
  });

  test('no step is ambiguous with another one of ours or with the data steps registered beside them', () => {
    const all = [...ours, ...data].filter((s) => !s.pattern.startsWith('/'));
    for (const step of all) {
      const text = sample(step.pattern);
      const hits = all.filter((other) => matches(other.pattern, text)).map((other) => other.pattern);
      expect(hits, `"${text}" must match exactly one step`).toEqual([step.pattern]);
    }
  });

  test('every step of every sample feature matches exactly one registered step (what bddgen would report as missing or ambiguous)', () => {
    const all = [...ours, ...data];
    const dir = path.resolve(__dirname, '..', '..', 'features');
    const features = fs.readdirSync(dir).filter((f) => f.endsWith('.feature'));
    expect(features.length).toBeGreaterThanOrEqual(4);
    let checked = 0;
    for (const file of features) {
      for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
        const m = /^\s*(?:Given|When|Then|And|But)\s+(.*\S)\s*$/.exec(line);
        if (!m) continue;
        const text = (m[1] as string).replace(/<[a-zA-Z]+>/g, 'x');
        const hits = all.filter((s) => (s.pattern.startsWith('/') ? new RegExp(s.pattern.slice(1, s.pattern.lastIndexOf('/'))).test(text) : matches(s.pattern, text)));
        expect(hits.length, `${file}: "${text}" matches ${hits.length} steps`).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(25); // a scan that found nothing would pass everything
  });

  test('every step asks only for fixtures that desktopTest provides', () => {
    const provided = new Set(['smc', 'smcLoggedOn', 'eg', 'egLoggedOn', 'egCom', 'desktopScenario', 'logon', 'desktopSettings', 'runContext', 'vars']);
    for (const step of ours) {
      const source = step.implementation.toString();
      const header = /^(?:async\s*)?(?:function\s*)?\(?\s*\{([^}]*)\}/.exec(source);
      const names = (header?.[1] ?? '').split(',').map((n) => n.trim().split(':')[0]?.trim() ?? '').filter(Boolean);
      for (const name of names) expect(provided.has(name), `${step.pattern} asks for the fixture "${name}"`).toBe(true);
    }
  });

  test('there is deliberately no step that waits a fixed time: every step waits for what it needs', () => {
    expect(ours.filter((s) => /\bwait\b|\bsleep\b|\bseconds?\b/i.test(s.pattern))).toEqual([]);
    for (const step of ours) expect(step.implementation.toString(), step.pattern).not.toMatch(/setTimeout|waitForTimeout/);
  });

  test('the matcher can tell: a text that is not in the vocabulary matches nothing', () => {
    const all = [...ours, ...data];
    expect(all.filter((s) => !s.pattern.startsWith('/') && matches(s.pattern, 'I wait 5 seconds'))).toEqual([]);
    expect(all.filter((s) => !s.pattern.startsWith('/') && matches(s.pattern, 'the user "a" is listed'))).toHaveLength(1);
  });
});
