import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { expect, test } from '@playwright/test';
import { PolicyViolation, readAudit } from '../../src/core';
import { ProcessDriver, ProcessError, describeCommand, killProcessTree, resolveTool, windowsTreeKill } from '../../src/process';
import { config, tempDir, useCleanSasEnv } from '../core/support';
import { FAKE_TOOL_SOURCE, RecordingGuard, driver, isAlive, realPolicy, toolDir, waitUntil } from './helpers';

useCleanSasEnv();

const NODE = process.execPath;
/** Run the fake tool through node by absolute path (an explicit path). */
const fake = (...tokens: string[]) => ({ command: NODE, args: [FAKE_TOOL_SOURCE, ...tokens], kind: 'read' as const, host: 'sasmeta.dev.example.com' });
const SECRET = 'Sup3r-S3cret#pw';

test.describe('no shell: the arguments are an array', () => {
  test('shell metacharacters, quotes, spaces and newlines arrive exactly as written and nothing is executed', async () => {
    const dir = tempDir();
    const marker = path.join(dir, 'pwned');
    const tricky = [`a b`, `"quoted"`, `$(touch ${marker})`, `; touch ${marker}`, '`touch x`', '| cat', '&& echo hi', 'line1\nline2', '*', '~', '%PATH%', '--flag=value with space', ''];
    const result = await driver().run({ ...fake('argv'), args: [FAKE_TOOL_SOURCE, ...tricky, 'argv'] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim()).slice(0, tricky.length)).toEqual(tricky);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('a program that needs a shell (a .bat / .cmd file) is refused', async () => {
    const dir = tempDir();
    const bat = path.join(dir, 'tool.bat');
    fs.writeFileSync(bat, '@echo off\r\n');
    for (const name of [bat, 'tool.cmd']) {
      const error = (await driver({ toolDirs: [dir] }).run({ command: name, kind: 'read', host: 'sasmeta.dev.example.com' }).catch((e: unknown) => e)) as ProcessError;
      expect(error).toBeInstanceOf(ProcessError);
      expect(error.code).toBe('tool-not-allowed');
      expect(error.message).toContain('batch file');
    }
  });

  test('NUL characters in an argument are refused', async () => {
    await expect(driver().run({ ...fake('argv'), args: [FAKE_TOOL_SOURCE, 'a\0b'] })).rejects.toThrow(/NUL/);
  });
});

test.describe('where the program comes from', () => {
  test('a bare name is found only in SAS_TOOL_DIRS (comma-separated); PATH and the working directory are never searched', async () => {
    const dir = toolDir();
    const viaConfig = new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config({ SAS_TOOL_DIRS: `${path.join(tempDir(), 'missing')}, ${dir}` }) });
    expect(viaConfig.toolDirs).toHaveLength(2);
    const result = await viaConfig.run({ command: 'fakebatch', args: ['out=found it'], kind: 'read', host: 'sasmeta.dev.example.com' });
    expect(result.stdout).toBe('found it\n');

    // on PATH, but not in a tool folder: not found
    const onPath = new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config(), toolDirs: [tempDir()], parentEnv: { PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
    const error = (await onPath.run({ command: 'fakebatch', kind: 'read', host: 'sasmeta.dev.example.com' }).catch((e: unknown) => e)) as ProcessError;
    expect(error.code).toBe('tool-not-found');
    expect(error.message).toContain('never searches PATH or the working directory');

    // in the working directory: not found either
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(driver({ toolDirs: [tempDir()] }).run({ command: 'fakebatch', kind: 'read', host: 'sasmeta.dev.example.com' })).rejects.toMatchObject({ code: 'tool-not-found' });
    } finally {
      process.chdir(cwd);
    }
  });

  test('relative paths and ".." are refused', async () => {
    for (const command of ['./fakebatch', 'bin/fakebatch', '../fakebatch', '/tmp/../bin/sh']) {
      const error = (await driver().run({ command, kind: 'read', host: 'sasmeta.dev.example.com' }).catch((e: unknown) => e)) as ProcessError;
      expect(error.code, command).toBe('tool-not-allowed');
    }
  });

  test('a link in a tool folder that points outside it is refused (the real path must stay inside)', async () => {
    test.skip(process.platform === 'win32', 'symbolic links need privileges on Windows');
    const dir = tempDir('sas-tools-');
    fs.symlinkSync('/bin/sh', path.join(dir, 'sneaky'));
    const error = (await driver({ toolDirs: [dir] }).run({ command: 'sneaky', kind: 'read', host: 'sasmeta.dev.example.com' }).catch((e: unknown) => e)) as ProcessError;
    expect(error.code).toBe('tool-not-allowed');
    expect(error.message).toContain('is outside that tool folder');
  });

  test('an absolute path outside the folders is allowed by default (explicit path) and refused when explicit paths are off', async () => {
    expect((await driver().run(fake('out=ok'))).exitCode).toBe(0);
    const error = (await driver({ allowExplicitPaths: false, toolDirs: [tempDir()] }).run(fake('out=ok')).catch((e: unknown) => e)) as ProcessError;
    expect(error.code).toBe('tool-not-allowed');
    expect(error.message).toContain('explicit paths are switched off');
    // inside a tool folder it is fine even then
    const dir = toolDir();
    expect((await driver({ allowExplicitPaths: false, toolDirs: [dir] }).run({ command: path.join(dir, 'fakebatch'), kind: 'read', host: 'sasmeta.dev.example.com' })).exitCode).toBe(0);
  });

  test('a missing or non-executable explicit path is reported', async () => {
    const dir = tempDir();
    const plain = path.join(dir, 'data.txt');
    fs.writeFileSync(plain, 'x', { mode: 0o644 });
    await expect(driver().run({ command: path.join(dir, 'nope'), kind: 'read', host: 'sasmeta.dev.example.com' })).rejects.toMatchObject({ code: 'tool-not-found' });
    if (process.platform !== 'win32') await expect(driver().run({ command: plain, kind: 'read', host: 'sasmeta.dev.example.com' })).rejects.toMatchObject({ code: 'tool-not-allowed' });
  });

  test('resolveTool on Windows rules: .exe and .com are tried for a name without extension (checked with a fake platform)', () => {
    const dir = tempDir('sas-tools-');
    fs.writeFileSync(path.join(dir, 'ExportPackage.exe'), 'x');
    expect(resolveTool('ExportPackage', { toolDirs: [dir], platform: 'win32' }).path).toBe(path.join(dir, 'ExportPackage.exe'));
    expect(() => resolveTool('ExportPackage', { toolDirs: [dir], platform: 'linux' })).toThrow(/not found/);
  });

  test('health(): reports a missing tool folder, a world-writable one, and none configured', async () => {
    const good = tempDir('sas-tools-');
    fs.chmodSync(good, 0o755);
    expect((await driver({ toolDirs: [good] }).health()).ok).toBe(true);
    expect((await driver({ toolDirs: [] }).health()).detail).toContain('only explicit paths');
    const missing = await driver({ toolDirs: [good, path.join(good, 'nope')] }).health();
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('does not exist');
    if (process.platform !== 'win32') {
      const open = tempDir('sas-tools-');
      fs.chmodSync(open, 0o777);
      const world = await driver({ toolDirs: [open] }).health();
      expect(world.ok).toBe(false);
      expect(world.detail).toContain('writable by everyone');
    }
  });
});

