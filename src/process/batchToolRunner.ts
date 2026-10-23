import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { ConfigurationError } from '../core/errors';
import { OPERATION_KINDS, type OperationKind } from '../core/operation';
import { maskSecrets } from '../core/secrets';
import type { ProcessDriver, ProcessResult } from './processDriver';

const log = getLogger('sas-batch');

/**
 * A generic wrapper for command-line tools: a named tool, a TABLE of the options it takes, the meaning of its exit codes, and a parser
 * for its output. Nothing about any SAS tool is built in: the option names, the exit codes and the output format of the SAS batch
 * tools must be copied from the documentation of the INSTALLED release into a table (a JSON file, SAS_BATCH_TOOLS_FILE, or code).
 * Every table is NOT VERIFIED until a conformance run on a machine with the real tool has passed - the `verified` flag says so in
 * every result and the first use of an unverified table is logged as a warning.
 *
 * The caller passes LOGICAL option names (`{ package: 'x.spk' }`); the table turns them into the tool's flags. An option that is not
 * in the table is refused (there is no pass-through of raw flags), a value that starts with "-" is refused for an ordinary option
 * (it would be read as another flag), and a secret option is sent as a masked argument or on standard input.
 */

export type BatchValue = string | number | boolean | readonly string[];

export interface BatchOptionSpec {
  /** The tool's own flag, e.g. `-x` or `--name`. Copied from the tool's documentation. */
  flag: string;
  /** `value` (default): `flag value`; `switch`: just the flag, when the value is true; `list`: several values. */
  type?: 'value' | 'switch' | 'list';
  required?: boolean;
  /** The value is a secret: masked everywhere. */
  secret?: boolean;
  /** For a secret: `arg` (default) puts it on the command line - visible to other users of the machine; `stdin` sends it on standard input (only if the tool reads it there). */
  via?: 'arg' | 'stdin';
  /** `separate` (default): two arguments; `joined`: `flag=value`. */
  style?: 'separate' | 'joined';
  /** For `list`: `repeat` (default) repeats the flag per item; otherwise items are joined with this delimiter into one argument. */
  delimiter?: string;
  /** Allow a value that starts with "-". Off by default. */
  allowLeadingDash?: boolean;
  /** A regular expression (source) the whole value must match. */
  pattern?: string;
}

export interface ExitCodeSpec {
  meaning: string;
  ok: boolean;
  /** A retry may help (a busy server) - but never for a rejected logon. */
  retryable?: boolean;
  /** This exit code means the logon was rejected: callers feed it to the LogonGuard. */
  rejectedCredentials?: boolean;
}

export type OutputParser = 'raw' | 'lines' | 'json' | 'keyvalue';

export interface BatchToolSpec {
  /** Logical name, e.g. `export-package`. */
  name: string;
  /** The program: a name in SAS_TOOL_DIRS or an absolute path. */
  command: string;
  /** What the tool does to SAS - decides what the safety policy requires. */
  kind: OperationKind;
  /** Arguments that always come first (a sub-command), exactly as the tool wants them. */
  fixedArgs?: readonly string[];
  options: Readonly<Record<string, BatchOptionSpec>>;
  /** Exit code -> meaning. */
  exitCodes: Readonly<Record<string, ExitCodeSpec>>;
  /** For an exit code not in the table. Default: 0 is ok, anything else is not. */
  unmappedExit?: ExitCodeSpec;
  parse?: OutputParser;
  timeoutMs?: number;
  /** false until a conformance run on the real tool passed. Default false. */
  verified?: boolean;
}

export interface BatchResult<T = unknown> {
  tool: string;
  ok: boolean;
  exitCode: number | null;
  meaning: string;
  retryable: boolean;
  rejectedCredentials: boolean;
  timedOut: boolean;
  data?: T;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The option table has been checked against the real tool. false = NOT VERIFIED. */
  verified: boolean;
}

