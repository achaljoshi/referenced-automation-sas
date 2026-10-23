import { quote } from './names';
import { redactSource, secretKindOfName, SECRET_ENV_VAR } from './secrets';
import { DEFAULT_TAG, DEFAULT_TEST_IMPORT, NO_ASSERTION_TODO, type Warning } from './generator';

/**
 * Reads the script SAS Enterprise Guide writes for File > Schedule Project (VBScript) - or its PowerShell equivalent - and writes a test that does
 * the same through the Enterprise Guide COM driver (src/desktop/apps/enterpriseGuide.ts): connect, SetActiveProfile, Open, Run, Save, Close, Quit.
 *
 * ASSUMED, from SAS's own documentation and community write-ups of that script (NOT checked against a generated script of the installed version):
 *   Set app = CreateObject("SASEGObjectModel.Application.7.1")        the version is the one of the installed Enterprise Guide
 *   app.SetActiveProfile("My Server")                                  optional: which server profile the project runs against
 *   Set prj = app.Open("C:\Projects\Sales.egp", "")                    the second argument is empty
 *   prj.Run                                                            runs every item of the project (also prj.Save, prj.Close, app.Quit)
 *   prj.ContainerCollection.Item("Process Flow 1").Run                 runs one process flow, found by NAME (an index is not supported)
 * Anything else becomes `TODO(manual, line N)` in the test and fails --strict. Profile names (they identify a server) and anything that looks like a
 * password are never written into the test: they are read from the environment (SAS_EG_PROFILE, SAS_PASSWORD ...).
 */

export type ScriptKind = 'vbs' | 'ps1';

/** What a value in the script is: a literal, or something read from the environment at run time. */
export type Value = { kind: 'literal'; value: string } | { kind: 'env'; name: string; fallback?: string };

export type ScriptStep =
  | { kind: 'connect'; line: number; progId: string }
  | { kind: 'profile'; line: number; value: Value }
  | { kind: 'open'; line: number; path: Value }
  | { kind: 'run'; line: number }
  | { kind: 'runFlow'; line: number; name: Value }
  | { kind: 'save'; line: number }
  | { kind: 'close'; line: number }
  | { kind: 'quit'; line: number }
  | { kind: 'todo'; line: number; source: string; reason: string };

export interface ScriptParse {
  kind: ScriptKind;
  steps: ScriptStep[];
  warnings: Warning[];
}

/** Turns the bytes of a script into text: UTF-16 (with a byte order mark), UTF-8 (with or without), or plain ANSI. */
export function decodeScript(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  return bytes.toString('utf8');
}

export function detectKind(text: string, fileName = ''): ScriptKind {
  if (/\.ps1$/i.test(fileName)) return 'ps1';
  if (/\.vbs$/i.test(fileName)) return 'vbs';
  return /New-Object\s+-ComObject|\$\w+\s*=|Write-Host|\[System\./i.test(text) && !/CreateObject\s*\(/i.test(text) ? 'ps1' : 'vbs';
}

// ---------------------------------------------------------------------------------------------------------------------- reading lines

interface Line {
  /** 1-based line number of the statement's first physical line. */
  number: number;
  text: string;
}

/** Cuts a line at the first comment marker that is outside a string. */
function stripComment(line: string, kind: ScriptKind): string {
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoteChar) {
      if (ch === quoteChar) {
        if (line[i + 1] === quoteChar) i++; // doubled quote inside a string
        else quoteChar = '';
      } else if (kind === 'ps1' && ch === '`' && quoteChar === '"') i++;
      continue;
    }
    if (ch === '"' || (ch === "'" && kind === 'ps1')) quoteChar = ch;
    else if (kind === 'vbs' && ch === "'") return line.slice(0, i);
    else if (kind === 'ps1' && ch === '#') return line.slice(0, i);
  }
  return line;
}

