import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { logger } from '@automation/referenced-automation-utils';
import Transport from 'winston-transport';

/**
 * Test equipment for the desktop layer.
 *
 * The Node STAND-IN bridge (src/desktop/standInBridge.ts) must run as a separate process, and a child process cannot load TypeScript. So the
 * sources of src/desktop are transpiled once into node_modules/.cache (keyed by a hash of their content; concurrent workers build in a
 * private folder and rename) and the stand-in is started from there. Everything runs against the stand-in: NOT VERIFIED on real Windows.
 */
const root = path.resolve(__dirname, '..', '..');
const srcDir = path.join(root, 'src', 'desktop');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

let builtDir: string | undefined;

/** The folder holding the transpiled src/desktop in the package layout (`<dir>/dist/desktop/...` and `<dir>/bridge/...`). */
export function builtDesktop(): string {
  if (builtDir) return builtDir;
  const files = sources(srcDir).sort();
  const hash = crypto.createHash('sha1');
  for (const f of files) hash.update(f).update(fs.readFileSync(f));
  const key = hash.digest('hex').slice(0, 16);
  const target = path.join(root, 'node_modules', '.cache', 'sas-desktop-standin', key);
  if (!fs.existsSync(path.join(target, 'dist', 'desktop', 'standInBridge.js'))) {
    const tmp = `${target}.${process.pid}.${Date.now()}`;
    for (const file of files) {
      const out = path.join(tmp, 'dist', 'desktop', path.relative(srcDir, file)).replace(/\.ts$/, '.js');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        fileName: file,
      }).outputText;
      fs.writeFileSync(out, js);
    }
    fs.cpSync(path.join(root, 'bridge'), path.join(tmp, 'bridge'), { recursive: true }); // the package layout: bridge/ next to dist/
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(tmp, target);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another worker built it first
    }
  }
  builtDir = target;
  return target;
}

/** The stand-in bridge as a Node script a transport can start. */
export function standInBridge(): string {
  return path.join(builtDesktop(), 'dist', 'desktop', 'standInBridge.js');
}

export function builtInspectCli(): string {
  return path.join(builtDesktop(), 'dist', 'desktop', 'cli', 'inspect.js');
}

/** Sets environment variables for one test and puts them back. */
export async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await run();
  } finally {
    apply(saved);
  }
}

/** Everything the shared logger writes while `run` runs (raw entries, as the code passed them: this is what would reach a log file). */
export async function captureLogs<T>(run: () => Promise<T>, level = 'debug'): Promise<{ result: T | undefined; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  class Capture extends Transport {
    log(info: unknown, callback: () => void): void {
      lines.push(JSON.stringify(info));
      callback();
    }
  }
  const capture = new Capture();
  const previous = logger.level;
  logger.level = level;
  logger.add(capture);
  try {
    return { result: await run(), lines };
  } catch (error) {
    return { result: undefined, error, lines };
  } finally {
    logger.remove(capture);
    logger.level = previous;
  }
}

export function tempDir(prefix = 'sas-desktop-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Runs a Node script synchronously (CLI tests). */
export function runNode(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false', ...env }, cwd: root });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const repoRoot = root;

/**
 * How long a test that EXPECTS the bridge to start waits for it. The stand-in bridge is a child Node process: on a machine running 20+
 * workers its start can take several seconds, and a budget of 4-5 s made the suite fail on load and pass in isolation. Tests that check the
 * TIMEOUT itself keep their own small values; they are the ones that expect the start to fail.
 */
export const STARTUP_BUDGET_MS = 30_000;