export class BatchToolFailed extends AdapterError {
  constructor(readonly result: BatchResult) {
    const tail = (text: string) => text.trim().split('\n').slice(-5).join('\n').slice(-500);
    super(
      'sas-batch',
      result.tool,
      `exit ${result.exitCode ?? 'none'}${result.timedOut ? ' (timed out)' : ''}: ${result.meaning}${result.verified ? '' : ' [option table NOT VERIFIED against the installed tool]'}` +
        (result.stderr.trim() ? `\nstderr (last lines): ${tail(result.stderr)}` : ''),
    );
    this.name = 'BatchToolFailed';
    Object.setPrototypeOf(this, BatchToolFailed.prototype);
  }
}

const FLAG = /^[-/]{1,2}[A-Za-z][A-Za-z0-9_-]*$/;

/** Validates the content of a tool table file (`{ "tools": { "<name>": { ... } } }`). */
export function parseBatchToolSpecs(json: unknown, source = 'batch tools'): Record<string, BatchToolSpec> {
  const fail = (message: string) => new ConfigurationError('batch-tools', `${source}: ${message}`);
  const tools = (json as { tools?: unknown } | null)?.tools;
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) throw fail('expected an object with a "tools" map');
  const out: Record<string, BatchToolSpec> = {};
  for (const [name, raw] of Object.entries(tools as Record<string, unknown>)) {
    const spec = raw as Partial<BatchToolSpec>;
    if (typeof raw !== 'object' || raw === null) throw fail(`tool "${name}" must be an object`);
    if (typeof spec.command !== 'string' || spec.command === '') throw fail(`tool "${name}": "command" is required`);
    if (!OPERATION_KINDS.includes(spec.kind as OperationKind)) throw fail(`tool "${name}": "kind" must be one of ${OPERATION_KINDS.join(', ')}`);
    if (typeof spec.options !== 'object' || spec.options === null) throw fail(`tool "${name}": "options" (the option table) is required`);
    for (const [logical, option] of Object.entries(spec.options)) {
      if (typeof option?.flag !== 'string' || !FLAG.test(option.flag)) throw fail(`tool "${name}", option "${logical}": "flag" must look like -x, --name or /x`);
      if (option.type !== undefined && !['value', 'switch', 'list'].includes(option.type)) throw fail(`tool "${name}", option "${logical}": unknown type "${String(option.type)}"`);
      if (option.pattern !== undefined) {
        try {
          new RegExp(option.pattern);
        } catch {
          throw fail(`tool "${name}", option "${logical}": "pattern" is not a valid regular expression`);
        }
      }
    }
    if (typeof spec.exitCodes !== 'object' || spec.exitCodes === null) throw fail(`tool "${name}": "exitCodes" is required`);
    for (const [code, meaning] of Object.entries(spec.exitCodes)) {
      if (!/^-?\d+$/.test(code)) throw fail(`tool "${name}": exit code "${code}" is not a whole number`);
      if (typeof meaning?.meaning !== 'string' || typeof meaning.ok !== 'boolean') throw fail(`tool "${name}", exit code ${code}: needs "meaning" (text) and "ok" (true/false)`);
    }
    if (spec.parse !== undefined && !['raw', 'lines', 'json', 'keyvalue'].includes(spec.parse)) throw fail(`tool "${name}": unknown parse "${String(spec.parse)}"`);
    out[name] = { ...(spec as BatchToolSpec), name };
  }
  return out;
}

