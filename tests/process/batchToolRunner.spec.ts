import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { readAudit } from '../../src/core';
import { BatchToolFailed, BatchToolRunner, loadBatchToolSpecs, parseBatchToolSpecs, parseOutput, type BatchToolSpec } from '../../src/process';
import { config, tempDir, useCleanSasEnv } from '../core/support';
import { RecordingGuard, driver, realPolicy, toolDir } from './helpers';

useCleanSasEnv();

/**
 * The option table below describes the FAKE tool in tests/process/support. It stands for what a team copies from the documentation of
 * a real tool; no SAS option name is built into the package (NOT VERIFIED against any SAS release).
 */
const SECRET = 'Sup3r-S3cret#pw';
const spec = (over: Partial<BatchToolSpec> = {}): BatchToolSpec => ({
  name: 'fake-export',
  command: 'fakebatch',
  kind: 'read',
  options: {
    out: { flag: '--out', style: 'joined' },
    user: { flag: '-user' },
    password: { flag: '-password', secret: true },
    pwstdin: { flag: '-pw', secret: true, via: 'stdin' },
    verbose: { flag: '-v', type: 'switch' },
    names: { flag: '-name', type: 'list' },
    joined: { flag: '-j', type: 'list', delimiter: ',' },
    code: { flag: '--code', pattern: '[a-z0-9]+' },
  },
  exitCodes: {
    '0': { meaning: 'success', ok: true },
    '2': { meaning: 'nothing to export', ok: true },
    '3': { meaning: 'server busy', ok: false, retryable: true },
    '4': { meaning: 'logon rejected', ok: false, rejectedCredentials: true },
  },
  parse: 'lines',
  verified: false,
  ...over,
});

const runner = (over: Partial<BatchToolSpec> = {}, guard = new RecordingGuard()) => new BatchToolRunner(driver({ toolDirs: [toolDir()] }, guard), spec(over));

