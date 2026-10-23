import { expect, test } from '@playwright/test';
import { checkBalanced, dispatchedOps, functionBody, scriptBytes, scriptText } from './bridgeScript';

// Static checks of the PowerShell bridge. The script has NEVER run on Windows from this repository's machine: these tests only prove it is
// well-formed text with the properties its header promises.

test.describe('bridge script (static)', () => {
  test('it is ASCII text behind a UTF-8 byte order mark (Windows PowerShell 5.1 reads it correctly)', () => {
    const bytes = scriptBytes();
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = bytes.subarray(3);
    const bad = [...body].findIndex((b) => b > 0x7f || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    expect(bad, `non-ASCII or control byte at ${bad}`).toBe(-1);
  });

  test('braces, parentheses, brackets and quotes balance (also in the embedded C#)', () => {
    const result = checkBalanced(scriptText());
    expect(result.problem).toBeUndefined();
    expect(result.hereStrings.length).toBe(3); // the two C# helpers and the recorder's (compiled on first use)
    for (const csharp of result.hereStrings) {
      // C# has no # comments or PowerShell quoting: count only braces and parentheses outside string literals
      const stripped = csharp.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, '');
      let braces = 0;
      let parens = 0;
      for (const ch of stripped) {
        braces += ch === '{' ? 1 : ch === '}' ? -1 : 0;
        parens += ch === '(' ? 1 : ch === ')' ? -1 : 0;
        expect(braces).toBeGreaterThanOrEqual(0);
      }
      expect({ braces, parens }).toEqual({ braces: 0, parens: 0 });
    }
  });

  test('the checker itself can fail: it catches a missing brace, an unterminated quote and a here-string left open', () => {
    expect(checkBalanced('function A { if ($x) { 1 }').ok).toBe(false);
    expect(checkBalanced("$x = 'abc").ok).toBe(false);
    expect(checkBalanced('$x = @\'\nabc\n').ok).toBe(false);
    expect(checkBalanced('function A { "a { b" ; # } \n }').ok).toBe(true); // braces in strings and comments do not count
    expect(checkBalanced('function A { ( ] }').ok).toBe(false);
  });

  test('param() comes first and the script stops on errors and keeps stdout for the protocol only', () => {
    const text = scriptText();
    const firstCode = text.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    expect(firstCode).toMatch(/^param\(/);
    expect(text).toMatch(/\$ErrorActionPreference = 'Stop'/);
    expect(text).not.toMatch(/Write-Host|Write-Output|Write-Verbose|Write-Information|Out-Host/); // any of those would put non-protocol text on stdout
    expect((text.match(/\[Console\]::Out\.WriteLine/g) ?? []).length).toBe(1); // exactly one place writes to stdout
    expect(text).toMatch(/\$null = Invoke-Op/); // stray return values of an operation cannot leak onto stdout
  });

  test('it does what the header says and nothing else: no network, no downloads, no registry writes, no policy changes, no dynamic code', () => {
    const text = scriptText();
    const forbidden = [
      /Invoke-Expression|\biex\b/i,
      /Invoke-WebRequest|Invoke-RestMethod|\bcurl\b|\bwget\b|WebClient|DownloadString|DownloadFile|Start-BitsTransfer|HttpClient|System\.Net\.Sockets/i,
      /Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|\breg(\.exe)?\s+(add|delete)/i,
      /Set-ExecutionPolicy|Add-MpPreference|Set-MpPreference/i,
      /Out-File|Set-Content|Add-Content|WriteAllText|WriteAllBytes|\[System\.IO\.File\]::Create/i,
      /Import-Module|Install-Module|Install-Package/i,
      /-EncodedCommand|FromBase64String|Add-Type\s+-Path|LoadFrom|LoadFile/i,
    ];
    for (const pattern of forbidden) expect(text, String(pattern)).not.toMatch(pattern);
  });

  test('the allow-list is checked BEFORE a COM object is created, and only the argument given at start can set it', () => {
    const text = scriptText();
    const create = functionBody(text, 'Op-ComCreate');
    expect(create.indexOf('Test-ProgIdAllowed')).toBeGreaterThan(-1);
    expect(create.indexOf('Test-ProgIdAllowed')).toBeLessThan(create.indexOf('CreateInstance'));
    expect(create.indexOf('Test-ProgIdAllowed')).toBeLessThan(create.indexOf('GetTypeFromProgID'));
    expect(create).toMatch(/Fail 'DENIED'/);
    expect(text).toMatch(/param\(\s*\[string\]\$AllowProgIds = ''\s*\)/);
    // the pattern list is read once at start, from the parameter, not from a command
    expect(text.match(/\$script:allowPatterns =/g)?.length).toBe(2); // the initial empty list and Read-AllowList
    expect(functionBody(text, 'Read-AllowList')).toContain('$AllowProgIds');
    expect(create).not.toMatch(/\$cmd\.allow|Get-Prop \$cmd 'allow/i); // a command field never widens it
    // a ProgID can only be letters, digits, underscore and dots: no CLSID, moniker or path
    expect(functionBody(text, 'Test-ProgIdAllowed')).toContain("'^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$'");
    // the default allow-list
    expect(text).toContain("SASEGObjectModel.Application.*,SASObjectManager.*");
  });

  test('typed text is never echoed: no error or reply built from it, and a password field reads as empty', () => {
    const text = scriptText();
    for (const name of ['Op-SetText', 'Op-SendKeys']) {
      const body = functionBody(text, name);
      expect(body, name).not.toMatch(/Fail[^\n]*\$(text|keys)\b/);
      expect(body, name).not.toMatch(/Set-Result[^\n]*\$(text|keys)\b/);
    }
    expect(functionBody(text, 'Get-ElementText')).toMatch(/if \(Test-IsPassword \$el\) \{ return '' \}/);
    const convert = functionBody(text, 'Convert-Element');
    expect(convert).toMatch(/if \(\$isPwd\) \{ \$o\['value'\] = '' \}/);
    expect(functionBody(text, 'Op-Screenshot')).toContain('IsPasswordProperty'); // password fields are painted black in screenshots
  });

  test('kill only touches processes the bridge launched or attached to, and never itself', () => {
    const kill = functionBody(scriptText(), 'Op-Kill');
    expect(kill).toContain('$script:ownedPids.ContainsKey');
    expect(kill).toMatch(/Fail 'DENIED'/);
    expect(kill).toContain('$PID');
  });

  test('the dispatch has no duplicate and no unknown label, and ends with a default that reports an unknown operation', () => {
    const ops = dispatchedOps(scriptText());
    expect(ops.length).toBeGreaterThan(30);
    expect(new Set(ops).size).toBe(ops.length);
    expect(scriptText()).toMatch(/default \{ Fail 'ERROR' \('unknown operation/);
  });

  test('the header says NOT VERIFIED and names the 32-bit PowerShell and the interactive-session requirement', () => {
    const header = scriptText().split('param(')[0] as string;
    expect(header).toMatch(/NOT VERIFIED on a real Windows host with the real SAS applications/);
    expect(header).toMatch(/32-bit/);
    expect(header).toMatch(/interactive desktop/);
  });
});
