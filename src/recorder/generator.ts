import * as path from 'node:path';
import { keysToSendKeys, targetWindowOf, titleFromPattern, titlePatternOf, type PathStep, type Target, type TargetWindow } from '../desktop/recording';
import type { RecordedEvent, Recording } from './format';
import { planLocator } from './locators';
import { camel, identifier, ITEM_ROLE, pascal, quote, regexLiteral, ROLE_SUFFIX } from './names';
import { PROFILE_ENV_VAR, secretKindOfEntry, SECRET_ENV_VAR, USER_ENV_VAR } from './secrets';

/**
 * Recording -> a Playwright test written the way this framework is used: a CONSTANTS object (typed values; secrets and settings as environment
 * getters), a LOCATORS object (every window and control named once, chosen by stability - see locators.ts), steps that only refer to them, no
 * sleeps, and - until an assertion exists - a guard that FAILS the test. Three shapes: the default (one file), `inline` (values and locators
 * written where they are used) and `pageObjects` (a pages file with one class per window, and a test that uses them), optionally `data`-driven.
 *
 * Nothing recorded can be a secret: a secret entry has no value, and the test reads it from the environment (SAS_PASSWORD, SAS_PIN ...).
 */

export const DEFAULT_TEST_IMPORT = '@automation/referenced-automation-sas';
export const DEFAULT_TAG = '@sas-desktop';

export type FixtureChoice = 'auto' | 'app' | 'loggedOn';

export interface ConvertOptions {
  /** Shown in the header: the recording this came from, e.g. `recordings/run_project.sasrec.json`. */
  sourceName?: string;
  /** Base name of the test title, pages file and data file. Default: derived from `sourceName`, else the app. */
  name?: string;
  /** Module `desktopTest` (as `test`) and `desktopExpect` (as `expect`) come from. Default `@automation/referenced-automation-sas`. Use a relative path for your own base test. */
  testImport?: string;
  /**
   * Module that exports `DesktopApp`, `DesktopLocator` and `WindowLocator` by those names (for example `../../src/desktop`). Default: they are taken from
   * the `desktop` namespace that the package root exports.
   */
  desktopImport?: string;
  /** Added to the test title so a run can pick it with --grep. Default `@sas-desktop`. */
  tag?: string;
  /** Write values and locators where they are used instead of collecting them in CONSTANTS and LOCATORS. */
  inline?: boolean;
  /** A pages file (one class per window / dialog) plus a test that uses it. */
  pageObjects?: boolean;
  /** Every typed literal becomes a column of a CSV file and the test runs once per row. */
  data?: boolean;
  /** At the end this text must be on the screen (in the main window). Repeatable. */
  expectText?: string[];
  /** At the end a window whose title matches this regular expression must be open. */
  expectWindow?: string;
  /** Which fixture the test asks for: `app` (launched, not logged on), `loggedOn`, or by what the recording contains. Default auto. */
  fixture?: FixtureChoice;
  /** Add `// event N` after each step to trace it back to the recording. Default true. */
  lineComments?: boolean;
  /** Leave the failing guard out when there is no assertion (the TODO and the header note stay). For examples and spikes. */
  allowNoAssertion?: boolean;
}

export interface Warning {
  /** 1-based index in the recording's events, when the note is about one. */
  event?: number;
  message: string;
  /** `todo` needs a human and fails --strict; `info` only reports what the converter did on purpose. */
  severity: 'todo' | 'info';
}

export interface ConvertResult {
  /** The test file. */
  spec: string;
  /** Page objects (with pageObjects): `pages/<fileName>`. */
  pages?: { fileName: string; code: string; classes: string[] };
  /** The data file (with data): the header and the recorded row. */
  data?: { fileName: string; rows: Array<Record<string, string>> };
  warnings: Warning[];
  /** The environment variables the generated test reads. */
  envVars: string[];
  /** The fixture the test asks for, e.g. `egApp`. */
  fixtureName: string;
  /** The recording contains the logon (so the fixture does not log on). */
  logon: boolean;
  /** An assertion was asked for (--expect-text / --expect-window). */
  hasAssertion: boolean;
  /** How many items need a human (TODO(manual) steps and the like). `--strict` counts these and a missing assertion. */
  todos: number;
  /** The windows the test touches, in order, as LOCATORS keys. */
  windows: string[];
}

export const NO_ASSERTION_TODO = 'TODO(converter): no assertion - this test only performs the recorded steps, so it passes whenever they do not throw.';