/** Splits a script into statements: comments removed, continued lines joined, `:` (VBScript) and `;` (PowerShell) split. */
function statements(text: string, kind: ScriptKind): Line[] {
  const out: Line[] = [];
  let pending: Line | undefined;
  let inBlock = false;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, index) => {
    let line = raw;
    if (kind === 'ps1') {
      if (inBlock) {
        const end = line.indexOf('#>');
        if (end < 0) return;
        line = line.slice(end + 2);
        inBlock = false;
      }
      const start = line.indexOf('<#');
      if (start >= 0) {
        const end = line.indexOf('#>', start);
        if (end >= 0) line = line.slice(0, start) + line.slice(end + 2);
        else {
          line = line.slice(0, start);
          inBlock = true;
        }
      }
    }
    line = stripComment(line, kind);
    if (kind === 'vbs' && /^\s*rem\b/i.test(line)) line = '';
    const continues = kind === 'vbs' ? /\s_\s*$/.test(line) : /`\s*$/.test(line);
    const cleaned = continues ? line.replace(kind === 'vbs' ? /\s_\s*$/ : /`\s*$/, ' ') : line;
    if (pending) {
      pending.text += cleaned;
      if (!continues) {
        out.push(pending);
        pending = undefined;
      }
      return;
    }
    if (continues) {
      pending = { number: index + 1, text: cleaned };
      return;
    }
    if (cleaned.trim() !== '') out.push({ number: index + 1, text: cleaned });
  });
  if (pending) out.push(pending);
  // split on statement separators outside strings
  const split: Line[] = [];
  const separator = kind === 'vbs' ? ':' : ';';
  for (const line of out) {
    let quoteChar = '';
    let start = 0;
    const text = line.text;
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (ch !== undefined && quoteChar) {
        if (ch === quoteChar) {
          if (text[i + 1] === quoteChar) i++;
          else quoteChar = '';
        }
        continue;
      }
      if (ch === '"' || (ch === "'" && kind === 'ps1')) quoteChar = ch;
      else if (ch === undefined || ch === separator) {
        const part = text.slice(start, i).trim();
        if (part !== '') split.push({ number: line.number, text: part });
        start = i + 1;
      }
    }
  }
  return split;
}

// ---------------------------------------------------------------------------------------------------------------------- values

/** Splits `text` at `separator` outside strings and parentheses. */
function splitTop(text: string, separator: string, kind: ScriptKind): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoteChar = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoteChar) {
      if (ch === quoteChar) {
        if (text[i + 1] === quoteChar) i++;
        else quoteChar = '';
      } else if (kind === 'ps1' && ch === '`' && quoteChar === '"') i++;
      continue;
    }
    if (ch === '"' || (ch === "'" && kind === 'ps1')) quoteChar = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

class Reader {
  readonly steps: ScriptStep[] = [];
  readonly warnings: Warning[] = [];
  private readonly vars = new Map<string, Value>();
  private readonly apps = new Set<string>();
  private readonly projects = new Set<string>();
  private connected = false;
  /** How many blocks of control flow (If, For, Try ...) the statement being read is inside. */
  private depth = 0;

  constructor(readonly kind: ScriptKind) {}

  private name(raw: string): string {
    return (this.kind === 'ps1' ? raw.replace(/^\$/, '') : raw).toLowerCase();
  }

  private todo(line: Line, reason: string): void {
    this.steps.push({ kind: 'todo', line: line.number, source: redactSource(line.text.trim()), reason });
    this.warnings.push({ event: line.number, severity: 'todo', message: `${redactSource(line.text.trim())} - ${reason}` });
  }

  private info(line: Line, message: string): void {
    this.warnings.push({ event: line.number, severity: 'info', message });
  }

  /** A string expression: literals, known variables, joined with & (VBScript) or + (PowerShell). */
  value(text: string): Value | undefined {
    const parts = splitTop(text.trim(), this.kind === 'vbs' ? '&' : '+', this.kind);
    let literal = '';
    for (const part of parts) {
      const piece = this.piece(part);
      if (piece === undefined) return undefined;
      if (piece.kind === 'env') return parts.length === 1 ? piece : undefined; // an environment read cannot be joined to text here
      literal += piece.value;
    }
    return { kind: 'literal', value: literal };
  }