test.describe('arguments from the option table', () => {
  const build = (values: Record<string, never | string | number | boolean | string[]>) => runner().buildArguments(values);

  test('logical names become the tool\'s flags, in the table order; styles: separate, joined, switch, list (repeated or delimited)', () => {
    expect(build({ user: 'bob', out: 'x.spk', verbose: true, names: ['a', 'b'], joined: ['p', 'q'] }).args).toEqual(['--out=x.spk', '-user', 'bob', '-v', '-name', 'a', '-name', 'b', '-j', 'p,q']);
    expect(build({ verbose: false }).args).toEqual([]);
    expect(runner({ fixedArgs: ['export'] }).buildArguments({ user: 'u' }).args).toEqual(['export', '-user', 'u']);
  });

  test('an option that is not in the table is refused: there is no pass-through of raw flags', () => {
    expect(() => build({ 'rm': 'x' } as never)).toThrow(/option "rm" is not in the option table \(known: out, user/);
  });

  test('a value that starts with "-" (it would be read as another flag), an empty value, a control character and a pattern mismatch are refused', () => {
    expect(() => build({ user: '-delete' })).toThrow(/starts with "-"/);
    expect(() => build({ user: '' })).toThrow(/non-empty text/);
    expect(() => build({ user: 'a\nb' })).toThrow(/control characters/);
    expect(() => build({ code: 'ABC!' })).toThrow(/does not match the allowed pattern/);
    expect(() => build({ code: 'abc1' })).not.toThrow();
    expect(runner({ options: { n: { flag: '-n', allowLeadingDash: true } } }).buildArguments({ n: '-5' }).args).toEqual(['-n', '-5']);
  });

  test('a required option must be given; a switch takes true only', () => {
    const r = runner({ options: { pkg: { flag: '-p', required: true }, v: { flag: '-v', type: 'switch' } } });
    expect(() => r.buildArguments({})).toThrow(/option "pkg" is required/);
    expect(() => r.buildArguments({ pkg: 'x', v: 'yes' as never })).toThrow(/is a switch/);
  });

  test('a secret option is listed in secretArgs; via stdin it never appears in the arguments at all', () => {
    const viaArg = build({ password: SECRET });
    expect(viaArg.secretArgs).toEqual([SECRET]);
    expect(viaArg.args).toEqual(['-password', SECRET]);
    const viaStdin = build({ pwstdin: SECRET });
    expect(viaStdin.args).toEqual([]);
    expect(viaStdin.stdin).toBe(`${SECRET}\n`);
    expect(() => runner({ options: { a: { flag: '-a', secret: true, via: 'stdin' }, b: { flag: '-b', secret: true, via: 'stdin' } } }).buildArguments({ a: 'x', b: 'y' })).toThrow(/only one/);
  });
});

test.describe('running and mapping the exit code', () => {
  /** The fake tool takes key=value tokens, so the table for these runs uses them as "flags" via fixedArgs. */
  const run = (exit: number, extra: Partial<BatchToolSpec> = {}) => runner({ fixedArgs: ['out=line one', 'out=line two', `exit=${exit}`], options: {}, ...extra }).run();

  test('success: ok, the output parsed with the chosen parser, the meaning from the table, verified false', async () => {
    const result = await run(0);
    expect(result).toMatchObject({ ok: true, exitCode: 0, meaning: 'success', retryable: false, rejectedCredentials: false, timedOut: false, verified: false, data: ['line one', 'line two'] });
  });

  test('every code in the table maps to its meaning, ok flag, retryable and rejectedCredentials', async () => {
    expect(await run(2)).toMatchObject({ ok: true, meaning: 'nothing to export' });
    expect(await run(3)).toMatchObject({ ok: false, meaning: 'server busy', retryable: true });
    expect(await run(4)).toMatchObject({ ok: false, meaning: 'logon rejected', rejectedCredentials: true, retryable: false });
    expect((await run(3)).data).toBeUndefined();
  });

  test('a code that is not in the table is not ok (0 excepted) and says so; unmappedExit can override', async () => {
    expect(await run(9)).toMatchObject({ ok: false, meaning: 'unmapped exit code 9 (not in the option table)' });
    expect(await run(0, { exitCodes: {} })).toMatchObject({ ok: true, meaning: 'exit 0 (not described in the option table)' });
    expect(await run(9, { unmappedExit: { meaning: 'something else', ok: false, retryable: true } })).toMatchObject({ meaning: 'something else', retryable: true });
  });

  test('a timeout is not ok, retryable, and says the tree was ended', async () => {
    const result = await runner({ fixedArgs: ['sleep=5000'], options: {}, timeoutMs: 200 }).run();
    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null, retryable: true });
    expect(result.meaning).toContain('timed out');
  });

  test('parsers: raw, lines, json, keyvalue; a bad json is reported as a parse failure, not as success', async () => {
    expect(parseOutput('raw', 'a\nb')).toBe('a\nb');
    expect(parseOutput('lines', 'a\r\n\r\nb  \n')).toEqual(['a', 'b']);
    expect(parseOutput('json', '{"a":1}')).toEqual({ a: 1 });
    expect(parseOutput('keyvalue', 'Name: x\nCount = 3\n\nnot a pair')).toEqual({ Name: 'x', Count: '3' });
    const r = runner({ fixedArgs: ['out=not json', 'exit=0'], options: {}, parse: 'json' });
    const result = await r.run();
    expect(result.ok).toBe(false);
    expect(result.meaning).toContain('output could not be parsed');
  });

  test('a custom parser can be supplied in code', async () => {
    const custom = new BatchToolRunner<number>(driver({ toolDirs: [toolDir()] }), spec({ fixedArgs: ['out=a', 'out=b'], options: {} }), (stdout) => stdout.split('\n').filter(Boolean).length);
    expect((await custom.run()).data).toBe(2);
  });

  test('runOrThrow throws BatchToolFailed with the meaning and the end of stderr; NOT VERIFIED is said in the message', async () => {
    const r = runner({ fixedArgs: ['err=disk is full', 'exit=3'], options: {} });
    const error = (await r.runOrThrow().catch((e: unknown) => e)) as BatchToolFailed;
    expect(error).toBeInstanceOf(BatchToolFailed);
    expect(error.message).toContain('exit 3: server busy');
    expect(error.message).toContain('NOT VERIFIED');
    expect(error.message).toContain('disk is full');
    expect(error.result.retryable).toBe(true);
    const verified = (await runner({ fixedArgs: ['exit=3'], options: {}, verified: true }).runOrThrow().catch((e: unknown) => e)) as Error;
    expect(verified.message).not.toContain('NOT VERIFIED');
  });

  test('a secret passed to the tool is masked in the result, even when the tool echoes it, and never reaches the audit file', async () => {
    const { policy, file } = realPolicy();
    const r = new BatchToolRunner(driver({ toolDirs: [toolDir()] }, policy), spec({ fixedArgs: [`out=echo ${SECRET}`, 'exit=4'], parse: 'raw' }));
    const result = await r.run({ user: 'bob', password: SECRET }, { host: 'sasmeta.dev.example.com' });
    expect(result.stdout).toBe('echo ***\n');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(result.rejectedCredentials).toBe(true);
  });

  test('a password sent via stdin reaches the tool and never appears on its command line', async () => {
    const r = new BatchToolRunner(driver({ toolDirs: [toolDir()] }), spec({ fixedArgs: ['argv', 'stdin'], parse: 'raw' }));
    const result = await r.run({ pwstdin: SECRET });
    expect(result.stdout).toBe('["argv","stdin"]\nSTDIN[***]\n'); // the program got no -pw flag and no secret in its arguments; it read it from stdin (masked here)
  });
});

