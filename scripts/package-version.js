#!/usr/bin/env node
'use strict';
/**
 * Prints the version in the package.json of a folder: node scripts/package-version.js ../referenced-automation-utils
 *
 * Local setup (setup.sh / setup.bat --local) uses it to find the tarball of a sibling package at the version that checkout
 * has NOW, instead of taking whichever older tarball happens to be in ../shared-packages (which would quietly install a
 * version that a newer one has fixed).
 */
const path = require('node:path');

const folder = process.argv[2];
if (!folder) {
  process.stderr.write('usage: node scripts/package-version.js <package folder>\n');
  process.exit(2);
}
process.stdout.write(`${require(path.resolve(folder, 'package.json')).version}\n`);