test.describe('the environment the program runs in', () => {
  test('only allow-listed variables are passed: a secret in the parent environment never reaches the child', async () => {
    const parentEnv = { PATH: process.env.PATH, HOME: '/home/x', SAS_PASSWORD: SECRET, AWS_SECRET_ACCESS_KEY: 'AKIA-secret', MY_OTHER: 'visible?' };
    const d = driver({ parentEnv });
    const result = await d.run(fake('env=SAS_PASSWORD', 'env=AWS_SECRET_ACCESS_KEY', 'env=MY_OTHER', 'env=HOME'));
    expect(result.stdout).toBe('ENV[SAS_PASSWORD]=<unset>\nENV[AWS_SECRET_ACCESS_KEY]=<unset>\nENV[MY_OTHER]=<unset>\nENV[HOME]=/home/x\n');
  });

  test('SAS_CHILD_ENV_ALLOW replaces the list; a secret-looking name on it is refused', async () => {
    const parentEnv = { PATH: process.env.PATH, MY_OTHER: 'now visible' };
    const d = new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config({ SAS_CHILD_ENV_ALLOW: 'PATH, MY_OTHER' }), toolDirs: [], parentEnv });
    expect((await d.run(fake('env=MY_OTHER'))).stdout).toBe('ENV[MY_OTHER]=now visible\n');
    expect(() => new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config({ SAS_CHILD_ENV_ALLOW: 'PATH,SAS_PASSWORD' }) })).toThrow(/looks like a secret/);
    expect(() => new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config({ SAS_CHILD_ENV_ALLOW: 'PATH,BAD NAME' }) })).toThrow(/not a valid variable name/);
  });

  test('the call can add its own variables; a secret-looking one is masked in the result', async () => {
    const result = await driver({ parentEnv: { PATH: process.env.PATH } }).run({ ...fake('env=SAS_BATCH_TOKEN', 'env=SAS_PROFILE'), env: { SAS_BATCH_TOKEN: SECRET, SAS_PROFILE: 'dev-profile' } });
    expect(result.stdout).toBe('ENV[SAS_BATCH_TOKEN]=***\nENV[SAS_PROFILE]=dev-profile\n');
    await expect(driver().run({ ...fake(), env: { 'BAD NAME': 'x' } })).rejects.toMatchObject({ code: 'invalid-input' });
  });

  test('the working directory is the driver\'s fixed one unless the call gives an absolute one that exists', async () => {
    const fixed = tempDir();
    expect((await driver({ cwd: fixed }).run(fake('cwd'))).stdout.trim()).toBe(fixed);
    const other = tempDir();
    expect((await driver({ cwd: fixed }).run({ ...fake('cwd'), cwd: other })).stdout.trim()).toBe(other);
    await expect(driver().run({ ...fake('cwd'), cwd: 'relative/dir' })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(driver().run({ ...fake('cwd'), cwd: path.join(fixed, 'nope') })).rejects.toThrow(/does not exist/);
  });
});

