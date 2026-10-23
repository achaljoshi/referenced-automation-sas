import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { CONVERT_USAGE } from '../../src/recorder/cli/convert';
import { IMPORT_USAGE } from '../../src/recorder/cli/importScript';
import { RECORD_USAGE } from '../../src/recorder/cli/record';
import { repoRoot } from './support/examples';

// built from pieces so that this file does not contain the words itself
const KEPT_OUT = new RegExp(['cla' + 'ude', 'anthro' + 'pic', 'ai-gener' + 'ated'].join('|'), 'i');
const docs = fs.readFileSync(path.join(repoRoot, 'docs', 'RECORD_AND_PLAY.md'), 'utf8');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test.describe('docs/RECORD_AND_PLAY.md', () => {
  test('says what it must: the three workflows, NOT VERIFIED, passwords, both programs, troubleshooting, and that protocol capture is PLANNED and not implemented', () => {
    for (const needle of [
      'NOT VERIFIED',
      'Workflow 1: record, convert, run',
      'Workflow 2: import a schedule script',
      'Workflow 3: protocol-level capture (PLANNED, NOT IMPLEMENTED)',
      'Nothing in this section exists yet',
      'App.OMI',
      'Audit.Meta.Updates',
      'JNLLINEMAX',
      'server administrator',
      'non-production',
      'Passwords and other secrets',
      'nothing typed into a password field was kept',
      'Java Access Bridge',
      'Management Console and Enterprise Guide are not the same',
      'Review what was generated',
      'Troubleshooting',
      'sas-desktop-record',
      'sas-desktop-to-playwright',
      'sas-eg-import-script',
      'node dist/recorder/cli/record.js',
      'npx sas-desktop-record',
      'npm run record --',
      'TODO(manual, event N)',
      'What is assumed about Windows',
      'ASSUMED, not checked',
    ]) {
      expect(docs, needle).toContain(needle);
    }
  });

  test('is honest about workflow 3: it is not claimed anywhere to be available', () => {
    const section = docs.slice(docs.indexOf('## Workflow 3'), docs.indexOf('## How the recorder works'));
    expect(section).toMatch(/NOT IMPLEMENTED|does not exist|not written/);
    expect(section).toContain('MetadataAdmin` is not written');
    expect(section).not.toMatch(/npx sas-metadata-capture|node dist\/[^\s]*metadataCapture/);
    expect(docs).not.toMatch(/sas-metadata-capture start.*implemented/);
  });

  test('every command-line option of the three commands is documented, and the docs name no option the commands do not have', () => {
    const usage = `${RECORD_USAGE}\n${CONVERT_USAGE}\n${IMPORT_USAGE}`;
    const flags = (text: string) => new Set([...text.matchAll(/(?<![\w-])(--[a-z][a-z-]+)/g)].map((m) => m[1] as string));
    const real = flags(usage);
    const documented = flags(docs);
    // Playwright's own options and the environment-variable example appear in commands
    const foreign = new Set(['--workers', '--grep', '--min', '--help']);
    expect([...real].filter((f) => !documented.has(f) && f !== '--help').sort(), 'in the usage text but not in the docs').toEqual([]);
    expect([...documented].filter((f) => !real.has(f) && !foreign.has(f)).sort(), 'in the docs but not in the usage text').toEqual([]);
  });

  test('every file it points at exists (the merged-away fragment is the one exception), and Playwright test paths use forward slashes', () => {
    for (const m of docs.matchAll(/`((?:src|bridge|docs|tests|examples|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|ps1|js|md|json))`/g)) expect(fs.existsSync(path.join(repoRoot, m[1] as string)), m[1]).toBe(true);
    for (const m of docs.matchAll(/\]\((\.\.?\/[A-Za-z0-9_./-]+(?:\.md|\.json)?)\)/g)) expect(fs.existsSync(path.resolve(repoRoot, 'docs', m[1] as string)), m[1]).toBe(true);
    for (const line of docs.split('\n').filter((l) => /playwright test /.test(l))) expect(line, line).not.toMatch(/playwright test [^\n]*\\[A-Za-z]/);
    for (const m of docs.matchAll(/playwright test ([^\s`]+)/g)) expect(m[1], m[0]).not.toContain('\\');
  });

  test('the commands it shows are the ones wired in this repository: the paths are the build output of the three command files', () => {
    for (const file of ['record', 'convert', 'importScript']) {
      expect(docs).toContain(`dist/recorder/cli/${file}.js`);
      expect(fs.existsSync(path.join(repoRoot, 'src', 'recorder', 'cli', `${file}.ts`))).toBe(true);
      expect(fs.readFileSync(path.join(repoRoot, 'src', 'recorder', 'cli', `${file}.ts`), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    }
  });
});

test.describe('hygiene of what the recorder owns', () => {
  const owned = [
    ...files(path.join(repoRoot, 'src', 'recorder')),
    ...files(path.join(repoRoot, 'tests', 'recorder')),
    path.join(repoRoot, 'docs', 'RECORD_AND_PLAY.md'),
    path.join(repoRoot, 'src', 'desktop', 'recording.ts'),
    ...files(path.join(repoRoot, 'tests', 'desktop-generated')),
    ...files(path.join(repoRoot, 'examples')).filter((f) => f.endsWith('.sasrec.json')),
  ].filter((f) => !f.includes('__virtual__') && !f.includes(`${path.sep}.`));

  test('no source mentions the words the project keeps out of files, and none holds a password literal', () => {
    expect(owned.length).toBeGreaterThan(30);
    for (const file of owned) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(KEPT_OUT);
      expect(text, file).not.toMatch(/(?<!['"\w])password\s*[:=]\s*'(?!\$\{)(?![A-Z][A-Z0-9_]+')[^'\n]{3,}'/i); // (the NAME of an environment variable, or a template reference, is not a password)
    }
  });

  test('no committed generated test has a sleep or a fixed wait (the converters never write one: converter.spec.ts checks every shape)', () => {
    for (const file of owned.filter((f) => /desktop-generated/.test(f) && f.endsWith('.ts'))) expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/waitForTimeout|networkidle|Thread\.Sleep|Start-Sleep/);
  });
});
