import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  assertBridgeVerified,
  BRIDGE_SHA256,
  bridgeHash,
  BridgeTamperedError,
  bridgeInvocation,
  bridgeScriptPath,
  normalizeBridgeText,
  PowerShellTransport,
  readBridgeScript,
  verifyBridge,
  APPROVED_SCRIPT_NAME,
} from '../../src/desktop';
import { repoRoot, runNode, tempDir } from './support';

const sign = (text: string) => `${text}\r\n# SIG # Begin signature block\r\n# MIIFakeSignatureBytes==\r\n# SIG # End signature block\r\n`;

test.describe('bridge script hash (build-time SHA-256)', () => {
  test('the generated constant is the hash of the shipped script', () => {
    expect(BRIDGE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(bridgeHash(readBridgeScript())).toBe(BRIDGE_SHA256);
    expect(verifyBridge()).toMatchObject({ ok: true, file: bridgeScriptPath(), expected: BRIDGE_SHA256, actual: BRIDGE_SHA256 });
    expect(assertBridgeVerified().ok).toBe(true);
  });

  test('the build step agrees: `node bridge/generate-hash.js --check` passes, --print prints the same hash', () => {
    const check = runNode(['bridge/generate-hash.js', '--check']);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain(BRIDGE_SHA256);
    expect(runNode(['bridge/generate-hash.js', '--print']).stdout.trim()).toBe(BRIDGE_SHA256);
  });

  test('a one-character edit changes the hash and is refused with the expected and the found hash', () => {
    const dir = tempDir();
    const copy = path.join(dir, APPROVED_SCRIPT_NAME);
    fs.writeFileSync(copy, readBridgeScript().replace("'ping' { Op-Ping $cmd }", "'ping' { Op-Ping  $cmd }"));
    const result = verifyBridge(copy);
    expect(result.ok).toBe(false);
    expect(result.actual).not.toBe(BRIDGE_SHA256);
    const error = (() => {
      try {
        assertBridgeVerified(copy);
      } catch (e) {
        return e as BridgeTamperedError;
      }
    })();
    expect(error).toBeInstanceOf(BridgeTamperedError);
    expect(error?.message).toContain(BRIDGE_SHA256);
    expect(error?.message).toContain(result.actual);
    expect(error?.message).toMatch(/Refusing to run a modified or outdated copy/);
  });

  test('a changed copy of the script is not run: neither from the packaged file (hash override) nor from an approved folder', () => {
    const tmp = tempDir();
    expect(() => bridgeInvocation({ expectedHash: '0'.repeat(64), tmpDir: tmp })).toThrow(BridgeTamperedError);
    expect(fs.readdirSync(tmp)).toEqual([]); // nothing was written to run
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, APPROVED_SCRIPT_NAME), `${readBridgeScript()}\nStart-Process calc\n`);
    expect(() => bridgeInvocation({ scriptDir: dir })).toThrow(BridgeTamperedError);
  });

  test('line endings, the byte order mark and an Authenticode signature do not change the hash (the approved, signed copy is accepted)', () => {
    const text = readBridgeScript();
    expect(bridgeHash(text.replace(/\n/g, '\r\n'))).toBe(BRIDGE_SHA256);
    expect(bridgeHash(`\uFEFF${text}`)).toBe(BRIDGE_SHA256);
    expect(bridgeHash(sign(text))).toBe(BRIDGE_SHA256);
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, APPROVED_SCRIPT_NAME), sign(`\uFEFF${text}`));
    expect(verifyBridge(path.join(dir, APPROVED_SCRIPT_NAME)).ok).toBe(true);
    expect(bridgeInvocation({ scriptDir: dir }).args).toContain(path.join(dir, APPROVED_SCRIPT_NAME));
  });

  test('code hidden behind a fake signature marker is NOT ignored: only a block of comment lines counts as a signature', () => {
    const text = readBridgeScript();
    const hidden = `${text}\n# SIG # Begin signature block\nStart-Process calc\n# SIG # End signature block\n`;
    expect(bridgeHash(hidden)).not.toBe(BRIDGE_SHA256);
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, APPROVED_SCRIPT_NAME), hidden);
    expect(() => bridgeInvocation({ scriptDir: dir })).toThrow(BridgeTamperedError);
    expect(normalizeBridgeText(sign(text))).toBe(normalizeBridgeText(text)); // a real block (comment lines only) is cut
  });

  test('the TypeScript normalisation and the build script compute the same hash for the same text', () => {
    const dir = tempDir();
    const odd = readBridgeScript().replace(/\n/g, '\r\n');
    const file = path.join(dir, 'x.ps1');
    fs.writeFileSync(file, `\uFEFF${odd}  \n\n`);
    // run the generator's normalise+hash on this file by pointing a copy of it at the file
    const generator = fs.readFileSync(path.join(repoRoot, 'bridge', 'generate-hash.js'), 'utf8').replace("path.resolve(__dirname, 'sas-desktop-bridge.ps1')", JSON.stringify(file)).replace("path.resolve(__dirname, '..', 'src', 'desktop', 'bridgeHash.generated.ts')", JSON.stringify(path.join(dir, 'out.ts')));
    const script = path.join(dir, 'gen.js');
    fs.writeFileSync(script, generator);
    expect(runNode([script, '--print']).stdout.trim()).toBe(bridgeHash(fs.readFileSync(file, 'utf8')));
  });

  test('the shipped bridge is delivered as a private temporary copy of the verified bytes, with ExecutionPolicy Bypass, and cleaned up', () => {
    const tmp = tempDir();
    const inv = bridgeInvocation({ tmpDir: tmp, allowProgIds: ['SASEGObjectModel.Application.*', 'SASObjectManager.*'] });
    expect(inv.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive']);
    expect(inv.args).toContain('-ExecutionPolicy');
    expect(inv.args[inv.args.indexOf('-ExecutionPolicy') + 1]).toBe('Bypass');
    expect(inv.args[inv.args.indexOf('-File') + 1]).toBe(inv.scriptFile);
    expect(path.dirname(inv.scriptFile)).toBe(tmp);
    expect(fs.readFileSync(inv.scriptFile).equals(fs.readFileSync(bridgeScriptPath()))).toBe(true); // byte for byte, BOM included
    expect(inv.args.slice(-2)).toEqual(['-AllowProgIds', 'SASEGObjectModel.Application.*,SASObjectManager.*']);
    inv.cleanup();
    expect(fs.existsSync(inv.scriptFile)).toBe(false);
  });

  test('an approved folder is run in place WITHOUT ExecutionPolicy Bypass (the machine policy decides); a missing file says how to create it', () => {
    const dir = tempDir();
    fs.copyFileSync(bridgeScriptPath(), path.join(dir, APPROVED_SCRIPT_NAME));
    const inv = bridgeInvocation({ scriptDir: dir });
    expect(inv.args).not.toContain('Bypass');
    expect(inv.args).not.toContain('-ExecutionPolicy');
    expect(inv.scriptFile).toBe(path.join(dir, APPROVED_SCRIPT_NAME));
    expect(() => bridgeInvocation({ scriptDir: path.join(dir, 'nowhere') })).toThrow(/does not exist.*copy/s);
  });

  test('PowerShellTransport refuses to start on a platform that is not Windows, saying what to use instead', async () => {
    const error = (await PowerShellTransport.start({ platform: 'darwin' }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/Windows-only/);
    expect(error.message).toMatch(/SAS_DESKTOP_TRANSPORT=remote/);
    expect(error.message).toMatch(/SAS_DESKTOP_SIMULATOR=true/);
  });
});
