import * as path from 'node:path';
import * as ts from 'typescript';
import { repoRoot } from './examples';

/** The folder the virtual files live in: two levels below the repository root, like tests/recorder, so relative imports resolve the same way. */
export const VIRTUAL_DIR = path.join(repoRoot, 'tests', 'recorder', '__virtual__');

/**
 * Type-checks generated files exactly as `tsc` would check them in this repository (strict, Node16 modules), without writing them to disk. `files` maps
 * a path below VIRTUAL_DIR to its text; whatever they import is read from the real tree. `declarations` are extra ambient declarations (rarely needed). Returns the diagnostics for the virtual files.
 */
export function typeCheck(files: Record<string, string>, declarations = ''): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noUncheckedIndexedAccess: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
    // the package's own name resolves to the package root of this repository, as it does for a project that depends on it
    baseUrl: repoRoot,
    paths: { '@automation/referenced-automation-sas': ['src/index.ts'] },
  };
  const virtual = new Map(Object.entries(files).map(([name, text]) => [path.join(VIRTUAL_DIR, name), text]));
  if (declarations) virtual.set(path.join(VIRTUAL_DIR, 'ambient.d.ts'), declarations);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => (virtual.has(path.resolve(fileName)) ? ts.createSourceFile(fileName, virtual.get(path.resolve(fileName)) as string, languageVersion) : getSourceFile(fileName, languageVersion, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => virtual.has(path.resolve(fileName)) || fileExists(fileName);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (dir) => [...virtual.keys()].some((f) => f.startsWith(`${path.resolve(dir)}${path.sep}`)) || (directoryExists ? directoryExists(dir) : false);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => virtual.get(path.resolve(fileName)) ?? readFile(fileName);
  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && virtual.has(path.resolve(d.file.fileName)))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${path.relative(VIRTUAL_DIR, d.file!.fileName)}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
}
