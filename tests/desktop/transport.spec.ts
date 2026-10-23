import { type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { APPROVED_SCRIPT_NAME, bridgeScriptPath, DesktopSession, DesktopTransportError, PowerShellTransport, ProcessTransport } from '../../src/desktop';
import { standInBridge, tempDir, withEnv } from './support';

// ProcessTransport and PowerShellTransport against the Node stand-in bridge (a real child process speaking the real line protocol).
// The PowerShell bridge itself is NOT VERIFIED on Windows.

const childOf = (t: ProcessTransport) => (t as unknown as { child: ChildProcess }).child;
const exited = (t: ProcessTransport) =>
  new Promise<void>((resolve) => (childOf(t).exitCode !== null || childOf(t).signalCode !== null ? resolve() : childOf(t).once('exit', () => resolve())));

const start = (env: NodeJS.ProcessEnv = {}, extra: Partial<Parameters<typeof ProcessTransport.start>[0]> = {}) =>
  ProcessTransport.start({ command: process.execPath, args: [standInBridge()], label: 'Stand-in', env: { ...process.env, LOG_TO_FILE: 'false', ...env }, requestTimeoutMs: 2000, startupTimeoutMs: 5000, ...extra });
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as DesktopTransportError);

test.describe('ProcessTransport speaks the bridge protocol', () => {
  test('starts when the bridge says ready, answers requests, closes cleanly (cleanup runs once, twice is fine)', async () => {
    let cleanups = 0;
    const t = await start({}, { cleanup: () => void cleanups++ });
    expect(await t.request({ op: 'ping' })).toMatchObject({ bridge: 'sas-desktop-bridge', version: 1 });
    await t.close();
    await t.close();
    expect(cleanups).toBe(1);
    await expect(t.request({ op: 'ping' })).rejects.toMatchObject({ code: 'BRIDGE_EXITED' });
  });

  test('the codes survive the line protocol: NOT_FOUND, DENIED, NOT_IMPLEMENTED, ERROR - and none of them stops the bridge', async () => {
    const t = await start();
    expect((await caught(t.request({ op: 'info', ref: 'e99999' })))?.code).toBe('NOT_FOUND');
    expect((await caught(t.request({ op: 'com.create', progId: 'WScript.Shell' })))?.code).toBe('DENIED');
    expect((await caught(t.request({ op: 'doubleClick', ref: 'e99999' })))?.code).toBe('NOT_FOUND');
    expect((await caught(t.request({ op: 'find', root: null, criteria: {}, limit: 1 })))).toBeUndefined();
    expect((await caught(t.request({ op: 'nonsense' } as never)))?.code).toBe('ERROR');
    expect(await t.request({ op: 'ping' })).toMatchObject({ version: 1 });
    await t.close();
  });

  test('NOT_IMPLEMENTED survives the line protocol too (a bridge without the recorder) and does not stop the bridge', async () => {
    const t = await start({}, { args: [standInBridge(), '--without-recorder'] });
    for (const op of ['record.start', 'record.events', 'record.stop'] as const) expect((await caught(t.request({ op })))?.code).toBe('NOT_IMPLEMENTED');
    expect(await t.request({ op: 'ping' })).toBeTruthy();
    await t.close();
  });

  test('a locked desktop is SESSION_LOST (not a retryable NOT_FOUND) and the bridge stays up', async () => {
    const t = await start({ BRIDGE_SESSION_LOST_OP: 'windows' });
    const error = await caught(t.request({ op: 'windows' }));
    expect(error?.code).toBe('SESSION_LOST');
    expect(await t.request({ op: 'ping' })).toBeTruthy();
    await t.close();
  });

  test('the COM allow-list given at start reaches the bridge: a class outside it is DENIED, one inside it is created', async () => {
    const t = await start({}, { args: [standInBridge(), '-AllowProgIds', 'SASEGObjectModel.Application.*'] });
    expect((await caught(t.request({ op: 'com.create', progId: 'SASObjectManager.ObjectFactoryMulti2' })))?.code).toBe('DENIED');
    expect(await t.request({ op: 'com.create', progId: 'SASEGObjectModel.Application.8.3' })).toMatchObject({ handle: expect.stringMatching(/^o\d+$/) });
    await t.close();
  });

  test('replies are matched to their requests even when they arrive out of order', async () => {
    const t = await start({ BRIDGE_DELAY_OPS: 'ping:300' });
    const [slow, fast] = await Promise.all([t.request({ op: 'ping' }), t.request({ op: 'environment' })]);
    expect(slow).toMatchObject({ bridge: 'sas-desktop-bridge' });
    expect(fast).toMatchObject({ desktopAccessible: true });
    await t.close();
  });

  test('a non-JSON line is ignored, not fatal', async () => {
    const t = await start({ BRIDGE_JUNK: '1' });
    expect(await t.request({ op: 'ping' })).toBeTruthy();
    await t.close();
  });

  test('a bridge that never says ready fails to start with a TIMEOUT, is cleaned up exactly once, and the failure costs the startup timeout only', async () => {
    let cleanups = 0;
    const startedAt = Date.now();
    const error = await caught(start({ BRIDGE_NO_READY: '1', BRIDGE_HANG_OPS: 'quit' }, { startupTimeoutMs: 300, requestTimeoutMs: 60_000, cleanup: () => void cleanups++ }));
    expect(error?.code).toBe('TIMEOUT');
    expect(error?.message).toContain('did not become ready within 300ms');
    expect(cleanups).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(3000); // not "startup timeout + a 60 s quit wait"
  });

  test('a program that cannot be started is BRIDGE_EXITED with the reason', async () => {
    const error = await caught(ProcessTransport.start({ command: path.join(tempDir(), 'no-such-powershell'), args: [], label: 'PowerShell', startupTimeoutMs: 2000 }));
    expect(error?.code).toBe('BRIDGE_EXITED');
    expect(error?.message).toMatch(/could not start PowerShell/);
  });

  test('a request nobody answers times out and says a modal dialog or a locked desktop may be the cause', async () => {
    const t = await start({ BRIDGE_HANG_OPS: 'environment' }, { requestTimeoutMs: 300 });
    const error = await caught(t.request({ op: 'environment' }));
    expect(error?.code).toBe('TIMEOUT');
    expect(error?.message).toMatch(/no reply to "environment" within 300ms.*modal dialog.*locked/);
    await t.close();
  });

  test('after a timeout the bridge is KILLED, pending requests fail at once and later ones do not wait again', async () => {
    const t = await start({ BRIDGE_HANG_OPS: 'environment' }, { requestTimeoutMs: 400 });
    const first = caught(t.request({ op: 'environment' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = caught(t.request({ op: 'environment' })); // would time out at ~550 ms on its own
    expect((await first)?.code).toBe('TIMEOUT');
    const stopped = await second;
    expect(stopped?.code).toBe('BRIDGE_EXITED');
    expect(stopped?.message).toContain('was stopped');
    const startedAt = Date.now();
    const later = await caught(t.request({ op: 'ping' }));
    expect(later?.code).toBe('BRIDGE_EXITED');
    expect(Date.now() - startedAt).toBeLessThan(200);
    await exited(t); // the hung process is really gone
    await t.close();
  });

  test('a bridge that crashes fails the pending request with its stderr, and everything after', async () => {
    const t = await start({ BRIDGE_CRASH_OP: 'windows' });
    const error = await caught(t.request({ op: 'windows' }));
    expect(error?.code).toBe('BRIDGE_EXITED');
    expect(error?.message).toMatch(/exited \(code 3\).*crashed on windows/s);
    expect((await caught(t.request({ op: 'ping' })))?.code).toBe('BRIDGE_EXITED');
    await t.close();
  });

  test('a bridge that closed its input does not crash the test run with an uncaught EPIPE: the request fails with a clear error', async () => {
    const t = await start({ BRIDGE_CLOSE_STDIN: '1' }, { requestTimeoutMs: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const error = await caught(t.request({ op: 'ping' }));
    expect(error).toBeInstanceOf(DesktopTransportError);
    expect(error?.code).toBe('BRIDGE_EXITED');
    expect(error?.message).toMatch(/closed its input|could not send/);
    await exited(t);
    await t.close();
  });
});

test.describe('PowerShellTransport launches the verified script with the right PowerShell arguments', () => {
  /** A stand-in for powershell.exe: records how it was called, then plays the stand-in bridge. */
  function fakePowerShell(): { exe: string; record: string } {
    const dir = tempDir('fake-ps-');
    const record = path.join(dir, 'argv.json');
    const exe = path.join(dir, 'powershell');
    fs.writeFileSync(
      exe,
      `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const file = argv[argv.indexOf('-File') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, scriptExistsWhileRunning: fs.existsSync(file), scriptBytes: fs.readFileSync(file).toString('base64') }));
require(${JSON.stringify(standInBridge())}).runStandInBridge(argv);
`,
      { mode: 0o755 },
    );
    return { exe, record };
  }
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { argv: string[]; scriptExistsWhileRunning: boolean; scriptBytes: string };

  test('default: a temporary copy of the verified bytes, -NoProfile -ExecutionPolicy Bypass -File, the allow-list as -AllowProgIds; the copy is deleted on close', async () => {
    const { exe, record } = fakePowerShell();
    const tmp = tempDir();
    const t = await withEnv({ LOG_TO_FILE: 'false' }, () => PowerShellTransport.start({ platform: 'win32', powershellPath: exe, allowProgIds: ['SASEGObjectModel.Application.*'], tmpDir: tmp, startupTimeoutMs: 5000, requestTimeoutMs: 3000 }));
    const seen = read(record);
    expect(seen.argv).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']));
    expect(seen.scriptExistsWhileRunning).toBe(true);
    expect(Buffer.from(seen.scriptBytes, 'base64').equals(fs.readFileSync(bridgeScriptPath()))).toBe(true);
    expect(seen.argv.slice(-2)).toEqual(['-AllowProgIds', 'SASEGObjectModel.Application.*']);
    const temp = seen.argv[seen.argv.indexOf('-File') + 1] as string;
    expect(path.dirname(temp)).toBe(tmp);
    // the allow-list really reached the (stand-in) bridge
    expect(((await t.request({ op: 'com.create', progId: 'SASObjectManager.Thing' }).catch((e: unknown) => e)) as DesktopTransportError).code).toBe('DENIED');
    await t.close();
    expect(fs.existsSync(temp)).toBe(false);
  });

  test('with an approved script folder: that file is run in place and ExecutionPolicy is left alone', async () => {
    const { exe, record } = fakePowerShell();
    const dir = tempDir();
    fs.copyFileSync(bridgeScriptPath(), path.join(dir, APPROVED_SCRIPT_NAME));
    const t = await PowerShellTransport.start({ platform: 'win32', powershellPath: exe, scriptDir: dir, startupTimeoutMs: 5000 });
    const seen = read(record);
    expect(seen.argv).not.toContain('-ExecutionPolicy');
    expect(seen.argv).not.toContain('Bypass');
    expect(seen.argv[seen.argv.indexOf('-File') + 1]).toBe(path.join(dir, APPROVED_SCRIPT_NAME));
    expect(await t.request({ op: 'ping' })).toBeTruthy();
    await t.close();
    expect(fs.existsSync(path.join(dir, APPROVED_SCRIPT_NAME))).toBe(true); // an approved copy is never deleted
  });

  test('a script that is not the shipped one never reaches PowerShell: nothing is spawned', async () => {
    const { exe, record } = fakePowerShell();
    const error = (await PowerShellTransport.start({ platform: 'win32', powershellPath: exe, expectedHash: 'f'.repeat(64) }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/not the bridge script this version of the framework ships/);
    expect(fs.existsSync(record)).toBe(false);
  });

  test('a session works end to end through it', async () => {
    const { exe } = fakePowerShell();
    const t = await withEnv({ LOG_TO_FILE: 'false' }, () => PowerShellTransport.start({ platform: 'win32', powershellPath: exe, startupTimeoutMs: 5000 }));
    const session = new DesktopSession(t, { timeoutMs: 3000, pollMs: 10 });
    expect(await session.healthCheck()).toBe(true);
    await session.close();
  });
});