test.describe('results', () => {
  test('exit code, stdout, stderr, duration - a non-zero exit is a result, not an exception', async () => {
    const result = await driver().run(fake('out=hello', 'err=warning text', 'exit=3'));
    expect(result).toMatchObject({ exitCode: 3, stdout: 'hello\n', stderr: 'warning text\n', timedOut: false, aborted: false, truncated: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('stdin is delivered; a tool that does not read it does not hang or crash the driver', async () => {
    expect((await driver().run({ ...fake('stdin'), stdin: 'line one\nline two' })).stdout).toContain('STDIN[***');
    const big = 'x'.repeat(2_000_000);
    expect((await driver().run({ ...fake('exit=0'), stdin: big })).exitCode).toBe(0); // never read: EPIPE is absorbed
  });

  test('without stdin the program sees a closed input (a tool that prompts gets end-of-file, it does not wait)', async () => {
    const result = await driver().run(fake('stdin'));
    expect(result.stdout).toBe('STDIN[]\n');
  });

  test('output is decoded with the chosen encoding', async () => {
    const result = await driver().run({ ...fake('out=caf\u00e9'), encoding: 'latin1' });
    expect(result.stdout).toBe('caf\u00c3\u00a9\n'); // utf8 bytes read as latin1: proof the option is used
  });
});

test.describe('output cap', () => {
  test('output beyond maxOutputBytes is dropped, the program is not killed for it, and truncated is set', async () => {
    const result = await driver().run({ ...fake('big=500000', 'err=still alive', 'exit=7'), maxOutputBytes: 1000 });
    expect(result.stdout).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('still alive\n');
  });

  test('below the cap nothing is truncated; SAS_PROCESS_MAX_OUTPUT_BYTES sets the default', async () => {
    expect((await driver().run({ ...fake('big=1000'), maxOutputBytes: 1000 })).truncated).toBe(false);
    const d = new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config({ SAS_PROCESS_MAX_OUTPUT_BYTES: '50' }), toolDirs: [] });
    const result = await d.run(fake('big=500'));
    expect(result.stdout).toHaveLength(50);
    await expect(driver().run({ ...fake(), maxOutputBytes: 0 })).rejects.toMatchObject({ code: 'invalid-input' });
  });

  test('a secret cut in half by the cap does not leave its first characters at the end of the output', async () => {
    // 'x' * 995 then the secret: the cap (1000) falls inside it
    const result = await driver().run({ command: NODE, args: [FAKE_TOOL_SOURCE, `out=${'x'.repeat(994)}${SECRET}`], secretArgs: [SECRET], kind: 'read', host: 'sasmeta.dev.example.com', maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain(SECRET.slice(0, 4));
    expect(result.stdout.endsWith('x'.repeat(10))).toBe(true);
  });
});

test.describe('secrets', () => {
  test('secretArgs are replaced by *** in the command line, stdout, stderr - wherever the tool echoes them - and the real value still reaches the program', async () => {
    const result = await driver().run({
      command: NODE,
      args: [FAKE_TOOL_SOURCE, '-user', 'ajoshi', '-password', SECRET, `out=the password is ${SECRET}`, `err=${encodeURIComponent(SECRET)}`, 'argv'],
      secretArgs: [SECRET],
      kind: 'read',
      host: 'sasmeta.dev.example.com',
    });
    expect(result.stdout).toContain('the password is ***');
    expect(result.stderr).toBe('***\n');
    expect(result.commandLine).toContain('-password ***');
    expect(result.commandLine).not.toContain(SECRET);
    expect(result.stdout).toContain('"-password","***"'); // the program received the value; the result shows the mask
    const all = JSON.stringify(result) + inspect(result);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('Sup3r');
  });

  test('the program really received the secret', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'received.txt');
    fs.writeFileSync(path.join(dir, 'probe.js'), `require('node:fs').writeFileSync(${JSON.stringify(file)}, process.argv[2]);`);
    await driver().run({ command: NODE, args: [path.join(dir, 'probe.js'), SECRET], secretArgs: [SECRET], kind: 'read', host: 'sasmeta.dev.example.com' });
    expect(fs.readFileSync(file, 'utf8')).toBe(SECRET);
  });

  test('a value after a flag that is NAMED like a secret is masked in the logged command line even when the caller forgot secretArgs', () => {
    expect(describeCommand('/x/tool', ['-user', 'bob', '-password', 'forgotten1', '--token', 'abc12345', '-name', 'plain'], [])).toBe('tool -user bob -password *** --token *** -name plain');
    expect(describeCommand('/x/tool', ['-password=inline1'], [])).not.toContain('inline1');
    expect(describeCommand('/x/tool', ['a b', 'c'], [])).toBe('tool "a b" c');
    expect(describeCommand('/x/tool', ['x'.repeat(500)], []).length).toBeLessThan(420);
  });

  test('stdin is a secret too: it is masked if the program prints it', async () => {
    const result = await driver().run({ ...fake('stdin'), stdin: `${SECRET}\n` });
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).toContain('***');
  });

  test('a start failure never carries the arguments (Node\'s own error object does) - not in the message, JSON or inspect', async () => {
    const dir = tempDir();
    const broken = path.join(dir, 'broken');
    fs.writeFileSync(broken, 'not a program', { mode: 0o755 }); // executable bit, but no interpreter: spawn fails
    const error = (await driver().run({ command: broken, args: ['-password', SECRET], secretArgs: [SECRET], kind: 'read', host: 'sasmeta.dev.example.com' }).catch((e: unknown) => e)) as ProcessError;
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.code).toBe('spawn-failed');
    const all = `${error.message}${JSON.stringify(error)}${inspect(error, { depth: 6, showHidden: true })}${error.stack}`;
    expect(all).not.toContain(SECRET);
  });
});

