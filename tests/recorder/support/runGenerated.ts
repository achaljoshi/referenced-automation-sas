import * as ts from 'typescript';
import * as desktopModule from '../../../src/desktop';
import { clearRejectedLogons, startFakeDesktop, type DesktopApp, type DesktopSession, type FakeSasDesktop } from '../../../src/desktop';
import { desktopExpect } from '../../../src/desktop';
import { installRecorderExtras } from './extras';
import { FAKE_EG_PATH, FAKE_SMC_PATH, SasEnterpriseGuideUi, SasManagementConsole } from '../../../src/desktop';

/**
 * Runs a GENERATED test in-process against the fake desktop: the spec (and its pages file) is transpiled, its imports are served from here, and
 * the test bodies it registers are run with the fixtures they ask for (`smcApp`, `egApp`, `smcLoggedOn`, `egLoggedOn`, `desktopSession`).
 * This executes exactly the text the converter wrote, so a wrong locator, a wrong value or a bad import fails here.
 */

export interface World {
  fake: FakeSasDesktop;
  session: DesktopSession;
}

export interface Collected {
  title: string;
  fn: (fixtures: Record<string, unknown>) => Promise<void>;
}

export interface RunOptions {
  /** Extra files the spec imports, by the specifier it uses ('./pages/XPages'). */
  files?: Record<string, string>;
  /** Called after each test, with the fake still running: `error` is what the test threw (it is rethrown afterwards). */
  after?: (world: World, title: string, error?: unknown) => void | Promise<void>;
  /** Environment variables set while the test runs, over the fake's own logon values (a wrong password, say). */
  env?: Record<string, string>;
  /** The program has the extras the examples were recorded with (default true). */
  extras?: boolean;
  /** What `__dirname` is for the generated code (where its .data.csv is). */
  dir?: string;
}

export const VIRTUAL_TEST = 'virtual:desktop-test';
export const VIRTUAL_DESKTOP = 'virtual:desktop';

function transpile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
}

/** Evaluates generated modules: imports of the framework come from the real source, `desktopTest` is a collector. */
export function load(source: string, files: Record<string, string>, collected: Collected[], configured: unknown[], dir = process.cwd()): void {
  const desktopTest = Object.assign(
    (title: string, fn: Collected['fn']) => void collected.push({ title, fn }),
    { describe: { configure: (options: unknown) => void configured.push(options) } },
  );
  const cache = new Map<string, unknown>();
  const evaluate = (code: string): unknown => {
    const module_ = { exports: {} as Record<string, unknown> };
    const require_ = (specifier: string): unknown => {
      if (specifier === VIRTUAL_TEST) return { desktopTest, desktopExpect };
      if (specifier === VIRTUAL_DESKTOP) return desktopModule;
      if (specifier === '@automation/referenced-automation-sas') return { desktop: desktopModule, desktopTest, desktopExpect };
      if (specifier in files) {
        if (!cache.has(specifier)) cache.set(specifier, evaluate(transpile(files[specifier] as string)));
        return cache.get(specifier);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      if (specifier.startsWith('node:') || specifier.startsWith('@automation/')) return require(specifier);
      throw new Error(`the generated code imports "${specifier}", which the harness does not provide`);
    };
    new Function('require', 'module', 'exports', '__dirname', code)(require_, module_, module_.exports, dir);
    return module_.exports;
  };
  evaluate(transpile(source));
}

function fixtureNames(fn: Collected['fn']): string[] {
  const match = /^\s*(?:async\s*)?\(\s*\{([^}]*)\}/.exec(fn.toString());
  if (!match) return [];
  return (match[1] as string)
    .split(',')
    .map((part) => (part.split(':')[0] as string).trim())
    .filter(Boolean);
}

export async function runCollected(collected: Collected[], options: RunOptions = {}): Promise<string[]> {
  const ran: string[] = [];
  for (const test of collected) {
    clearRejectedLogons();
    const fake = startFakeDesktop({ eg: { comVersions: ['7.1', '8.3'] } });
    if (options.extras !== false) installRecorderExtras(fake);
    const session = fake.session();
    const world: World = { fake, session };
    const apps: DesktopApp[] = [];
    const make: Record<string, () => Promise<unknown>> = {
      desktopSession: async () => session,
      smcApp: async () => (apps[apps.push(await session.launch({ path: FAKE_SMC_PATH, windowTitle: /SAS Management Console|Connection Profile|Log ?On/i })) - 1] as DesktopApp),
      egApp: async () => (apps[apps.push(await session.launch({ path: FAKE_EG_PATH, windowTitle: /SAS Enterprise Guide/i })) - 1] as DesktopApp),
      smcLoggedOn: async () => {
        const smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
        await smc.logon(fake.smc.options.accounts[0] as { user: string; password: string }, { profile: fake.smc.options.profiles[0] });
        apps.push(smc.app);
        return smc.app;
      },
      egLoggedOn: async () => {
        const eg = await SasEnterpriseGuideUi.launch(session, { path: FAKE_EG_PATH });
        await eg.connect(fake.eg.options.accounts[0] as { user: string; password: string }, { profile: fake.eg.options.profiles[0] });
        apps.push(eg.app);
        return eg.app;
      },
    };
    let failure: unknown;
    try {
      const fixtures: Record<string, unknown> = {};
      for (const name of fixtureNames(test.fn)) {
        const build = make[name];
        if (!build) throw new Error(`the generated test asks for a fixture "${name}" the harness does not have`);
        fixtures[name] = await build();
      }
      await test.fn(fixtures);
      ran.push(test.title);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await options.after?.(world, test.title, failure);
      for (const app of apps) await app.dispose();
      await session.close();
    }
  }
  return ran;
}

/** Sets the logon values the generated tests read, from the fake's own account, for the duration of `run`. */
export async function withFakeLogonEnv<T>(run: () => Promise<T>, over: Record<string, string> = {}): Promise<T> {
  const probe = startFakeDesktop();
  const account = probe.eg.options.accounts[0] as { user: string; password: string };
  const values: Record<string, string> = {
    SAS_USER: account.user,
    SAS_PASSWORD: account.password,
    SAS_SMC_PROFILE: probe.smc.options.profiles[0] as string,
    SAS_EG_PROFILE: probe.eg.options.profiles[0] as string,
    ...over,
  };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Convenience: evaluate, then run. */
export async function runGenerated(source: string, options: RunOptions = {}): Promise<{ titles: string[]; configured: unknown[] }> {
  const collected: Collected[] = [];
  const configured: unknown[] = [];
  return withFakeLogonEnv(async () => {
    load(source, options.files ?? {}, collected, configured, options.dir);
    return { titles: await runCollected(collected, options), configured };
  }, options.env);
}
