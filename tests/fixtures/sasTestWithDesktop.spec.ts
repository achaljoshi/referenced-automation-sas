import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { readAudit } from '../../src/core';
import { desktopTest as test } from '../../src/fixtures';
import { FAKE_TOOL_SOURCE } from '../process/helpers';
import { settings } from './desktopSupport';

// `desktopTest` is `sasTest` plus the desktop: the command-line fixtures must be there too, on the same policy and the same audit log.
// (Worker options apply to the whole file, so this check has its own file next to sasTest.spec.ts, which runs with the stand-in off.)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-tools-file-'));
const toolsFile = path.join(dir, 'tools.json');
fs.writeFileSync(toolsFile, JSON.stringify({ tools: { 'print-one': { command: process.execPath, kind: 'read', fixedArgs: [FAKE_TOOL_SOURCE, 'out=one'], options: {}, exitCodes: { '0': { meaning: 'success', ok: true } }, parse: 'lines' } } }));

test.use({ desktopSimulator: true, sasSettings: settings({ SAS_BATCH_TOOLS_FILE: toolsFile }) });

test('the command-line fixtures are there too, next to the desktop @sas-cli @sas-desktop', async ({ sasProcess, sasTools, safetyPolicy, desktopSession, fakeDesktop }) => {
  expect((await desktopSession.ping()).bridge).toBeTruthy(); // the desktop half
  expect(fakeDesktop).toBeDefined();
  const result = await sasProcess.run({ command: process.execPath, args: [FAKE_TOOL_SOURCE, 'out=both'], kind: 'read', local: true, operation: 'fixture:both' });
  expect(result.stdout).toBe('both\n'); // the command-line half
  expect(Object.keys(sasTools)).toEqual(['print-one']);
  expect(readAudit(safetyPolicy.audit.file).some((r) => r.operation === 'fixture:both')).toBe(true); // one audit log for both
});
