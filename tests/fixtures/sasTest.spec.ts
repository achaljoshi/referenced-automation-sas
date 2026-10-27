import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { PolicyViolation, readAudit } from '../../src/core';
import { sasTest as test } from '../../src/fixtures';
import { FAKE_TOOL_SOURCE } from '../process/helpers';
import { settings } from './desktopSupport';

// `sasTest` is the command-line route: the policy fixtures and the process driver, and NOT the desktop gate. These tests run with the
// stand-in switched OFF on purpose: on macOS and Linux a desktop cannot be reached, and a test of this route must still run there.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-tools-file-'));
const toolsFile = path.join(dir, 'tools.json');
fs.writeFileSync(
  toolsFile,
  JSON.stringify({
    tools: {
      'print-two-lines': {
        command: process.execPath,
        kind: 'read',
        fixedArgs: [FAKE_TOOL_SOURCE, 'out=first', 'out=second'],
        options: {},
        exitCodes: { '0': { meaning: 'success', ok: true } },
        parse: 'lines',
      },
    },
  }),
);

test.use({ desktopSimulator: false, sasSettings: settings({ SAS_ENVIRONMENT: 'simulator', SAS_BATCH_TOOLS_FILE: toolsFile, SAS_TOOL_DIRS: path.dirname(process.execPath) }) });

test.describe('sasTest: the command-line route @sas-cli', () => {
  test('it is not skipped where no desktop can be reached, and it has no desktop in it', async ({ environment, desktopSettings, runContext }, testInfo) => {
    expect(testInfo.status).not.toBe('skipped');
    expect(desktopSettings.simulated).toBe(false);
    expect(environment).toMatchObject({ name: 'simulator', kind: 'nonprod' });
    expect(runContext.ns('X')).toMatch(/^AUTO_/);
  });

  test('sasProcess runs a program through the policy and writes one audit record, with the arguments as an array', async ({ sasProcess, safetyPolicy, runContext }) => {
    const result = await sasProcess.run({ command: process.execPath, args: [FAKE_TOOL_SOURCE, 'out=hello; echo not-a-shell'], kind: 'read', local: true, operation: 'fixture:read' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello; echo not-a-shell\n');
    const records = readAudit(safetyPolicy.audit.file, { runId: runContext.runId }).filter((r) => r.operation === 'fixture:read');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ driver: 'sas-process', environment: 'simulator', kind: 'read', outcome: 'ok' });
  });

  test('sasProcess refuses a change outside the run\'s namespace before the program starts; inside it the policy lets it through', async ({ sasProcess, runContext }) => {
    const marker = path.join(dir, 'ran');
    const run = (target: string) => sasProcess.run({ command: process.execPath, args: [FAKE_TOOL_SOURCE, `child=${marker}`, 'exit=0'], kind: 'update', target, local: true });
    await expect(run('Somebody Else')).rejects.toBeInstanceOf(PolicyViolation);
    expect(fs.existsSync(marker)).toBe(false);
    const allowed = await sasProcess.run({ command: process.execPath, args: [FAKE_TOOL_SOURCE, 'out=ok'], kind: 'update', target: runContext.ns('Mine'), local: true });
    expect(allowed.exitCode).toBe(0);
  });

  test('sasTools holds a BatchToolRunner for every table in SAS_BATCH_TOOLS_FILE, and it runs on the same policy', async ({ sasTools, safetyPolicy, runContext }) => {
    expect(Object.keys(sasTools)).toEqual(['print-two-lines']);
    const result = await sasTools['print-two-lines']!.runOrThrow();
    expect(result).toMatchObject({ ok: true, exitCode: 0, data: ['first', 'second'], verified: false }); // a table nobody has checked against a real tool says so
    const record = readAudit(safetyPolicy.audit.file, { runId: runContext.runId }).find((r) => r.operation.includes('print-two-lines'));
    expect(record).toMatchObject({ driver: 'sas-process', outcome: 'ok' });
  });

  test('sasProcess finds a bare tool name only in SAS_TOOL_DIRS', async ({ sasProcess }) => {
    expect(sasProcess.toolDirs).toEqual([path.dirname(process.execPath)]);
    const missing = sasProcess.run({ command: 'no-such-sas-tool', kind: 'read', local: true });
    await expect(missing).rejects.toMatchObject({ code: 'tool-not-found' });
  });
});
