import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { looksSecretName, redactSource, secretKindOfEntry, secretKindOfName, SECRET_ENV_VAR, SECRET_WORDS, SECRET_WORDS_BY_KIND, type SecretKind } from '../../src/recorder';
import { step, target } from './support/events';

test.describe('what is a secret', () => {
  const secret: Array<[string, SecretKind]> = [
    ['Password:', 'password'],
    ['Confirm password', 'password'],
    ['txtPassword', 'password'],
    ['pwdField', 'password'],
    ['USER_PASSWD', 'password'],
    ['Passphrase', 'password'],
    ['Kennwort', 'password'],
    ['Credentials', 'password'],
    ['PIN', 'pin'],
    ['userPin', 'pin'],
    ['One-time OTP', 'otp'],
    ['Access Token', 'token'],
    ['Client Secret', 'secret'],
    ['API Key', 'key'],
    ['apiKey', 'key'],
    ['Key', 'key'],
    ['encryptionKey', 'key'],
  ];
  for (const [name, kind] of secret) {
    test(`"${name}" is a ${kind} field`, () => {
      expect(secretKindOfName(name)).toBe(kind);
      expect(looksSecretName(undefined, '', name)).toBe(true);
    });
  }

  for (const name of ['User ID:', 'Name', 'Display Name:', 'spinner', 'mapping', 'Pinned items', 'Keyboard', 'Passenger', 'Compass', 'tokenizer', 'Monkey', 'File name:', '']) {
    test(`"${name}" is not (names are judged by whole words)`, () => {
      expect(secretKindOfName(name)).toBeUndefined();
    });
  }

  test('the first secret word decides the kind; the name or the automation id may carry it', () => {
    expect(secretKindOfName('Secret key')).toBe('secret');
    expect(secretKindOfName('Name', 'txtPin')).toBe('pin');
    expect(secretKindOfName(undefined, undefined)).toBeUndefined();
  });

  test('every kind has an environment variable and a word, and the tables agree', () => {
    expect(Object.keys(SECRET_ENV_VAR).sort()).toEqual(['key', 'otp', 'password', 'pin', 'secret', 'token']);
    expect(SECRET_ENV_VAR.password).toBe('SAS_PASSWORD');
    for (const [kind, words] of Object.entries(SECRET_WORDS_BY_KIND)) for (const word of words) expect(SECRET_WORDS[word], word).toBe(kind);
    expect(Object.keys(SECRET_WORDS).length).toBe(Object.values(SECRET_WORDS_BY_KIND).flat().length);
  });

  test('an entry is secret by its own kind, by its control name, or by being flagged (password)', () => {
    expect(secretKindOfEntry({ secretKind: 'otp', target: target('w', step.edit('Code')) })).toBe('otp');
    expect(secretKindOfEntry({ target: target('w', step.edit('Your PIN')) })).toBe('pin');
    expect(secretKindOfEntry({ secret: true, target: target('w', step.edit('Field')) })).toBe('password');
    expect(secretKindOfEntry({ target: target('w', step.edit('Field')) })).toBeUndefined();
  });
});

test.describe('the PowerShell recorder knows the same words', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bridge', 'sas-desktop-bridge.ps1'), 'utf8');

  test('its secret-word table is the TypeScript one (a word added on one side fails here until it is on the other)', () => {
    const fromScript: Record<string, string> = {};
    const list = /string\[\] password = new string\[\] \{([^}]*)\}/.exec(script);
    expect(list, 'the password word list in the recorder source').toBeTruthy();
    for (const word of [...(list?.[1] as string).matchAll(/"([a-z]+)"/g)]) fromScript[word[1] as string] = 'password';
    for (const m of script.matchAll(/SecretWords\["([a-z]+)"\] = "([a-z]+)";/g)) fromScript[m[1] as string] = m[2] as string;
    expect(fromScript).toEqual(SECRET_WORDS);
  });
});

test.describe('redactSource', () => {
  test('a line that handles a secret loses its string literals; other lines keep them', () => {
    const typed = 'Sup3r-Secret!';
    expect(redactSource(`pwd = "${typed}"`)).toBe('pwd = "[REDACTED]"');
    expect(redactSource("$token = 'abc123def'")).toBe('$token = "[REDACTED]"');
    expect(redactSource('Set prj = app.Open("C:\\Projects\\Sales.egp", "")')).toBe('Set prj = app.Open("C:\\Projects\\Sales.egp", "")');
    expect(redactSource('x = "eyJhbGciOi.eyJzdWIiOiIx.abc"')).toBe('x = "[REDACTED]"'); // a JWT, whatever the line says
    expect(redactSource('v = ""')).toBe('v = ""');
  });
});
