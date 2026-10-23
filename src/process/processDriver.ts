import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, isSensitiveKey, loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { ConfigurationError } from '../core/errors';
import { BaseDriver, type HealthResult } from '../core/health';
import type { Operation, OperationGuard, OperationKind } from '../core/operation';
import { dropPartialSecretAtEnd, MASK, maskSecrets } from '../core/secrets';

const log = getLogger('sas-process');

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** The parent environment variables a child gets by default (SAS_CHILD_ENV_ALLOW replaces the list). Nothing named like a secret is ever allowed. */
export const DEFAULT_CHILD_ENV_ALLOW = [
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'COMPUTERNAME',
  'USERNAME',
  'USERDOMAIN',
  'LANG',
  'LC_ALL',
  'TZ',
  'JAVA_HOME',
];

export type ProcessErrorCode = 'invalid-input' | 'tool-not-found' | 'tool-not-allowed' | 'spawn-failed' | 'aborted';

/** A command could not be started (or was refused before it started). Its message never contains a secret. */
export class ProcessError extends AdapterError {
  constructor(readonly code: ProcessErrorCode, message: string, secrets: readonly string[] = []) {
    super('sas-process', 'run', maskSecrets(message, secrets));
    this.name = 'ProcessError';
    Object.setPrototypeOf(this, ProcessError.prototype);
  }
}

export interface RunOptions {
  /** A tool name found ONLY in the SAS_TOOL_DIRS folders, or an absolute path. Never looked up on PATH or in the working directory. */
  command: string;
  /** Arguments, one array element each. They are passed to the program as they are: there is no shell, so no quoting and no injection. */
  args?: readonly string[];
  /** The values in `args` that are secrets: replaced by *** in every log, error and result. Prefer `stdin` where the tool allows it. */
  secretArgs?: readonly string[];
  /** Sent to the program's standard input (a password, for a tool that reads it there). Always treated as a secret in the output. */
  stdin?: string;
  /** Absolute working directory (default: the driver's `cwd`). */
  cwd?: string;
  /** Extra environment variables for the child (the caller's own values). A name that looks like a secret has its value masked in results. */
  env?: Readonly<Record<string, string>>;
  /** Default SAS_PROCESS_TIMEOUT_MS (120 s). */
  timeoutMs?: number;
  /** Per stream; default SAS_PROCESS_MAX_OUTPUT_BYTES (1 MiB). Output beyond it is dropped and `truncated` is set. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** How the output bytes are decoded. Default utf8; a Windows tool may write the OEM or ANSI code page (NOT VERIFIED for SAS tools). */
  encoding?: BufferEncoding;

  // ---- what the safety policy needs to decide ----
  /** What the command does to SAS. Required: there is no default that would be safe. */
  kind: OperationKind;
  /** Name for the audit record. Default `run:<tool>`. */
  operation?: string;
  target?: string | readonly string[];
  host?: string;
  local?: boolean;
}

export interface ProcessResult {
  /** null when the program was ended by a signal (a timeout or an abort). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Either stream was cut at maxOutputBytes. */
  truncated: boolean;
  /** The command as logged: tool name and arguments with every secret replaced by ***. */
  commandLine: string;
}

export interface ProcessDriverOptions {
  guard: OperationGuard;
  /** The selected environment's name (`dev`, `qa`, ...). */
  environment: string;
  env?: ConfigReader;
  /** Folders the tools may be found in. Default SAS_TOOL_DIRS (comma-separated). */
  toolDirs?: readonly string[];
  /** May a caller name an absolute path outside the tool folders? Default true; false locks the driver to SAS_TOOL_DIRS. */
  allowExplicitPaths?: boolean;
  /** Parent variables a child inherits. Default SAS_CHILD_ENV_ALLOW, else DEFAULT_CHILD_ENV_ALLOW. */
  childEnvAllow?: readonly string[];
  /** The environment the child's variables are taken from (default process.env). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Default working directory (default process.cwd()). */
  cwd?: string;
  killGraceMs?: number;
  /** After the program exits, how long its output pipes may stay open (a descendant holding them) before they are closed and the tree is killed. */
  drainMs?: number;
  /** Replaces the tree kill (tests). */
  killTree?: (pid: number) => void;
  platform?: NodeJS.Platform;
}

export interface ResolvedTool {
  path: string;
  via: 'tool-dir' | 'explicit';
}

/** The command that ends a process tree on Windows (`taskkill /T /F`), by absolute path so a planted taskkill on PATH is not used. */
export function windowsTreeKill(pid: number, systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows'): { command: string; args: string[] } {
  return { command: path.win32.join(systemRoot, 'System32', 'taskkill.exe'), args: ['/pid', String(pid), '/T', '/F'] };
}

