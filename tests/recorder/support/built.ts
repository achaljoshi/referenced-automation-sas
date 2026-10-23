import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * The sources of src/ transpiled once into node_modules/.cache (keyed by a hash of their content) so child processes - the stand-in bridge and the
 * command-line tools - can be started with plain `node`. The layout is the package's: `<dir>/dist/...` and `<dir>/bridge/...`. NOT VERIFIED on
 * Windows: only the stand-in speaks the protocol here.
 */
const root = path.resolve(__dirname, '..', '..', '..');
const srcDir = path.join(root, 'src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

let built: string | undefined;

export function builtSrc(): string {
  if (built) return built;
  const files = sources(srcDir).sort();
  const hash = crypto.createHash('sha1');
  for (const f of files) hash.update(f).update(fs.readFileSync(f));
  hash.update(fs.readFileSync(path.join(root, 'bridge', 'sas-desktop-bridge.ps1')));
  const target = path.join(root, 'node_modules', '.cache', 'sas-recorder-built', hash.digest('hex').slice(0, 16));
  if (!fs.existsSync(path.join(target, 'dist', 'recorder', 'cli', 'record.js'))) {
    const tmp = `${target}.${process.pid}.${Date.now()}`;
    for (const file of files) {
      const out = path.join(tmp, 'dist', path.relative(srcDir, file)).replace(/\.ts$/, '.js');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file }).outputText,
      );
    }
    fs.cpSync(path.join(root, 'bridge'), path.join(tmp, 'bridge'), { recursive: true });
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(tmp, target);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another worker built it first
    }
  }
  built = target;
  return target;
}

export const builtStandIn = (): string => path.join(builtSrc(), 'dist', 'desktop', 'standInBridge.js');
export const builtCli = (name: 'record' | 'convert' | 'importScript'): string => path.join(builtSrc(), 'dist', 'recorder', 'cli', `${name}.js`);