test.describe('policy and audit', () => {
  test('the table\'s kind and the call\'s target/host go to the guard; the operation is named after the tool', async () => {
    const guard = new RecordingGuard();
    await runner({ kind: 'create', fixedArgs: ['exit=0'], options: {} }, guard).run({}, { target: 'AUTO_x_Folder', host: 'sasmeta.dev.example.com' });
    expect(guard.authorized[0]).toMatchObject({ operation: 'fake-export', kind: 'create', target: 'AUTO_x_Folder', host: 'sasmeta.dev.example.com' });
  });

  test('with the real policy a destructive tool is refused outside the namespace and nothing runs', async () => {
    const { policy, file, run } = realPolicy();
    const dir = tempDir();
    const marker = path.join(dir, 'ran');
    const r = new BatchToolRunner(driver({ toolDirs: [toolDir()] }, policy), spec({ kind: 'destructive', fixedArgs: [`child=${marker}`, 'exit=0'], options: {} }));
    await expect(r.run({}, { target: '/Shared Data/Real', host: 'sasmeta.dev.example.com' })).rejects.toMatchObject({ rule: 'outside-namespace' });
    expect(fs.existsSync(marker)).toBe(false);
    expect((await r.run({}, { target: run.ns('Folder'), host: 'sasmeta.dev.example.com' })).ok).toBe(true);
    expect(readAudit(file).map((x) => x.outcome)).toEqual(['denied', 'ok']);
    if (fs.existsSync(marker)) { try { process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
  });
});

test.describe('the option table file (SAS_BATCH_TOOLS_FILE)', () => {
  const valid = { tools: { 'fake-export': { command: 'fakebatch', kind: 'read', options: { out: { flag: '--out' } }, exitCodes: { '0': { meaning: 'success', ok: true } }, parse: 'lines' } } };

  test('is read, validated and every table is NOT VERIFIED unless it says so; no file configured means none', () => {
    const file = path.join(tempDir(), 'tools.json');
    fs.writeFileSync(file, JSON.stringify(valid));
    const tools = loadBatchToolSpecs(config({ SAS_BATCH_TOOLS_FILE: file }));
    expect(tools['fake-export']).toMatchObject({ name: 'fake-export', command: 'fakebatch', kind: 'read' });
    expect(tools['fake-export']?.verified).toBeUndefined();
    expect(loadBatchToolSpecs(config())).toEqual({});
    expect(() => loadBatchToolSpecs(config({ SAS_BATCH_TOOLS_FILE: path.join(tempDir(), 'none.json') }))).toThrow(/does not exist/);
    fs.writeFileSync(file, '{ nope');
    expect(() => loadBatchToolSpecs(config({ SAS_BATCH_TOOLS_FILE: file }))).toThrow(/not valid JSON/);
  });

  test('bad tables are refused with the tool and option named', () => {
    const tool = valid.tools['fake-export'];
    const bad = (patch: Record<string, unknown>) => () => parseBatchToolSpecs({ tools: { t: { ...tool, ...patch } } });
    expect(bad({ command: '' })).toThrow(/"command" is required/);
    expect(bad({ kind: 'wipe' })).toThrow(/"kind" must be one of/);
    expect(bad({ options: { x: { flag: 'rm -rf' } } })).toThrow(/option "x": "flag" must look like/);
    expect(bad({ options: { x: { flag: '-x', type: 'weird' } } })).toThrow(/unknown type/);
    expect(bad({ options: { x: { flag: '-x', pattern: '(' } } })).toThrow(/not a valid regular expression/);
    expect(bad({ exitCodes: { zero: { meaning: 'x', ok: true } } })).toThrow(/not a whole number/);
    expect(bad({ exitCodes: { '0': { meaning: 'x' } } })).toThrow(/needs "meaning"/);
    expect(bad({ parse: 'xml' })).toThrow(/unknown parse/);
    expect(bad({ options: undefined })).toThrow(/option table/);
    expect(() => parseBatchToolSpecs({})).toThrow(/"tools" map/);
  });
});