test.describe('time limit and the process tree', () => {
  test('a program that runs too long is ended, timedOut is true, exitCode is null - and so is everything it started', async () => {
    test.skip(process.platform === 'win32', 'the process-group kill is POSIX; the Windows command line is checked below (NOT VERIFIED on Windows)');
    const pidFile = path.join(tempDir(), 'child.pid');
    const began = Date.now();
    const result = await driver().run({ ...fake(`child=${pidFile}`, 'sleep=30000'), timeoutMs: 400 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(childPid).toBeGreaterThan(0);
    // the descendant ignores SIGTERM: only the SIGKILL after the grace time ends it
    expect(await waitUntil(() => !isAlive(childPid))).toBe(true);
  });

  test('a program that ignores SIGTERM is still ended (SIGKILL after the grace time)', async () => {
    test.skip(process.platform === 'win32', 'POSIX signals');
    const result = await driver({ killGraceMs: 100 }).run({ ...fake('ignoreterm', 'sleep=30000'), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test('negative control - without the tree kill the descendant survives', async () => {
    test.skip(process.platform === 'win32', 'POSIX process groups');
    const pidFile = path.join(tempDir(), 'child.pid');
    const killed: number[] = [];
    // only the direct child is signalled (what a plain child.kill() does)
    const d = driver({ killTree: (pid) => { killed.push(pid); process.kill(pid, 'SIGKILL'); } });
    await d.run({ ...fake(`child=${pidFile}`, 'sleep=30000'), timeoutMs: 300 });
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(killed).toHaveLength(1);
    expect(isAlive(childPid)).toBe(true);
    process.kill(childPid, 'SIGKILL'); // clean up the survivor
  });

  test('the abort signal ends the program and its tree; an already aborted signal never starts it', async () => {
    test.skip(process.platform === 'win32', 'POSIX process groups');
    const pidFile = path.join(tempDir(), 'child.pid');
    const controller = new AbortController();
    const pending = driver().run({ ...fake(`child=${pidFile}`, 'sleep=30000'), signal: controller.signal, timeoutMs: 20_000 });
    expect(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '')).toBe(true);
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(await waitUntil(() => !isAlive(Number(fs.readFileSync(pidFile, 'utf8'))))).toBe(true);
    await expect(driver().run({ ...fake(), signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  test('a descendant that keeps the output pipe open after the program exited does not hang the driver; it is ended too', async () => {
    test.skip(process.platform === 'win32', 'POSIX process groups');
    const pidFile = path.join(tempDir(), 'child.pid');
    const began = Date.now();
    const result = await driver().run({ ...fake(`child-inherit=${pidFile}`, 'out=done', 'exit=0'), timeoutMs: 20_000 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toBe('done\n');
    expect(await waitUntil(() => !isAlive(Number(fs.readFileSync(pidFile, 'utf8'))))).toBe(true);
  });

  test('close() ends programs that are still running', async () => {
    test.skip(process.platform === 'win32', 'POSIX process groups');
    const pidFile = path.join(tempDir(), 'child.pid');
    const d = driver();
    const pending = d.run({ ...fake(`child=${pidFile}`, 'sleep=30000'), timeoutMs: 20_000 });
    expect(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '')).toBe(true);
    d.close();
    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(await waitUntil(() => !isAlive(Number(fs.readFileSync(pidFile, 'utf8'))))).toBe(true);
  });

  test('on Windows the whole tree is ended with taskkill /T /F, called by absolute path (NOT VERIFIED on Windows: only the command is checked here)', () => {
    expect(windowsTreeKill(4242, 'C:\\Windows')).toEqual({ command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '4242', '/T', '/F'] });
    expect(() => killProcessTree(2_147_483_000, 10, 'linux')).not.toThrow(); // a process group that does not exist is not an error
  });

  test('timeoutMs must be a positive whole number; SAS_PROCESS_TIMEOUT_MS sets the default', async () => {
    await expect(driver().run({ ...fake(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'invalid-input' });
    const d = new ProcessDriver({ guard: new RecordingGuard(), environment: 'dev', env: config({ SAS_PROCESS_TIMEOUT_MS: '300' }), toolDirs: [], killGraceMs: 100, drainMs: 100 });
    expect((await d.run(fake('sleep=10000'))).timedOut).toBe(true);
  });
});

test.describe('every call goes through the guard and the audit log', () => {
  test('the operation handed to the guard carries driver, kind, operation, target, host and the environment; a result is recorded', async () => {
    const guard = new RecordingGuard();
    await driver({}, guard).run({ ...fake('exit=0'), kind: 'update', operation: 'rename-group', target: 'AUTO_x_Users', host: 'sasmeta.dev.example.com' });
    expect(guard.authorized[0]).toEqual({ driver: 'sas-process', operation: 'rename-group', kind: 'update', environment: 'dev', target: 'AUTO_x_Users', host: 'sasmeta.dev.example.com' });
    expect(guard.recorded[0]).toMatchObject({ outcome: 'ok', detail: { tool: 'node', exitCode: 0, timedOut: false } });
    await driver({}, guard).run({ command: NODE, args: [FAKE_TOOL_SOURCE], kind: 'read' });
    expect(guard.authorized[1]?.operation).toBe('run:node');
  });

  test('a refusal stops everything: the program is not started and nothing is recorded as run', async () => {
    const guard = new RecordingGuard();
    guard.deny = new Error('refused');
    const dir = tempDir();
    const marker = path.join(dir, 'ran');
    fs.writeFileSync(path.join(dir, 'touch.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    await expect(driver({}, guard).run({ command: NODE, args: [path.join(dir, 'touch.js')], kind: 'create', target: 'x', local: true })).rejects.toThrow('refused');
    expect(fs.existsSync(marker)).toBe(false);
    expect(guard.recorded).toEqual([]);
  });

  test('a non-zero exit, a timeout and a start failure are recorded as error; exit 0 as ok - with short facts and no arguments', async () => {
    const guard = new RecordingGuard();
    const d = driver({}, guard);
    await d.run(fake('exit=0'));
    await d.run(fake('exit=2'));
    await d.run({ ...fake('sleep=5000'), timeoutMs: 150 });
    await d.run({ command: path.join(tempDir(), 'missing'), kind: 'read', host: 'sasmeta.dev.example.com' }).catch(() => undefined);
    expect(guard.recorded.map((r) => r.outcome)).toEqual(['ok', 'error', 'error', 'error']);
    expect(guard.recorded[3]?.detail).toEqual({ tool: 'missing', error: 'tool-not-found' });
    expect(JSON.stringify(guard.recorded)).not.toContain(FAKE_TOOL_SOURCE);
  });

  test('with the real policy: a mutating call outside the namespace is refused before anything runs; inside it runs and is audited', async () => {
    const { policy, file, run } = realPolicy();
    const d = driver({}, policy);
    const dir = tempDir();
    const marker = path.join(dir, 'ran');
    fs.writeFileSync(path.join(dir, 'touch.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    const call = (target: string) => ({ command: NODE, args: [path.join(dir, 'touch.js')], kind: 'destructive' as const, operation: 'delete-group', target, host: 'sasmeta.dev.example.com' });
    const error = (await d.run(call('/Shared Data/Finance')).catch((e: unknown) => e)) as PolicyViolation;
    expect(error).toBeInstanceOf(PolicyViolation);
    expect(error.rule).toBe('outside-namespace');
    expect(fs.existsSync(marker)).toBe(false);
    expect((await d.run(call(run.ns('Users')))).exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(readAudit(file).map((r) => `${r.outcome}:${r.operation}`)).toEqual(['denied:delete-group', 'ok:delete-group']);
  });

  test('with the real policy: a host outside the environment is refused; prod only reads (and only with SAS_ALLOW_PROD_READS)', async () => {
    const { policy } = realPolicy();
    await expect(driver({}, policy).run({ ...fake(), host: 'sasmeta.example.com' })).rejects.toMatchObject({ rule: 'host-not-allowed' });
    const prod = driver({ environment: 'prod' }, policy);
    await expect(prod.run({ ...fake(), host: 'sasmeta.example.com' })).rejects.toMatchObject({ rule: 'prod-reads-disabled' });
    await expect(prod.run({ ...fake(), kind: 'update', target: 'x', host: 'sasmeta.example.com' })).rejects.toMatchObject({ rule: 'prod-read-only' });
    const reading = driver({ environment: 'prod' }, realPolicy({ SAS_ALLOW_PROD_READS: 'true' }).policy);
    expect((await reading.run({ ...fake('out=ok'), host: 'sasmeta.example.com' })).stdout).toBe('ok\n');
  });

  test('the audit file never contains a secret passed as an argument', async () => {
    const { policy, file } = realPolicy();
    await driver({}, policy).run({ ...fake('exit=1'), args: [FAKE_TOOL_SOURCE, '-password', SECRET, 'exit=1'], secretArgs: [SECRET] });
    expect(fs.readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(readAudit(file)).toHaveLength(1);
  });
});