  private piece(text: string): Value | undefined {
    const t = text.trim();
    if (this.kind === 'vbs') {
      const m = /^"((?:[^"]|"")*)"$/.exec(t);
      if (m) return { kind: 'literal', value: (m[1] as string).replace(/""/g, '"') };
      if (/^[A-Za-z_]\w*$/.test(t)) return this.vars.get(t.toLowerCase());
      if (/^vbCrLf$/i.test(t)) return { kind: 'literal', value: '\r\n' };
      return undefined;
    }
    const single = /^'((?:[^']|'')*)'$/.exec(t);
    if (single) return { kind: 'literal', value: (single[1] as string).replace(/''/g, "'") };
    const double = /^"((?:[^"`$]|`.)*)"$/.exec(t);
    if (double) return { kind: 'literal', value: (double[1] as string).replace(/`(.)/g, '$1') }; // no $ in it: nothing is interpolated
    if (/^\$[A-Za-z_]\w*$/.test(t)) return this.vars.get(t.slice(1).toLowerCase());
    return undefined;
  }

  private args(text: string): string[] {
    const inner = text.trim().replace(/^\(/, '').replace(/\)$/, '');
    return inner === '' ? [] : splitTop(inner, ',', this.kind);
  }

  read(lines: Line[]): void {
    for (const line of lines) this.statement(line);
  }

  /** Control flow is not converted: the line that starts a block, every line inside it and the line that ends it are TODOs (run unconditionally, a step would mean something else). */
  private controlFlow(line: Line, s: string): boolean {
    if (this.kind === 'vbs') {
      const opens = /^(if\b.*\bthen\s*$|for\b|do\b|while\b|select\s+case\b|with\b|sub\b|function\b)/i.test(s);
      const closes = /^(end\s+(if|select|with|sub|function)\b|next\b|loop\b|wend\b)/i.test(s);
      const branch = /^(else\b|elseif\b|case\b)/i.test(s);
      const singleLineIf = /^if\b.*\bthen\b\s*\S/i.test(s);
      if (!opens && !closes && !branch && !singleLineIf && this.depth === 0) return false;
      if (opens) this.depth++;
      if (closes) this.depth = Math.max(0, this.depth - 1);
    } else {
      let net = 0;
      let quoteChar = '';
      for (const ch of s) {
        if (quoteChar) {
          if (ch === quoteChar) quoteChar = '';
        } else if (ch === '"' || ch === "'") quoteChar = ch;
        else if (ch === '{') net++;
        else if (ch === '}') net--;
      }
      const keyword = /^(if|elseif|else|foreach|for|while|do|switch|try|catch|finally|function|trap)\b/i.test(s);
      if (net === 0 && !keyword && this.depth === 0) return false;
      this.depth = Math.max(0, this.depth + net);
    }
    this.todo(line, 'it starts, ends or is inside a block of control flow (If, For, Do, Try ...): control flow is not converted - run unconditionally the step would mean something else');
    return true;
  }

  private statement(line: Line): void {
    let s = line.text.trim();
    if (this.controlFlow(line, s)) return;
    // PowerShell: results thrown away are still calls
    s = s.replace(/^\[void\]\s*/i, '').replace(/^\$null\s*=\s*/i, '');
    if (this.kind === 'vbs') {
      if (/^(option\s+explicit|dim\b|on\s+error\s+goto\s+0)/i.test(s) || /^set\s+\w+\s*=\s*nothing$/i.test(s)) return;
      if (/^on\s+error\s+resume\s+next/i.test(s)) return this.todo(line, 'On Error Resume Next swallows errors: the test fails on the first error instead - decide what should be tolerated');
      if (/^wscript\.echo\b/i.test(s)) return this.info(line, 'WScript.Echo is not carried over (the test report says what happened)');
      if (/^wscript\.sleep\b/i.test(s)) return this.info(line, 'WScript.Sleep dropped - the driver waits for Enterprise Guide itself');
      if (/^wscript\.quit\b/i.test(s)) return this.info(line, 'WScript.Quit is not carried over (a failed step fails the test)');
      s = s.replace(/^set\s+/i, '');
    } else {
      if (/^\$ErrorActionPreference\b|^Set-StrictMode\b/i.test(s)) return;
      if (/^(Write-Host|Write-Output|Write-Verbose|Write-Information|Write-Warning)\b/i.test(s)) return this.info(line, 'console output is not carried over (the test report says what happened)');
      if (/^Start-Sleep\b/i.test(s)) return this.info(line, 'Start-Sleep dropped - the driver waits for Enterprise Guide itself');
      if (/^exit\b/i.test(s)) return this.info(line, 'exit is not carried over (a failed step fails the test)');
      if (/^\[System\.Runtime\.InteropServices\.Marshal\]::(Final)?ReleaseComObject/i.test(s) || /^\[GC\]::/i.test(s)) return this.info(line, 'releasing COM objects is done by quit()');
      if (/^\$?\w+\s*=\s*\$null$/i.test(s)) return;
    }

    // name = right-hand side
    const assignment = this.kind === 'vbs' ? /^(?:const\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/i.exec(s) : /^(\$[A-Za-z_]\w*)\s*=\s*(.+)$/.exec(s);
    if (assignment) return this.assign(line, assignment[1] as string, (assignment[2] as string).trim());

    // object.Method [arguments]
    const call = /^((?:\$)?[A-Za-z_]\w*)((?:\.[A-Za-z_]\w*(?:\([^)]*\))?)+)\s*(.*)$/.exec(s);
    if (call) return this.call(line, call[1] as string, call[2] as string, (call[3] as string).trim());
    this.todo(line, 'not a statement the importer understands');
  }

  private assign(line: Line, rawName: string, rhs: string): void {
    const name = this.name(rawName);
    const create = this.kind === 'vbs' ? /^CreateObject\s*\(\s*"([^"]*)"\s*\)$/i.exec(rhs) : /^New-Object\s+(?:-ComObject\s+)?["']?([A-Za-z0-9_.]+)["']?$/i.exec(rhs);
    if (create) {
      const progId = create[1] as string;
      if (!/^SASEGObjectModel\.Application(\.[0-9.]+)?$/i.test(progId)) return this.todo(line, `only the Enterprise Guide object model (SASEGObjectModel.Application.x.y) is supported, not ${progId}`);
      this.apps.add(name);
      this.steps.push({ kind: 'connect', line: line.number, progId });
      this.connected = true;
      return;
    }
    const open = new RegExp(`^(\\$?[A-Za-z_]\\w*)\\.Open\\b\\s*(.*)$`, 'i').exec(rhs);
    if (open && this.apps.has(this.name(open[1] as string))) {
      this.projects.add(name);
      return this.open(line, (open[2] as string).trim());
    }
    if (/^(nothing|\$null)$/i.test(rhs)) return;
    const value = this.value(rhs);
    if (value) {
      // a variable named like a secret never keeps its literal
      const kind = secretKindOfName(rawName);
      if (kind && value.kind === 'literal') {
        this.vars.set(name, { kind: 'env', name: SECRET_ENV_VAR[kind] });
        this.info(line, `"${rawName}" looks like a ${kind}: its literal was dropped, anything that uses it would read ${SECRET_ENV_VAR[kind]} from the environment`);
        return;
      }
      this.vars.set(name, value);
      return;
    }
    this.todo(line, 'only string values (literals, variables, joined text) can be followed');
  }

  private open(line: Line, rest: string): void {
    const args = this.args(rest);
    const path = args[0] === undefined ? undefined : this.value(args[0]);
    if (!path || path.kind !== 'literal') return this.todo(line, 'the project path must be a literal string (or built from literals and variables)');
    if (args[1] !== undefined) {
      const options = this.value(args[1]);
      if (!options || options.kind !== 'literal' || options.value !== '') this.info(line, 'the second argument of Open (options) is not carried over');
    }
    this.steps.push({ kind: 'open', line: line.number, path });
  }

  private call(line: Line, rawObject: string, chain: string, rest: string): void {
    const object = this.name(rawObject);
    const members = [...chain.matchAll(/\.([A-Za-z_]\w*)(\([^)]*\))?/g)].map((m) => ({ name: (m[1] as string).toLowerCase(), args: m[2] as string | undefined }));
    const first = members[0] as { name: string; args?: string };
    const argText = (m: { args?: string }) => (m.args !== undefined ? m.args : rest);
    if (this.apps.has(object) && members.length === 1) {
      if (first.name === 'setactiveprofile') {
        const args = this.args(argText(first));
        const value = args[0] === undefined ? undefined : this.value(args[0]);
        if (!value) return this.todo(line, 'the profile name must be a literal string');
        if (value.kind === 'literal') this.info(line, 'the profile name identifies a server: it is read from SAS_EG_PROFILE, not stored in the test');
        this.steps.push({ kind: 'profile', line: line.number, value });
        return;
      }
      if (first.name === 'quit') return void this.steps.push({ kind: 'quit', line: line.number });
      if (first.name === 'open') return this.open(line, argText(first));
      if (first.name === 'visible') return this.info(line, 'Visible is not carried over');
      return this.todo(line, `Application.${(chain.match(/\.([A-Za-z_]\w*)/) as RegExpMatchArray)[1]} has no equivalent in the driver`);
    }
    if (this.projects.has(object)) {
      if (members.length === 1) {
        if (first.name === 'run') return void this.steps.push({ kind: 'run', line: line.number });
        if (first.name === 'save') return void this.steps.push({ kind: 'save', line: line.number });
        if (first.name === 'close') return void this.steps.push({ kind: 'close', line: line.number });
        return this.todo(line, `Project.${(chain.match(/\.([A-Za-z_]\w*)/) as RegExpMatchArray)[1]} has no equivalent in the driver (it supports Run, Save, Close)`);
      }
      // prj.ContainerCollection.Item("Process Flow 1").Run
      const [collection, item, action] = members;
      if (collection?.name === 'containercollection' && item?.name === 'item' && action?.name === 'run' && members.length === 3) {
        const args = this.args(item.args ?? '');
        const name = args[0] === undefined ? undefined : this.value(args[0]);
        if (name && name.kind === 'literal') return void this.steps.push({ kind: 'runFlow', line: line.number, name });
        return this.todo(line, 'a process flow is found by name: the driver cannot pick one by index');
      }
      return this.todo(line, 'only prj.Run, prj.Save, prj.Close and prj.ContainerCollection.Item("name").Run are supported');
    }
    if (!this.connected && /^(Run|Save|Close|Open|SetActiveProfile|Quit)$/i.test(first.name)) return this.todo(line, 'the object it is called on was not created by CreateObject("SASEGObjectModel.Application...") above');
    this.todo(line, `${rawObject} is not an Enterprise Guide object created by this script`);
  }
}

export function parseEgScript(text: string, kind: ScriptKind): ScriptParse {
  const reader = new Reader(kind);
  reader.read(statements(text, kind));
  if (!reader.steps.some((s) => s.kind === 'connect')) {
    reader.warnings.push({ severity: 'todo', message: 'the script never creates the Enterprise Guide object (CreateObject("SASEGObjectModel.Application.x.y")): is it a schedule script? The test connects with the version found on the machine' });
  }
  return { kind, steps: reader.steps, warnings: reader.warnings };
}

// ---------------------------------------------------------------------------------------------------------------------- the test

export interface ImportOptions {
  /** For the header: the script this came from. */
  sourceName?: string;
  name?: string;
  testImport?: string;
  /** Module exporting `SasEnterpriseGuide` by that name (for example `../../src/desktop`). Default: taken from the `desktop` namespace the package root exports. */
  desktopImport?: string;
  tag?: string;
  /** The fixture that provides the DesktopSession. Default `desktopSession`. */
  sessionFixture?: string;
  /** The test also fails when a program ended with warnings (by default only errors fail it). */
  failOnWarnings?: boolean;
  /** Leave the failing guard out when the script runs nothing (so there is nothing to assert). */
  allowNoAssertion?: boolean;
  /** Default progId when SAS_EG_PROGID is not set: the version in the script (default true). */
  lineComments?: boolean;
}

export interface ImportResult {
  code: string;
  warnings: Warning[];
  envVars: string[];
  /** Items that need a human: TODO steps and a missing assertion. */
  todos: number;
  /** The script runs something, so the test asserts that no program ended with an error. */
  hasAssertion: boolean;
}

export function importEgScript(text: string, options: ImportOptions = {}, fileName = ''): ImportResult {
  const kind = detectKind(text, fileName || options.sourceName || '');
  const parsed = parseEgScript(text, kind);
  const warnings = [...parsed.warnings];
  const envVars = new Set<string>();
  const constants: Array<{ key: string; code: string; getter: boolean }> = [];
  const constant = (key: string, code: string, getter: boolean): string => {
    const found = constants.find((c) => c.key === key && c.code === code);
    if (found) return `CONSTANTS.${found.key}`;
    let name = key;
    for (let n = 2; constants.some((c) => c.key === name); n++) name = `${key}${n}`;
    constants.push({ key: name, code, getter });
    return `CONSTANTS.${name}`;
  };
  const env = (name: string, fallback?: string) => {
    envVars.add(name);
    return fallback === undefined ? `env.get(${quote(name)})` : `env.get(${quote(name)}, ${quote(fallback)})`;
  };
  const valueCode = (v: Value, key: string, envName?: string): string => (v.kind === 'env' ? constant(key, env(v.name), true) : envName ? constant(key, env(envName), true) : constant(key, quote(v.value), false));

  const trace = (line: number) => (options.lineComments === false ? '' : ` // script line ${line}`);
  const body: string[] = [];
  const connect = parsed.steps.find((s) => s.kind === 'connect') as Extract<ScriptStep, { kind: 'connect' }> | undefined;
  const profile = parsed.steps.find((s) => s.kind === 'profile') as Extract<ScriptStep, { kind: 'profile' }> | undefined;
  const connectOptions: string[] = [];
  if (connect) connectOptions.push(`progId: ${constant('progId', env('SAS_EG_PROGID', connect.progId), true)}`);
  if (profile) connectOptions.push(`profile: ${valueCode(profile.value, 'profile', 'SAS_EG_PROFILE')}`);
  let declared = false;
  let runs = 0;
  for (const step of parsed.steps) {
    switch (step.kind) {
      case 'connect':
      case 'profile':
      case 'quit':
        break; // connect and profile are in the connect call; quit is in the finally block
      case 'open':
        body.push(`await eg.openProject(${constant('project', quote((step.path as { value: string }).value), false)});${trace(step.line)}`);
        break;
      case 'run':
        body.push(`${declared ? '' : 'let '}statuses = await eg.runProject();${trace(step.line)}`);
        declared = true;
        runs++;
        break;
      case 'runFlow':
        body.push(`await eg.runProcessFlow(${constant('processFlow', quote((step.name as { value: string }).value), false)});${trace(step.line)}`);
        body.push(`${declared ? '' : 'let '}statuses = await eg.programStatuses();${trace(step.line)}`);
        declared = true;
        runs++;
        break;
      case 'save':
        body.push(`await eg.saveProject();${trace(step.line)}`);
        break;
      case 'close':
        body.push(`await eg.closeProject();${trace(step.line)}`);
        break;
      case 'todo':
        body.push(`// TODO(manual, script line ${step.line}): ${step.source}`, `//   ${step.reason}`);
        break;
    }
  }
  const hasAssertion = runs > 0;
  const bad = options.failOnWarnings ? "['Error', 'Warning']" : "['Error']";
  const assertion = hasAssertion
    ? [
        `const failed = statuses.filter((s) => ${bad}.includes(s.status));`,
        `expect(failed.map((s) => \`\${s.name}: \${s.status}\`), ${quote(`programs that ended with ${options.failOnWarnings ? 'errors or warnings' : 'errors'}`)}).toEqual([]);`,
      ]
    : [
        `// ${NO_ASSERTION_TODO}`,
        '// The script does not run anything, so there is no program status to check. Add a check of what the test should prove.',
        'void expect; // delete this line once you use expect(...)',
        ...(options.allowNoAssertion ? [] : [`throw new Error(${quote(`add an assertion: ${NO_ASSERTION_TODO}`)});`]),
      ];
  const todos = warnings.filter((w) => w.severity === 'todo').length + (hasAssertion ? 0 : 1);
  const base = options.name ?? (options.sourceName ? options.sourceName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : 'schedule');
  const title = `eg schedule script: ${base} ${options.tag ?? DEFAULT_TAG}`;
  const session = options.sessionFixture ?? 'desktopSession';
  const driver = options.desktopImport ? 'SasEnterpriseGuide' : 'desktop.SasEnterpriseGuide';
  const usesEnv = envVars.size > 0;
  const header = [
    '/**',
    ` * Converted from ${options.sourceName ?? 'an Enterprise Guide schedule script'} (${kind === 'vbs' ? 'VBScript' : 'PowerShell'}) by sas-eg-import-script.`,
    ' * Review before committing:',
    ' *  - it drives Enterprise Guide through its automation object model (COM), no window is clicked; it needs Enterprise Guide installed on this machine',
    ...(usesEnv ? [` *  - reads ${[...envVars].join(', ')} from the environment (.env.<name> / CI variables); none of those values is stored here`] : []),
    ' *  - quit() is in a finally block, so a failed run still closes Enterprise Guide (a Quit in the script is covered by it)',
    ...(hasAssertion ? [` *  - the script's own success test was "it ran"; this test asserts that no program ended with ${options.failOnWarnings ? 'an error or a warning' : 'an error'} (status read through the object model)`] : [' *  - NO ASSERTION: the script runs nothing, so there is nothing to check yet'] ),
    ' *  - the object model members are those of SAS\'s own schedule script and have NOT been checked against your installation (see EG_COM in src/desktop/apps/enterpriseGuide.ts)',
    ...warnings.map((w) => ` *  - ${w.event !== undefined ? `script line ${w.event}: ` : ''}${w.message}`),
    ' */',
  ];
  const connectCall = `await ${driver}.connect(${session}${connectOptions.length > 0 ? `, { ${connectOptions.join(', ')} }` : ''})`;
  const code = [
    `import { desktopTest as test, desktopExpect as expect } from ${quote(options.testImport ?? DEFAULT_TEST_IMPORT)};`,
    ...(usesEnv ? ["import { loadEnv } from '@automation/referenced-automation-utils';"] : []),
    options.desktopImport ? `import { SasEnterpriseGuide } from ${quote(options.desktopImport)};` : "import { desktop } from '@automation/referenced-automation-sas';",
    '',
    ...(usesEnv ? ['const env = loadEnv();', ''] : []),
    ...(constants.length > 0
      ? [
          '/** What the script used: the object model version, the profile and the project. Change a value here and the test follows. Profiles come from the environment. */',
          'const CONSTANTS = {',
          ...constants.flatMap((c) => (c.getter ? [`  get ${c.key}() {`, `    return ${c.code};`, '  },'] : [`  ${c.key}: ${c.code},`])),
          '};',
          '',
        ]
      : []),
    ...header,
    `test(${quote(title)}, async ({ ${session} }) => {`,
    `  const eg = ${connectCall};`,
    '  try {',
    ...body.map((l) => `    ${l}`),
    ...assertion.map((l) => `    ${l}`),
    '  } finally {',
    '    await eg.quit();',
    '  }',
    '});',
    '',
  ].join('\n');
  return { code, warnings, envVars: [...envVars], todos, hasAssertion };
}