/** Reads SAS_BATCH_TOOLS_FILE. Returns {} when it is not set. Every table in it is NOT VERIFIED unless it says `"verified": true` after a conformance run. */
export function loadBatchToolSpecs(env: ConfigReader = loadEnv()): Record<string, BatchToolSpec> {
  const configured = env.getOptional('SAS_BATCH_TOOLS_FILE');
  if (configured === undefined) return {};
  const file = path.resolve(configured);
  if (!fs.existsSync(file)) throw new ConfigurationError('batch-tools', `SAS_BATCH_TOOLS_FILE points to ${file}, which does not exist`);
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigurationError('batch-tools', `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseBatchToolSpecs(json, file);
}

const warnedUnverified = new Set<string>();

export function parseOutput(parser: OutputParser | undefined, stdout: string): unknown {
  switch (parser ?? 'raw') {
    case 'raw':
      return stdout;
    case 'lines':
      return stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== '');
    case 'json':
      return JSON.parse(stdout);
    case 'keyvalue': {
      const out: Record<string, string> = {};
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s*([^:=\s][^:=]*?)\s*[:=]\s*(.*?)\s*$/.exec(line);
        if (m) out[m[1] as string] = m[2] as string;
      }
      return out;
    }
  }
}

export interface BatchCall {
  /** The object the call changes (required by the safety policy for create/update/destructive tools). */
  target?: string | readonly string[];
  /** The host the tool will contact (the metadata server it is told to use). */
  host?: string;
  local?: boolean;
  /** Name for the audit record (default: the tool's name). */
  operation?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Runs one table-described tool through a ProcessDriver (so the policy gate, the audit log, the tool folders, masking and the tree kill
 * all apply) and returns the parsed result with the exit code mapped to a meaning.
 */
export class BatchToolRunner<T = unknown> {
  constructor(
    private readonly driver: ProcessDriver,
    readonly spec: BatchToolSpec,
    private readonly parser?: (stdout: string, stderr: string) => T,
  ) {}

  /** Turns logical values into the tool's arguments. Exported for tests and for `doctor`-style dry runs: nothing is executed. */
  buildArguments(values: Readonly<Record<string, BatchValue | undefined>>): { args: string[]; secretArgs: string[]; stdin?: string } {
    const { spec } = this;
    for (const name of Object.keys(values)) {
      if (values[name] !== undefined && !(name in spec.options)) throw new ConfigurationError('batch-tools', `${spec.name}: option "${name}" is not in the option table (known: ${Object.keys(spec.options).join(', ') || 'none'}). Raw flags cannot be passed through.`);
    }
    const args = [...(spec.fixedArgs ?? [])];
    const secretArgs: string[] = [];
    let stdin: string | undefined;
    for (const [name, option] of Object.entries(spec.options)) {
      const value = values[name];
      if (value === undefined || value === false) {
        if (option.required) throw new ConfigurationError('batch-tools', `${spec.name}: option "${name}" is required`);
        continue;
      }
      const type = option.type ?? 'value';
      if (type === 'switch') {
        if (value !== true) throw new ConfigurationError('batch-tools', `${spec.name}: option "${name}" is a switch: pass true or leave it out`);
        args.push(option.flag);
        continue;
      }
      const items = type === 'list' ? (Array.isArray(value) ? [...(value as readonly string[])] : [String(value)]) : [String(value)];
      if (items.length === 0) {
        if (option.required) throw new ConfigurationError('batch-tools', `${spec.name}: option "${name}" is required`);
        continue;
      }
      for (const item of items) {
        // eslint-disable-next-line no-control-regex
        if (item === '' || /[\u0000-\u001f]/.test(item)) throw new ConfigurationError('batch-tools', `${spec.name}: option "${name}" must be non-empty text without control characters`);
        if (!option.allowLeadingDash && item.startsWith('-')) throw new ConfigurationError('batch-tools', `${spec.name}: the value of option "${name}" starts with "-": the tool would read it as another flag`);
        if (option.pattern && !new RegExp(`^(?:${option.pattern})$`).test(item)) throw new ConfigurationError('batch-tools', `${spec.name}: the value of option "${name}" does not match the allowed pattern ${option.pattern}`);
      }
      if (option.secret && option.via === 'stdin') {
        if (stdin !== undefined || items.length !== 1) throw new ConfigurationError('batch-tools', `${spec.name}: only one single-valued option can be sent on standard input`);
        stdin = `${items[0]}\n`;
        continue;
      }
      const emit = (item: string) => {
        if (option.secret) secretArgs.push(item);
        if ((option.style ?? 'separate') === 'joined') args.push(`${option.flag}=${item}`);
        else args.push(option.flag, item);
      };
      if (type === 'list' && option.delimiter !== undefined) {
        const joined = items.join(option.delimiter);
        if (option.secret) secretArgs.push(joined);
        if ((option.style ?? 'separate') === 'joined') args.push(`${option.flag}=${joined}`);
        else args.push(option.flag, joined);
      } else {
        for (const item of items) emit(item);
      }
    }
    return { args, secretArgs, ...(stdin === undefined ? {} : { stdin }) };
  }

  /** Maps a process result to a BatchResult using the exit-code table. */
  interpret(result: ProcessResult): BatchResult<T> {
    const { spec } = this;
    const mapped = result.exitCode === null ? undefined : spec.exitCodes[String(result.exitCode)];
    const unmapped: ExitCodeSpec = spec.unmappedExit ?? (result.exitCode === 0 ? { meaning: 'exit 0 (not described in the option table)', ok: true } : { meaning: `unmapped exit code ${result.exitCode} (not in the option table)`, ok: false });
    const code = result.timedOut
      ? { meaning: 'timed out: the tool and everything it started were ended', ok: false, retryable: true }
      : result.aborted
        ? { meaning: 'aborted by the caller', ok: false }
        : result.exitCode === null
          ? { meaning: 'ended by a signal', ok: false }
          : (mapped ?? unmapped);
    let data: T | undefined;
    if (code.ok) {
      try {
        data = this.parser ? this.parser(result.stdout, result.stderr) : (parseOutput(spec.parse, result.stdout) as T);
      } catch (error) {
        return {
          tool: spec.name,
          ok: false,
          exitCode: result.exitCode,
          meaning: `the tool reported success but its output could not be parsed (${spec.parse ?? 'custom parser'}): ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
          retryable: false,
          rejectedCredentials: false,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          verified: spec.verified === true,
        };
      }
    }
    return {
      tool: spec.name,
      ok: code.ok,
      exitCode: result.exitCode,
      meaning: code.meaning,
      retryable: (code as ExitCodeSpec).retryable === true,
      rejectedCredentials: (code as ExitCodeSpec).rejectedCredentials === true,
      timedOut: result.timedOut,
      ...(data === undefined ? {} : { data }),
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      verified: spec.verified === true,
    };
  }

  async run(values: Readonly<Record<string, BatchValue | undefined>> = {}, call: BatchCall = {}): Promise<BatchResult<T>> {
    const { spec } = this;
    if (spec.verified !== true && !warnedUnverified.has(spec.name)) {
      warnedUnverified.add(spec.name);
      log.warn(`[sas-batch] the option table of "${spec.name}" is NOT VERIFIED against the installed tool: check it with a conformance run before relying on the results`);
    }
    const { args, secretArgs, stdin } = this.buildArguments(values);
    const result = await this.driver.run({
      command: spec.command,
      args,
      secretArgs,
      ...(stdin === undefined ? {} : { stdin }),
      kind: spec.kind,
      operation: call.operation ?? spec.name,
      ...(call.target === undefined ? {} : { target: call.target }),
      ...(call.host === undefined ? {} : { host: call.host }),
      ...(call.local === undefined ? {} : { local: call.local }),
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.cwd ? { cwd: call.cwd } : {}),
      timeoutMs: call.timeoutMs ?? spec.timeoutMs,
    });
    return this.interpret(result);
  }

  /** `run`, then throws BatchToolFailed when the exit code does not mean success. */
  async runOrThrow(values: Readonly<Record<string, BatchValue | undefined>> = {}, call: BatchCall = {}): Promise<BatchResult<T>> {
    const result = await this.run(values, call);
    if (!result.ok) throw new BatchToolFailed(result);
    return result;
  }
}