export function hasAssertion(options: Pick<ConvertOptions, 'expectText' | 'expectWindow'>): boolean {
  return options.expectWindow !== undefined || (options.expectText?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------------- windows

const LOGON_TITLE = /log ?on|log ?in|sign ?in|connection profile|select (a )?profile|connect to|authenticat/i;
const USER_FIELD = /\buser ?(id|name)?\b|\blogin\b|\buid\b|\baccount\b/i;

interface WindowEntry {
  /** The LOCATORS key, e.g. `mainWindow`. */
  key: string;
  /** Regular expression source the locator matches the title with. */
  pattern: string;
  /** A readable title. */
  title: string;
  /** Page class name (page-objects mode). */
  className: string;
  /** Controls that belong to this window, as LOCATORS keys, in order of first use. */
  controls: string[];
}

const escapeRegex = (text: string) => text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
const windowTitle = (w: TargetWindow): string | undefined => w.title ?? titleFromPattern(w.titlePattern);

/**
 * The program's main window: the one that was opened first and is still open at the end (the logon dialogs and the dialogs that were handled
 * are gone by then). undefined when the recording has no window events.
 */
function mainWindowTitle(events: RecordedEvent[]): string | undefined {
  const open: Array<{ title: string; owned: boolean }> = [];
  for (const e of events) {
    if (e.type === 'windowOpened' && !open.some((w) => w.title === e.title)) open.push({ title: e.title, owned: e.owned === true });
    else if (e.type === 'windowClosed') {
      const at = open.findIndex((w) => w.title === e.title);
      if (at >= 0) open.splice(at, 1);
    }
  }
  return (open.find((w) => !w.owned) ?? open[0])?.title;
}

/** Everything about windows: which titles are one window (a document name in front of the product name changes), and what to call each. */
class WindowTable {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly suffixes = new Set<string>();
  private mainTaken = false;
  private readonly mainTitle: string | undefined;

  constructor(recording: Recording) {
    this.mainTitle = mainWindowTitle(recording.events);
    const titles: string[] = [];
    const see = (title: string | undefined) => {
      if (title !== undefined && !titles.includes(title)) titles.push(title);
    };
    for (const event of recording.events) {
      if ('title' in event) see(event.title);
      if ('target' in event && event.target) see(windowTitle(event.target.window));
      if ('window' in event && event.window) see(windowTitle(event.window));
    }
    for (const t of titles) for (const s of titles) if (t !== s && t.endsWith(` - ${s}`)) this.suffixes.add(s);
  }

  private group(title: string): { id: string; pattern: string; generalized: boolean } {
    for (const s of this.suffixes) if (title === s || title.endsWith(` - ${s}`)) return { id: s, pattern: `^(.+ - )?${escapeRegex(s)}$`, generalized: true };
    return { id: title, pattern: titlePatternOf(title), generalized: false };
  }

  /** The window for a recorded window reference (created at first use, in the order the recording uses them). */
  entry(window: TargetWindow, isFirst: boolean): WindowEntry {
    const title = windowTitle(window);
    const group = title === undefined ? { id: window.titlePattern, pattern: window.titlePattern, generalized: false } : this.group(title);
    const found = this.entries.get(group.id);
    if (found) return found;
    const shown = title === undefined ? window.titlePattern : group.generalized ? group.id : title;
    let key: string;
    const isMain = this.mainTitle !== undefined ? group.id === this.group(this.mainTitle).id : group.generalized || (isFirst && !LOGON_TITLE.test(shown));
    if (!this.mainTaken && isMain) {
      key = 'mainWindow';
      this.mainTaken = true;
    } else {
      const base = `${camel(shown) || 'dialog'}Window`;
      key = identifier(base);
      for (let n = 2; [...this.entries.values()].some((e) => e.key === key); n++) key = `${base}${n}`;
    }
    const entry: WindowEntry = { key, pattern: group.pattern, title: shown, className: `${pascal(key.replace(/Window\d*$/, '')) || 'Dialog'}Page`, controls: [] };
    this.entries.set(group.id, entry);
    return entry;
  }

  get main(): WindowEntry | undefined {
    return [...this.entries.values()].find((e) => e.key === 'mainWindow');
  }
}

// ---------------------------------------------------------------------------------------------------------------------- the generator

type Mode = 'locators' | 'inline' | 'pages';

interface ControlEntry {
  key: string;
  window: WindowEntry;
  /** The call chain after the window locator, and the fallbacks (each a call chain too). */
  primary: string;
  alternates: string[];
}

interface Input {
  key: string;
  /** The expression: a quoted literal, or an environment read. */
  code: string;
  getter: boolean;
}

function controlName(step: PathStep, fallbackIndex = 0): string {
  let base = camel(step.name ?? '');
  if (!base || base === '_') base = camel(step.automationId ?? '');
  // nothing to name it by: its control type and position are the name (and already say what it is)
  if (!base) return identifier(`${(step.controlType ?? 'control').toLowerCase()}${step.index ?? fallbackIndex}`);
  const suffix = step.controlType ? ROLE_SUFFIX[step.controlType] : undefined;
  if (suffix && !base.toLowerCase().endsWith(suffix.toLowerCase())) base += suffix;
  return identifier(base);
}

function describeTarget(target: Target): string {
  const leaf = target.path[target.path.length - 1];
  const what = leaf ? `${leaf.controlType ?? 'a control'}${leaf.name ? ` "${leaf.name}"` : leaf.automationId ? ` (id ${leaf.automationId})` : ''}` : 'the window';
  return `${what} in window "${windowTitle(target.window) ?? target.window.titlePattern}"`;
}

/** Does the recording contain the logon? A window that looks like one opened (or was handled), or a password was typed. */
function recordingLogsOn(events: RecordedEvent[]): boolean {
  return events.some((e) => {
    if (e.type === 'windowOpened' || e.type === 'windowActivated' || e.type === 'dialogHandled') return LOGON_TITLE.test(e.title);
    if (e.type === 'text') return e.secret === true && secretKindOfEntry(e) === 'password';
    return false;
  });
}

const safeName = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'recording';

class Generator {
  readonly warnings: Warning[] = [];
  readonly envVars = new Set<string>();
  readonly windows: WindowTable;
  readonly mode: Mode;
  private readonly controls = new Map<string, ControlEntry>();
  private readonly inputs: Input[] = [];
  private readonly dialogs: Array<{ key: string; title: string; button: string }> = [];
  private readonly expected: Array<{ key: string; value: string }> = [];
  private readonly dataRow: Record<string, string> = {};
  private readonly body: string[] = [];
  /** Windows in order of first use. */
  readonly windowOrder: WindowEntry[] = [];
  /** Windows whose page object the test uses, in order of first use. */
  private readonly pagesUsed: WindowEntry[] = [];
  private usesApp = false;
  private usesLocator = false;
  private usesWindowLocator = false;
  private menuNoted = false;
  private readonly firstWindowTitle: string | undefined;
  readonly logon: boolean;
  readonly fixtureName: string;

  constructor(
    readonly recording: Recording,
    readonly options: ConvertOptions,
  ) {
    this.mode = options.pageObjects ? 'pages' : options.inline ? 'inline' : 'locators';
    this.windows = new WindowTable(recording);
    this.logon = recordingLogsOn(recording.events);
    this.fixtureName = this.chooseFixture();
    this.firstWindowTitle = recording.events.map((e) => ('title' in e ? e.title : 'target' in e && e.target ? windowTitle(e.target.window) : undefined)).find((t) => t !== undefined);
  }

  private chooseFixture(): string {
    const { recording } = this;
    const wanted = this.options.fixture ?? 'auto';
    const known = recording.app === 'smc' || recording.app === 'eg';
    const base = known ? recording.app : camel(recording.app.replace(/[^A-Za-z0-9]+/g, ' ')) || 'desktop';
    if (!known)
      this.warn({
        severity: 'todo',
        message: `the recording is of "${recording.app}", a program the framework has no fixture for: the test asks for ${base}App / ${base}LoggedOn - provide them in your own base test (--test-import)`,
      });
    const loggedOn = wanted === 'auto' ? !this.logon : wanted === 'loggedOn';
    if (wanted === 'loggedOn' && this.logon)
      this.warn({ severity: 'todo', message: '--fixture loggedOn, but the recording logs on itself: the fixture logs on first, so the recorded logon steps will not find their dialog. Remove them or use --fixture app (or auto)' });
    if (wanted === 'app' && !this.logon) this.warn({ severity: 'info', message: '--fixture app, and the recording has no logon: the test starts on the program as launched (not logged on)' });
    return `${base}${loggedOn ? 'LoggedOn' : 'App'}`;
  }

  warn(warning: Warning): void {
    this.warnings.push(warning);
  }

  // ---- names, values

  private env(name: string): string {
    this.envVars.add(name);
    return `env.get(${quote(name)})`;
  }

  /** Registers a value in CONSTANTS.inputs and returns the expression to use (the value itself, inline). */
  private input(key: string, code: string, getter: boolean): string {
    if (this.mode === 'inline') return code;
    const same = this.inputs.find((i) => i.key === key && i.code === code);
    if (same) return `CONSTANTS.inputs.${same.key}`;
    let name = key;
    for (let n = 2; this.inputs.some((i) => i.key === name); n++) name = `${key}${n}`;
    this.inputs.push({ key: name, code, getter });
    return `CONSTANTS.inputs.${name}`;
  }

  /** A literal the user typed or chose: a column of the data file, a CONSTANTS entry, or (inline / empty) the literal itself. */
  private literal(key: string, value: string): string {
    if (value === '') return "''";
    if (this.options.data) {
      let column = key;
      for (let n = 2; column in this.dataRow; n++) column = `${key}${n}`;
      this.dataRow[column] = value;
      return `field(data, ${quote(column)})`;
    }
    return this.input(key, quote(value), false);
  }

  // ---- windows and controls

  private win(window: TargetWindow): WindowEntry {
    const entry = this.windows.entry(window, windowTitle(window) === this.firstWindowTitle);
    if (!this.windowOrder.includes(entry)) this.windowOrder.push(entry);
    return entry;
  }

  private pageVar(entry: WindowEntry): string {
    if (!this.pagesUsed.includes(entry)) this.pagesUsed.push(entry);
    return `${camel(entry.className.replace(/Page$/, '')) || 'dialog'}Page`;
  }

  private windowRef(entry: WindowEntry): string {
    if (this.mode === 'pages') return `${this.pageVar(entry)}.window`;
    if (this.mode === 'inline') return `app.window(${regexLiteral(entry.pattern)})`;
    this.usesApp = true;
    return `LOCATORS.${entry.key}(app)`;
  }

  private fullExpression(window: string, entry: ControlEntry): string {
    return `${window}${entry.primary}${entry.alternates.length > 0 ? `.orElse(${entry.alternates.map((a) => `${window}${a}`).join(', ')})` : ''}`;
  }

  /** The expression that finds the control a target points at (registering it); undefined when the recording cannot give a locator. */
  private control(target: Target, n: number): string | undefined {
    const planned = planLocator(target);
    if (!planned.ok) return undefined;
    const w = this.win(target.window);
    const { plan } = planned;
    if (plan.primary.kind === 'window') return this.windowRef(w);
    if (plan.review) this.warn({ event: n, severity: plan.review.severity, message: plan.review.message });
    const scope = plan.scope.join('');
    const primary = `${scope}${plan.primary.code}`;
    const alternates = plan.alternates.map((a) => `${scope}${a.code}`);
    const id = `${w.key}|${primary}|${alternates.join('|')}`;
    let entry = this.controls.get(id);
    if (!entry) {
      const leaf = target.path[target.path.length - 1] as PathStep;
      let key = controlName(leaf);
      const taken = (k: string) => [...this.controls.values()].some((c) => c.key === k) || [...this.windowOrder].some((e) => e.key === k);
      if (taken(key)) key = `${w.key.replace(/Window\d*$/, '')}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      for (let k = 2; taken(key); k++) key = `${key.replace(/\d+$/, '')}${k}`;
      entry = { key, window: w, primary, alternates };
      this.controls.set(id, entry);
      w.controls.push(key);
    }
    if (this.mode === 'pages') return `${this.pageVar(w)}.${entry.key}`;
    if (this.mode === 'inline') return this.fullExpression(this.windowRef(w), entry);
    this.usesApp = true;
    return `LOCATORS.${entry.key}(app)`;
  }

  /** The key typed values of a control are filed under: its own LOCATORS name. */
  private nameOf(target: Target): string {
    const leaf = target.path[target.path.length - 1];
    return leaf ? controlName(leaf) : 'window';
  }

  private isUserField(target: Target): boolean {
    if (!LOGON_TITLE.test(windowTitle(target.window) ?? '')) return false;
    const leaf = target.path[target.path.length - 1];
    return USER_FIELD.test(`${leaf?.name ?? ''} ${leaf?.automationId ?? ''}`);
  }

  private profileEnv(target: Target): string | undefined {
    const env = PROFILE_ENV_VAR[this.recording.app];
    if (!env) return undefined;
    const leaf = target.path[target.path.length - 1];
    return /profile/i.test(`${windowTitle(target.window) ?? ''} ${leaf?.name ?? ''}`) ? env : undefined;
  }

  private todo(n: number, what: string, reason: string): void {
    this.body.push(`// TODO(manual, event ${n}): ${what} - ${reason}.`);
    this.body.push('//   Find the control with sas-desktop-inspect (inspect --app ...), then write the step by hand.');
    this.warn({ event: n, severity: 'todo', message: `${what}: ${reason} (left as a TODO)` });
  }

  private todoFor(n: number, what: string, target: Target): void {
    const planned = planLocator(target);
    this.todo(n, what, planned.ok ? 'no usable locator' : planned.reason);
  }

  // ---- the events

  private convertEvents(): void {
    const trace = (n: number) => (this.options.lineComments === false ? '' : ` // event ${n}`);
    const emit = (n: number, code: string) => this.body.push(`${code}${trace(n)}`);
    this.recording.events.forEach((event, index) => {
      const n = index + 1;
      switch (event.type) {
        case 'windowOpened':
        case 'windowClosed':
        case 'windowActivated':
          return;
        case 'dialogHandled': {
          const base = identifier(camel(event.title) || 'dialog');
          let key = base;
          for (let k = 2; this.dialogs.some((d) => d.key === key); k++) key = `${base}${k}`;
          this.dialogs.push({ key, title: regexLiteral(titlePatternOf(event.title)), button: event.button });
          this.warn({ event: n, severity: 'info', message: `the "${event.title}" dialog is handled by a handler registered at the top of the test (button "${event.button}")` });
          return;
        }
        case 'click':
        case 'doubleClick':
        case 'rightClick': {
          const ref = this.control(event.target, n);
          if (ref) emit(n, `await ${ref}.${event.type}();`);
          else this.todoFor(n, `${event.type} on ${describeTarget(event.target)}`, event.target);
          return;
        }
        case 'text': {
          const ref = this.control(event.target, n);
          if (!ref) return this.todoFor(n, `type into ${describeTarget(event.target)}`, event.target);
          const leaf = event.target.path[event.target.path.length - 1];
          const key = this.nameOf(event.target);
          let value: string;
          if (event.secret === true) {
            const variable = SECRET_ENV_VAR[secretKindOfEntry(event) ?? 'password'];
            value = this.input(key, this.env(variable), true);
            this.warn({ event: n, severity: 'info', message: `what was typed into "${leaf?.name ?? leaf?.automationId ?? 'a secret field'}" was never recorded: the test reads ${variable} from the environment` });
          } else if (this.isUserField(event.target)) {
            value = this.input(key, this.env(USER_ENV_VAR), true);
            this.warn({ event: n, severity: 'info', message: `the user ID is read from ${USER_ENV_VAR}, not stored here` });
          } else value = this.literal(key, event.value);
          emit(n, `await ${ref}.fill(${value}${event.secret === true ? ', { secret: true }' : ''});`);
          if (event.committedBy === 'enter') emit(n, `await ${ref}.press('{ENTER}');`);
          return;
        }
        case 'key': {
          const sendKeys = keysToSendKeys(event.keys);
          if (sendKeys === undefined) return this.todo(n, `press ${event.keys}`, 'SendKeys cannot send that chord');
          let ref = this.windowRef(this.win(event.window));
          if (!/^(Ctrl|Alt)\+/.test(event.keys) && event.target) ref = this.control(event.target, n) ?? ref;
          emit(n, `await ${ref}.press(${quote(sendKeys)});`);
          return;
        }
        case 'select': {
          const container = this.control(event.target, n);
          if (!container) return this.todoFor(n, `select ${event.items.map((i) => `"${i}"`).join(', ')} in ${describeTarget(event.target)}`, event.target);
          const leaf = event.target.path[event.target.path.length - 1];
          const role = leaf?.controlType ? ITEM_ROLE[leaf.controlType] : undefined;
          const profile = this.profileEnv(event.target);
          event.items.forEach((item, at) => {
            const key = `${this.nameOf(event.target)}${at > 0 ? `Item${at + 1}` : 'Item'}`;
            let value: string;
            if (profile) {
              value = this.input(key, this.env(profile), true);
              this.warn({ event: n, severity: 'info', message: `the connection profile is read from ${profile}: the recorded profile name identifies a server and is not stored here` });
            } else value = this.literal(key, item);
            emit(n, `await ${container}${role ? `.getByRole(${quote(role)}, { name: ${value} })` : `.getByName(${value})`}.select(${at > 0 ? '{ add: true }' : ''});`);
          });
          return;
        }
        case 'toggle': {
          const ref = this.control(event.target, n);
          if (ref) emit(n, `await ${ref}.setChecked(${event.state});`);
          else this.todoFor(n, `${event.state ? 'tick' : 'untick'} ${describeTarget(event.target)}`, event.target);
          return;
        }
        case 'expand':
        case 'collapse': {
          const ref = this.control(event.target, n);
          if (ref) emit(n, `await ${ref}.${event.type}();`);
          else this.todoFor(n, `${event.type} ${describeTarget(event.target)}`, event.target);
          return;
        }
        case 'menu': {
          if (!this.menuNoted) {
            this.menuNoted = true;
            this.warn({
              event: n,
              severity: 'info',
              message: 'menu items are looked for inside the window; a menu that UI Automation shows as a window of its own (a popup) may need its locator moved - check it once against sas-desktop-inspect',
            });
          }
          for (const name of event.path) {
            const ref = this.control({ window: event.window, path: [{ controlType: 'MenuItem', name }] }, n);
            if (ref) emit(n, `await ${ref}.click();`);
          }
          return;
        }
      }
    });
  }

  // ---- the assertion

  private assertionLines(): string[] {
    const { options } = this;
    if (hasAssertion(options)) {
      const lines: string[] = [];
      let root = this.windows.main ?? this.windowOrder[this.windowOrder.length - 1];
      if (!root && (options.expectText?.length ?? 0) > 0) {
        // no step touched a window: look in the first window the recording mentions
        for (const e of this.recording.events) {
          const mentioned = 'title' in e ? targetWindowOf(e.title) : 'target' in e && e.target ? e.target.window : 'window' in e && e.window ? e.window : undefined;
          if (mentioned) {
            root = this.win(mentioned);
            break;
          }
        }
      }
      for (const text of options.expectText ?? []) {
        if (!root) throw new Error('--expect-text needs a window to look in, and the recording has none');
        let value = quote(text);
        if (this.mode !== 'inline') {
          const key = `${camel(text) || 'text'}Text`;
          let name = key;
          for (let k = 2; this.expected.some((e) => e.key === name && e.value !== text); k++) name = `${key}${k}`;
          if (!this.expected.some((e) => e.key === name)) this.expected.push({ key: name, value: text });
          value = `CONSTANTS.expected.${name}`;
        }
        lines.push(`await expect(${this.windowRef(root)}.getByText(${value}).first()).toExist();`);
      }
      if (options.expectWindow !== undefined) lines.push(`await expect(app.window(${regexLiteral(options.expectWindow)})).toExist();`);
      return lines;
    }
    return [
      `// ${NO_ASSERTION_TODO}`,
      "// Add a check of the business result, e.g.  await expect(app.window(/Sales/).getByText('Succeeded').first()).toExist();  or  await expect(LOCATORS.statusText(app)).toHaveText('Ready');",
      '// (the converter can write one for you: --expect-text, --expect-window).',
      'void expect; // delete this line once you use expect(...) - it only keeps the import of expect from being reported as unused',
      ...(this.options.allowNoAssertion
        ? []
        : ['// then delete the next line (it fails the test on purpose; the converter option --allow-no-assertion leaves it out).', `throw new Error(${quote(`add an assertion: ${NO_ASSERTION_TODO}`)});`]),
    ];
  }

  // ---- rendering

  private constantsBlock(exported: boolean): string[] {
    const exp = exported ? 'export ' : '';
    const sections: string[] = [];
    if (this.inputs.length > 0) {
      sections.push('  inputs: {');
      for (const i of this.inputs) sections.push(...(i.getter ? [`    get ${i.key}() {`, `      return ${i.code};`, '    },'] : [`    ${i.key}: ${i.code},`]));
      sections.push('  },');
    }
    if (this.dialogs.length > 0) {
      sections.push('  dialogs: {');
      for (const d of this.dialogs) sections.push(`    ${d.key}: { title: ${d.title}, button: ${quote(d.button)} },`);
      sections.push('  },');
    }
    if (this.expected.length > 0) {
      sections.push('  expected: {');
      for (const e of this.expected) sections.push(`    ${e.key}: ${quote(e.value)},`);
      sections.push('  },');
    }
    if (sections.length === 0) return [];
    return ['/** What the recording typed, chose and expected, and the dialogs it dismissed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */', `${exp}const CONSTANTS = {`, ...sections, '};', ''];
  }

  private locatorsBlock(exported: boolean): string[] {
    const exp = exported ? 'export ' : '';
    const lines: string[] = [];
    const windows = this.windowOrder.filter((w) => w.controls.length > 0 || this.mode === 'locators' || this.pagesUsed.includes(w));
    for (const w of windows) {
      this.usesApp = true;
      this.usesWindowLocator = true;
      lines.push(`  ${w.key}: (app: DesktopApp): WindowLocator => app.window(${regexLiteral(w.pattern)}),`);
      for (const entry of this.controls.values()) {
        if (entry.window !== w) continue;
        this.usesLocator = true;
        lines.push(`  ${entry.key}: (app: DesktopApp): DesktopLocator => ${this.fullExpression(`LOCATORS.${w.key}(app)`, entry)},`);
      }
    }
    if (lines.length === 0) return [];
    return ['/** Every window and control the recording used, named once. When a screen changes, fix the locator here and every step follows. */', `${exp}const LOCATORS = {`, ...lines, '};', ''];
  }

  /** The type imports; the pages file sits one folder below the test, so a relative --desktop-import is re-based for it. */
  private typeImports(inPagesFolder = false): string[] {
    const used = [...(this.usesApp ? ['DesktopApp'] : []), ...(this.usesLocator ? ['DesktopLocator'] : []), ...(this.usesWindowLocator ? ['WindowLocator'] : [])];
    if (used.length === 0) return [];
    const module_ = this.options.desktopImport;
    if (module_) return [`import type { ${used.join(', ')} } from ${quote(inPagesFolder && module_.startsWith('.') ? path.posix.join('..', module_) : module_)};`];
    return ["import type { desktop } from '@automation/referenced-automation-sas';", ...used.map((name) => `type ${name} = desktop.${name};`)];
  }

  private header(kind: string, usesEnv: boolean, pagesFile?: string): string[] {
    const { options } = this;
    const source = options.sourceName ?? 'a recording';
    const lines = ['/**', ` * Converted from ${source} by sas-desktop-to-playwright${kind}.`, ' * Review before committing:'];
    if (usesEnv) lines.push(` *  - reads ${[...this.envVars].join(', ')} from the environment (.env.<name> / CI variables); none of those values is stored here`);
    if (pagesFile) lines.push(` *  - every typed value (CONSTANTS) and every locator (LOCATORS) is at the top of ./pages/${pagesFile}: change them there; the page and member names are mechanical - rename them`);
    if (this.logon)
      lines.push(
        ` *  - session: ${this.fixtureName} (the recording contains the logon): the program is launched and NOT logged on; the recorded logon steps run once and are never retried (retries are switched off for this file - a second try with a rejected password can lock the account)`,
      );
    else lines.push(` *  - session: ${this.fixtureName} (the recording has no logon): the fixture logs on with SAS_USER / SAS_PASSWORD before the test starts`);
    lines.push(' *  - no waits are needed: every step waits for its control to exist and for the program to go idle');
    if (options.data) lines.push(` *  - one test runs per row of ${safeName(this.baseName())}.data.csv; the first row holds the values that were recorded`);
    if (!hasAssertion(options)) lines.push(` *  - NO ASSERTION: this test only performs the recorded steps and passes whenever they do not throw. ${options.allowNoAssertion ? 'Add one.' : 'It ends with a guard that fails until you add one.'}`);
    for (const w of this.warnings) lines.push(` *  - ${w.event !== undefined ? `event ${w.event}: ` : ''}${w.message}`);
    lines.push(' */');
    return lines;
  }

  baseName(): string {
    const { options, recording } = this;
    return options.name ?? (options.sourceName ? options.sourceName.replace(/^.*[\\/]/, '').replace(/\.sasrec\.json$/i, '').replace(/\.[^.]+$/, '') : recording.app);
  }

  private dataPreamble(dataFile: string): string[] {
    return [
      `const rows = csvUtils.parseCsvFile(path.join(__dirname, ${quote(dataFile)}));`,
      '',
      '/** One cell of the current row. A missing column is an error that names it, not a silent `undefined` typed into a field. */',
      'function field(row: Record<string, string>, column: string): string {',
      '  const value = row[column];',
      `  if (value === undefined) throw new Error(\`${dataFile} has no column "\${column}" - add it (the recording typed a value there)\`);`,
      '  return value;',
      '}',
      '',
    ];
  }

  render(): ConvertResult {
    const { options } = this;
    this.convertEvents();
    const assertion = this.assertionLines();
    const body = this.body;
    const usesEnv = this.envVars.size > 0;
    const base = safeName(this.baseName());
    const tag = options.tag ?? DEFAULT_TAG;
    const title = `recorded: ${this.baseName()} ${tag}`.trim();
    const pageMode = this.mode === 'pages';
    const dataFile = `${base}.data.csv`;
    const testImport = options.testImport ?? DEFAULT_TEST_IMPORT;
    const fixtureArg = `{ ${this.fixtureName}: app }`;
    const handlers = this.dialogs.map((d) =>
      this.mode === 'inline'
        ? `app.onDialog(${d.title}, (dialog) => dialog.getByRole('Button', { name: ${quote(d.button)} }).click(), { name: ${quote(d.key)} });`
        : `app.onDialog(CONSTANTS.dialogs.${d.key}.title, (dialog) => dialog.getByRole('Button', { name: CONSTANTS.dialogs.${d.key}.button }).click(), { name: ${quote(d.key)} });`,
    );
    const pageDeclarations = this.pagesUsed.map((w) => `const ${camel(w.className.replace(/Page$/, '')) || 'dialog'}Page = new ${w.className}(app);`);
    const testLines = [...handlers, ...pageDeclarations, ...body, ...assertion];
    const indent = options.data ? '    ' : '  ';
    const testBlock = options.data
      ? ['for (const [index, data] of rows.entries()) {', `  test(\`${title.replace(/[`\\$]/g, '\\$&')} [row \${index + 1}]\`, async (${fixtureArg}) => {`, ...testLines.map((l) => `${indent}${l}`), '  });', '}']
      : [`test(${quote(title)}, async (${fixtureArg}) => {`, ...testLines.map((l) => `${indent}${l}`), '});'];
    const retries = this.logon ? ['// The recording logs on: a rejected password must never be retried (a retry would send the same wrong password again and can lock the account).', 'test.describe.configure({ retries: 0 });', ''] : [];
    const usesEnvInSpec = usesEnv && !pageMode;
    const specImports = [
      ...(options.data ? ["import * as path from 'node:path';"] : []),
      `import { desktopTest as test, desktopExpect as expect } from ${quote(testImport)};`,
      ...(options.data || usesEnvInSpec ? [`import { ${[...(options.data ? ['csvUtils'] : []), ...(usesEnvInSpec ? ['loadEnv'] : [])].join(', ')} } from '@automation/referenced-automation-utils';`] : []),
    ];

    if (pageMode) {
      // ---- the pages file
      const constants = this.constantsBlock(true);
      const locators = this.locatorsBlock(true);
      const pageWindows = this.windowOrder.filter((w) => w.controls.length > 0 || this.pagesUsed.includes(w));
      const classes = pageWindows.map((w) => w.className);
      const pageCode = pageWindows.flatMap((w) => [
        '',
        `/** The "${w.title}" window. */`,
        `export class ${w.className} {`,
        '  constructor(readonly app: DesktopApp) {}',
        '',
        '  /** The window itself. */',
        '  get window(): WindowLocator {',
        `    return LOCATORS.${w.key}(this.app);`,
        '  }',
        ...w.controls.flatMap((key) => ['', `  get ${key}(): DesktopLocator {`, `    return LOCATORS.${key}(this.app);`, '  }']),
        '',
        '  /** Waits until the window is on the screen. */',
        `  async waitUntilDisplayed(timeout?: number): Promise<${w.className}> {`,
        '    await this.window.waitFor({ timeout });',
        '    return this;',
        '  }',
        '}',
      ]);
      // the page classes use the three types whenever there is a page
      if (pageWindows.length > 0) {
        this.usesApp = true;
        this.usesWindowLocator = true;
        if (pageWindows.some((w) => w.controls.length > 0)) this.usesLocator = true;
      }
      const pagesFile = `${pascal(base) || 'Recording'}Pages`;
      const pagesCode = [
        '// CONSTANTS and LOCATORS first: change a value or fix a locator once, here. Then one class per window - rename the classes and members to business terms, add methods.',
        `// Generated from ${options.sourceName ?? 'a recording'} by sas-desktop-to-playwright (page-object mode).`,
        ...(usesEnv ? ["import { loadEnv } from '@automation/referenced-automation-utils';"] : []),
        ...this.typeImports(true),
        '',
        ...(usesEnv ? ['const env = loadEnv();', ''] : []),
        ...constants,
        ...locators,
        ...pageCode.slice(1),
        '',
      ].join('\n');
      const needsConstants = testLines.some((l) => l.includes('CONSTANTS.'));
      const spec = [
        ...specImports,
        `import { ${[...(needsConstants ? ['CONSTANTS'] : []), ...this.pagesUsed.map((w) => w.className)].join(', ')} } from './pages/${pagesFile}';`,
        '',
        ...(options.data ? this.dataPreamble(dataFile) : []),
        ...this.header(' (page-object mode)', usesEnv, `${pagesFile}.ts`),
        ...retries,
        ...testBlock,
        '',
      ].join('\n');
      return this.result(spec, { pages: { fileName: `${pagesFile}.ts`, code: pagesCode, classes } });
    }

    const constants = this.constantsBlock(false);
    const locators = this.mode === 'inline' ? [] : this.locatorsBlock(false);
    const spec = [
      ...specImports,
      ...this.typeImports(),
      '',
      ...(usesEnvInSpec ? ['const env = loadEnv();', ''] : []),
      ...(options.data ? this.dataPreamble(dataFile) : []),
      ...constants,
      ...locators,
      ...this.header('', usesEnv),
      ...retries,
      ...testBlock,
      '',
    ].join('\n');
    return this.result(spec, {});
  }

  private result(spec: string, extra: Pick<ConvertResult, 'pages'>): ConvertResult {
    const todos = this.warnings.filter((w) => w.severity === 'todo').length;
    return {
      spec,
      ...extra,
      ...(this.options.data ? { data: { fileName: `${safeName(this.baseName())}.data.csv`, rows: [this.dataRow] } } : {}),
      warnings: this.warnings,
      envVars: [...this.envVars],
      fixtureName: this.fixtureName,
      logon: this.logon,
      hasAssertion: hasAssertion(this.options),
      todos,
      windows: this.windowOrder.map((w) => w.key),
    };
  }
}

/** Converts a validated recording into a test. Throws only for options that make no sense; everything about the recording itself is a warning in the result. */
export function convertRecording(recording: Recording, options: ConvertOptions = {}): ConvertResult {
  if (options.data && options.inline) throw new Error('--data needs the CONSTANTS / LOCATORS objects: it cannot be combined with --inline');
  for (const pattern of [options.expectWindow]) if (pattern !== undefined) new RegExp(pattern); // a bad pattern fails now, not in the generated test
  return new Generator(recording, options).render();
}