/**
 * Ends a process and everything it started. Windows: `taskkill /pid N /T /F`. Elsewhere the child was started as the leader of its own
 * process group, so the group is sent SIGTERM and, after `graceMs`, SIGKILL (a program that ignores SIGTERM does not survive).
 * NOT VERIFIED on Windows: only the command line is tested here.
 */
export function killProcessTree(pid: number, graceMs = DEFAULT_KILL_GRACE_MS, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const { command, args } = windowsTreeKill(pid);
    try {
      const killer = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', (error) => log.warn(`[sas-process] taskkill failed: ${error.message}`));
    } catch (error) {
      log.warn(`[sas-process] taskkill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false; // ESRCH: the group is already gone
    }
  };
  if (!signalGroup('SIGTERM')) return;
  setTimeout(() => signalGroup('SIGKILL'), graceMs).unref();
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Finds the executable. A bare name (no separators) is searched ONLY in `toolDirs`; an absolute path is accepted when it is inside a
 * tool folder or when explicit paths are allowed; anything else (a relative path, `..`) is refused. The real path (symbolic links
 * resolved) of a tool found in a tool folder must stay inside that folder. `.bat` / `.cmd` are refused: they need a shell.
 */
export function resolveTool(command: string, options: { toolDirs: readonly string[]; allowExplicitPaths?: boolean; platform?: NodeJS.Platform }): ResolvedTool {
  const platform = options.platform ?? process.platform;
  const fail = (code: ProcessErrorCode, message: string) => new ProcessError(code, message);
  if (typeof command !== 'string' || command.trim() === '') throw fail('invalid-input', 'the command is empty');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(command)) throw fail('invalid-input', 'the command contains control characters');
  if (/\.(bat|cmd)$/i.test(command)) throw fail('tool-not-allowed', `"${path.basename(command)}" is a batch file: it can only run through a shell, and this driver never uses one. Use the program the batch file calls.`);

  const hasSeparator = /[\\/]/.test(command);
  const extensions = platform === 'win32' && path.extname(command) === '' ? ['', '.exe', '.com'] : [''];
  const isFile = (file: string) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const real = (file: string) => fs.realpathSync(file);

  if (!hasSeparator) {
    for (const dir of options.toolDirs) {
      for (const extension of extensions) {
        const candidate = path.join(dir, command + extension);
        if (!isFile(candidate)) continue;
        let realDir: string;
        try {
          realDir = real(dir);
        } catch {
          continue;
        }
        const target = real(candidate);
        if (!isInside(realDir, target))
          throw fail('tool-not-allowed', `"${command}" in ${dir} is a link to ${target}, which is outside that tool folder. Refused: a tool folder only runs what is inside it.`);
        return { path: target, via: 'tool-dir' };
      }
    }
    throw fail('tool-not-found', `tool "${command}" was not found in the allowed tool folders (SAS_TOOL_DIRS: ${options.toolDirs.length ? options.toolDirs.join(', ') : 'not set'}). The driver never searches PATH or the working directory.`);
  }

  if (!(platform === 'win32' ? path.win32.isAbsolute(command) : path.isAbsolute(command)))
    throw fail('tool-not-allowed', `"${command}" is a relative path. Give a tool name that lives in SAS_TOOL_DIRS, or an absolute path.`);
  if (command.split(/[\\/]/).includes('..')) throw fail('tool-not-allowed', `"${command}" contains "..": give the real path.`);
  const file = extensions.map((ext) => command + ext).find(isFile);
  if (!file) throw fail('tool-not-found', `"${command}" does not exist or is not a file.`);
  const target = real(file);
  if (platform !== 'win32') {
    try {
      fs.accessSync(target, fs.constants.X_OK);
    } catch {
      throw fail('tool-not-allowed', `"${target}" is not executable.`);
    }
  }
  for (const dir of options.toolDirs) {
    try {
      if (isInside(real(dir), target)) return { path: target, via: 'tool-dir' };
    } catch {
      /* a missing tool folder cannot contain it */
    }
  }
  if (options.allowExplicitPaths === false) throw fail('tool-not-allowed', `"${target}" is outside the allowed tool folders (SAS_TOOL_DIRS: ${options.toolDirs.join(', ') || 'not set'}) and explicit paths are switched off.`);
  return { path: target, via: 'explicit' };
}

/** What `commandLine` shows: arguments with each declared secret masked, and the value after a flag that is named like a secret (`-password x`). */
export function describeCommand(tool: string, args: readonly string[], secrets: readonly string[]): string {
  const parts: string[] = [path.basename(tool)];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext && !arg.startsWith('-')) {
      parts.push(MASK);
      maskNext = false;
      continue;
    }
    maskNext = /^[-/]{1,2}[A-Za-z]/.test(arg) && !arg.includes('=') && isSensitiveKey(arg.replace(/^[-/]+/, ''));
    parts.push(maskSecrets(arg, secrets));
  }
  const line = parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
  return line.length > 400 ? `${line.slice(0, 400)}...` : line;
}

class Capture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    const room = this.max - this.bytes;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes = this.max;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
  }
  text(encoding: BufferEncoding): string {
    return Buffer.concat(this.chunks).toString(encoding);
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_()]*$/;

/**
 * Runs command-line tools - and only those - safely: no shell (arguments are an array), an executable found only in the allowed
 * folders, a minimal environment, a time limit with a tree kill, a cap on captured output, secrets masked everywhere, every call
 * authorized by the OperationGuard and written to the audit log.
 */
export class ProcessDriver extends BaseDriver {
  readonly name = 'sas-process';
  readonly toolDirs: readonly string[];
  private readonly env: ConfigReader;
  private readonly active = new Set<ChildProcess>();
  private readonly childEnvAllow: readonly string[];

  constructor(private readonly options: ProcessDriverOptions) {
    super();
    this.env = options.env ?? loadEnv();
    this.toolDirs = (options.toolDirs ?? this.env.getList('SAS_TOOL_DIRS')).map((dir) => path.resolve(dir));
    this.childEnvAllow = options.childEnvAllow ?? this.env.getList('SAS_CHILD_ENV_ALLOW', DEFAULT_CHILD_ENV_ALLOW);
    for (const name of this.childEnvAllow) {
      if (!ENV_NAME.test(name)) throw new ConfigurationError('process', `SAS_CHILD_ENV_ALLOW: "${name}" is not a valid variable name`);
      if (isSensitiveKey(name))
        throw new ConfigurationError('process', `SAS_CHILD_ENV_ALLOW: "${name}" looks like a secret and cannot be passed to a child on the allow-list. Pass a secret with secretArgs, stdin or an explicit env entry on the call.`);
    }
  }

  async health(): Promise<HealthResult> {
    if (this.toolDirs.length === 0) return { ok: true, detail: 'no tool folders configured (SAS_TOOL_DIRS): only explicit paths can be run' };
    const problems: string[] = [];
    for (const dir of this.toolDirs) {
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) problems.push(`${dir} is not a folder`);
        else if (process.platform !== 'win32' && (stat.mode & 0o002) !== 0) problems.push(`${dir} is writable by everyone: anybody could plant a tool there`);
      } catch {
        problems.push(`${dir} does not exist`);
      }
    }
    return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `${this.toolDirs.length} tool folder(s)` };
  }

  close(): void {
    for (const child of this.active) this.kill(child.pid);
    this.active.clear();
  }

  private kill(pid: number | undefined): void {
    if (pid === undefined) return;
    if (this.options.killTree) this.options.killTree(pid);
    else killProcessTree(pid, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, this.options.platform);
  }

  private buildEnv(extra: Readonly<Record<string, string>> | undefined, secrets: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const allowed = new Set(this.childEnvAllow.map((name) => name.toLowerCase()));
    for (const [name, value] of Object.entries(this.options.parentEnv ?? process.env)) {
      if (value !== undefined && allowed.has(name.toLowerCase())) out[name] = value;
    }
    for (const [name, value] of Object.entries(extra ?? {})) {
      if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0')) throw new ProcessError('invalid-input', `environment variable "${name}" is not valid`);
      for (const existing of Object.keys(out)) if (existing.toLowerCase() === name.toLowerCase()) delete out[existing];
      out[name] = value;
      if (isSensitiveKey(name) && value !== '') secrets.push(value);
    }
    return out;
  }

  /** Runs one command. Resolves with the result for any exit code (map codes yourself); rejects with PolicyViolation (refused) or ProcessError (could not start). */
  async run(options: RunOptions): Promise<ProcessResult> {
    const args = [...(options.args ?? [])];
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new ProcessError('invalid-input', 'every argument must be a text without NUL characters');
    const secrets = [...(options.secretArgs ?? [])];
    if (options.stdin !== undefined) secrets.push(options.stdin, ...options.stdin.split(/\r?\n/).filter((line) => line.trim() !== ''));
    const tool = path.basename(options.command);
    const op: Operation = {
      driver: this.name,
      operation: options.operation ?? `run:${tool}`,
      kind: options.kind,
      environment: this.options.environment,
      ...(options.target === undefined ? {} : { target: options.target }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.local === undefined ? {} : { local: options.local }),
    };
    this.options.guard.authorize(op);
    const startedAt = Date.now();
    let result: ProcessResult | undefined;
    let failure: unknown;
    try {
      result = await this.execute(options, args, secrets, startedAt);
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const ok = result !== undefined && result.exitCode === 0 && !result.timedOut && !result.aborted;
      this.options.guard.record({
        op,
        outcome: ok ? 'ok' : 'error',
        durationMs: Date.now() - startedAt,
        detail: result
          ? { tool, exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted, truncated: result.truncated }
          : { tool, error: failure instanceof ProcessError ? failure.code : 'failed' },
      });
    }
  }

  private async execute(options: RunOptions, args: string[], secrets: string[], startedAt: number): Promise<ProcessResult> {
    const timeoutMs = options.timeoutMs ?? this.env.getInt('SAS_PROCESS_TIMEOUT_MS', DEFAULT_PROCESS_TIMEOUT_MS);
    const maxOutputBytes = options.maxOutputBytes ?? this.env.getInt('SAS_PROCESS_MAX_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ProcessError('invalid-input', `timeoutMs must be a whole number of milliseconds >= 1 (found ${timeoutMs})`);
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new ProcessError('invalid-input', `maxOutputBytes must be a whole number >= 1 (found ${maxOutputBytes})`);
    const cwd = path.resolve(options.cwd ?? this.options.cwd ?? process.cwd());
    if (options.cwd !== undefined && !path.isAbsolute(options.cwd)) throw new ProcessError('invalid-input', 'cwd must be an absolute path');
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ProcessError('invalid-input', `working directory ${cwd} does not exist`);
    if (options.signal?.aborted) throw new ProcessError('aborted', 'aborted before the command started');

    const tool = resolveTool(options.command, { toolDirs: this.toolDirs, allowExplicitPaths: this.options.allowExplicitPaths, platform: this.options.platform });
    const env = this.buildEnv(options.env, secrets);
    const encoding = options.encoding ?? 'utf8';
    const commandLine = describeCommand(tool.path, args, secrets);
    log.info(`[sas-process] run ${commandLine}`);

    const drainMs = this.options.drainMs ?? 500;
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(tool.path, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          detached: (this.options.platform ?? process.platform) !== 'win32',
          stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new ProcessError('spawn-failed', `could not start ${path.basename(tool.path)}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, secrets));
        return;
      }
      this.active.add(child);
      const out = new Capture(maxOutputBytes);
      const err = new Capture(maxOutputBytes);
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => undefined); // the program may exit without reading it
        child.stdin.end(options.stdin);
      }

      let timedOut = false;
      let aborted = false;
      let exitCode: number | null | undefined;
      let finished = false;
      let drainTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        aborted = true;
        this.kill(child.pid);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        log.warn(`[sas-process] ${path.basename(tool.path)} ran longer than ${timeoutMs} ms: ending it and everything it started`);
        this.kill(child.pid);
      }, timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        options.signal?.removeEventListener('abort', onAbort);
        this.active.delete(child);
        const truncated = out.truncated || err.truncated;
        const text = (capture: Capture) => {
          const raw = capture.text(encoding);
          return maskSecrets(capture.truncated ? dropPartialSecretAtEnd(raw, secrets) : raw, secrets);
        };
        const result: ProcessResult = {
          exitCode: exitCode ?? null,
          stdout: text(out),
          stderr: text(err),
          durationMs: Date.now() - startedAt,
          timedOut,
          aborted,
          truncated,
          commandLine,
        };
        log.info(`[sas-process] ${path.basename(tool.path)} finished: exit ${result.exitCode ?? 'none (ended by signal)'}${timedOut ? ', TIMED OUT' : ''}${aborted ? ', ABORTED' : ''}${truncated ? ', output truncated' : ''} (${result.durationMs} ms)`);
        resolve(result);
      };

      child.once('error', (error: NodeJS.ErrnoException) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        options.signal?.removeEventListener('abort', onAbort);
        this.active.delete(child);
        // only the code is kept: Node's own error object carries the full argument list, secrets included
        reject(new ProcessError('spawn-failed', `could not start ${path.basename(tool.path)}: ${error.code ?? 'error'}`, secrets));
      });
      child.once('exit', (code) => {
        exitCode = code;
        // a descendant that inherited the output pipes keeps them open: give it a moment, then close the pipes and end the tree
        drainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          if ((this.options.platform ?? process.platform) !== 'win32') this.kill(child.pid);
          finish();
        }, drainMs);
      });
      child.once('close', (code) => {
        if (exitCode === undefined) exitCode = code;
        finish();
      });
    });
  }
}
