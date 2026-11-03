#!/usr/bin/env node
'use strict';
/**
 * Installs the VS Code extensions this repo recommends (.vscode/extensions.json) through the editor's command line, so a
 * new machine does not depend on VS Code's "install the recommended extensions?" prompt being noticed.
 *
 *   node scripts/install-vscode-extensions.js           (npm run install:extensions)
 *   node scripts/install-vscode-extensions.js --strict  exit code 1 when an extension could not be installed
 *
 * It never stops setup: without the `code` (or `cursor`) command it says so and exits 0, and an extension that cannot be
 * downloaded (a network that blocks the Visual Studio Marketplace, a proxy that re-signs HTTPS) is reported with the offline
 * route: download the .vsix on a machine that can reach the marketplace and install the file with `code --install-extension`.
 * Extensions that are already installed are left alone.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EDITORS = ['code', 'cursor'];
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;
const INSTALL_TIMEOUT_MS = 180_000;
const strict = process.argv.includes('--strict');

/** The recommended ids. The file may contain comments, like every VS Code settings file. */
function recommendations() {
  const file = path.join(__dirname, '..', '.vscode', 'extensions.json');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(text);
  return (parsed.recommendations ?? []).filter((id) => typeof id === 'string');
}

// A fixed command string through the shell: on Windows `code` is code.cmd, which cannot be started without one. The only
// variable part is an extension id, checked against EXTENSION_ID before it gets here.
const run = (command, timeout) => spawnSync(command, { encoding: 'utf8', shell: true, timeout });

function editorCommand() {
  return EDITORS.find((name) => run(`${name} --version`, 30_000).status === 0);
}

function main() {
  const ids = recommendations();
  if (ids.length === 0) return 0;
  const bad = ids.filter((id) => !EXTENSION_ID.test(id));
  if (bad.length) {
    process.stderr.write(`Skipping entries of .vscode/extensions.json that are not publisher.name ids: ${bad.join(', ')}\n`);
  }
  const wanted = ids.filter((id) => EXTENSION_ID.test(id));

  const editor = editorCommand();
  if (!editor) {
    process.stdout.write(
      `VS Code extensions: the \`code\` command was not found, so nothing was installed. Install these from the Extensions view (Ctrl+Shift+X) or add VS Code's bin folder to PATH and run \`npm run install:extensions\`:\n  ${wanted.join('\n  ')}\n`,
    );
    return 0;
  }

  const installed = new Set(run(`${editor} --list-extensions`, 60_000).stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase()));
  const failed = [];
  for (const id of wanted) {
    if (installed.has(id.toLowerCase())) {
      process.stdout.write(`VS Code extensions: ${id} - already installed\n`);
      continue;
    }
    const result = run(`${editor} --install-extension ${id}`, INSTALL_TIMEOUT_MS);
    if (result.status === 0) {
      process.stdout.write(`VS Code extensions: ${id} - installed\n`);
    } else {
      failed.push(id);
      const reason = (result.stderr || result.stdout || result.error?.message || '').trim().split(/\r?\n/).pop();
      process.stdout.write(`VS Code extensions: ${id} - NOT installed (${reason || `exit code ${result.status}`})\n`);
    }
  }

  if (failed.length) {
    process.stdout.write(
      [
        '',
        `${failed.length} extension(s) could not be installed: ${failed.join(', ')}`,
        'Usually the network blocks the Visual Studio Marketplace. Offline route: on a machine that can reach it, open the extension\'s page,',
        'choose "Download Extension" (or "Version History" > Download), copy the .vsix file here and run:',
        `  ${editor} --install-extension <file>.vsix`,
        'Setup itself is not affected.',
        '',
      ].join('\n'),
    );
  }
  return strict && failed.length ? 1 : 0;
}

process.exit(main());
