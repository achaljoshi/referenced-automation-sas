import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from './support';

// House rules for the files this layer owns.

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const owned = [
  ...files(path.join(repoRoot, 'src', 'desktop')),
  ...files(path.join(repoRoot, 'bridge')),
  ...files(path.join(repoRoot, 'tests', 'desktop')),
  path.join(repoRoot, 'docs', 'DESKTOP_SAS.md'),
  path.join(repoRoot, 'env', 'desktop.example'),
].filter((f) => fs.existsSync(f) && !f.endsWith('.png'));

test.describe('owned files', () => {
  test('they never use the names the repo must not carry (built from pieces so this file does not contain them)', () => {
    const forbidden = [['Cl', 'aude'], ['Anthr', 'opic'], ['AI-', 'generated']].map((p) => new RegExp(p.join(''), 'i'));
    const offenders = owned.filter((f) => forbidden.some((re) => re.test(fs.readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  test('the NOT VERIFIED statement is in the header of the bridge, of the transports and of the fake apps, and in the docs', () => {
    for (const rel of ['bridge/sas-desktop-bridge.ps1', 'src/desktop/types.ts', 'src/desktop/fakeDesktop.ts', 'src/desktop/fakeApps.ts', 'src/desktop/apps/managementConsole.ts', 'src/desktop/apps/enterpriseGuide.ts', 'src/desktop/apps/enterpriseGuideUi.ts', 'src/desktop/remoteTransport.ts']) {
      expect(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), rel).toMatch(/NOT VERIFIED/);
    }
    const docs = path.join(repoRoot, 'docs', 'DESKTOP_SAS.md');
    if (fs.existsSync(docs)) expect(fs.readFileSync(docs, 'utf8')).toMatch(/NOT VERIFIED/);
  });

  test('the source reads no environment variable directly: only the shared config does', () => {
    const offenders = files(path.join(repoRoot, 'src', 'desktop'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /process\.env\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  test('no source file contains a password literal or a fixed sleep', () => {
    for (const f of files(path.join(repoRoot, 'src', 'desktop')).filter((x) => x.endsWith('.ts') && !/fakeApps\.ts$/.test(x))) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/(?<!['"\w])password\s*[:=]\s*'[^'\n]{3,}'/i);
    }
    // the only waits in the UI layer are the poll pause and the polling helpers; nothing calls waitForTimeout
    for (const f of files(path.join(repoRoot, 'src', 'desktop')).filter((x) => x.endsWith('.ts'))) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/waitForTimeout/);
  });

  test('the documentation says the things it must, and every file it points at exists', () => {
    const docs = fs.readFileSync(path.join(repoRoot, 'docs', 'DESKTOP_SAS.md'), 'utf8');
    for (const needle of ['jabswitch -enable', 'restart', '32-bit', 'SAS_DESKTOP_POWERSHELL', 'SAS_EG_PROGID', 'SAS_COM_PROGIDS', 'sas-desktop-inspect doctor', 'LOCATORS', 'REMOTE_ALLOW', 'interactive', 'node bridge/generate-hash.js', 'Troubleshooting', 'NOT VERIFIED', 'Order of preference']) {
      expect(docs, needle).toContain(needle);
    }
    expect(docs.indexOf('Enterprise Guide by COM')).toBeLessThan(docs.indexOf('The screens (the last resort)')); // COM is documented before the screens
    expect(docs).toMatch(/only\*\* for tests \*about the GUI itself\*/);
    for (const m of docs.matchAll(/`((?:src|bridge|env|docs|tests)\/[A-Za-z0-9_./-]+\.(?:ts|ps1|js|md|example))`/g)) {
      expect(fs.existsSync(path.join(repoRoot, m[1] as string)), m[1]).toBe(true);
    }
  });
});
