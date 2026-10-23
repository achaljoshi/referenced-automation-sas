import { inspect } from 'node:util';
import { expect, test } from '@playwright/test';
import { ConfigurationError, Credentials, credentialVariables, credentialsFor, hasCredentials, maskSecrets } from '../../src/core';
import { config, useCleanSasEnv } from './support';

useCleanSasEnv();

const PASSWORD = 'Wr0ng-pa55#word';

test.describe('reading the personal login', () => {
  test('SAS_USER / SAS_PASSWORD', () => {
    const credentials = credentialsFor('smc', config({ SAS_USER: 'ajoshi', SAS_PASSWORD: PASSWORD }));
    expect(credentials.user).toBe('ajoshi');
    expect(credentials.application).toBe('smc');
    expect(credentials.reveal()).toBe(PASSWORD);
    expect(credentials.source).toBe('SAS_USER / SAS_PASSWORD');
  });

  test('the application\'s own SAS_SMC_* / SAS_EG_* win, for that application only', () => {
    const env = config({ SAS_USER: 'general', SAS_PASSWORD: 'general-pw', SAS_SMC_USER: 'smcadmin', SAS_SMC_PASSWORD: 'smc-pw' });
    expect(credentialsFor('smc', env).user).toBe('smcadmin');
    expect(credentialsFor('smc', env).reveal()).toBe('smc-pw');
    expect(credentialsFor('smc', env).source).toBe('SAS_SMC_USER / SAS_SMC_PASSWORD');
    expect(credentialsFor('eg', env).user).toBe('general');
    expect(credentialsFor('eg', config({ SAS_EG_USER: 'egu', SAS_EG_PASSWORD: 'egp' })).user).toBe('egu');
  });

  test('user and password are one pair: a half-set override is an error, never a mixed pair (a wrong pair counts towards the lockout)', () => {
    const general = { SAS_USER: 'general', SAS_PASSWORD: 'general-pw' };
    expect(() => credentialsFor('smc', config({ ...general, SAS_SMC_USER: 'smcadmin' }))).toThrow(/no password for smc: set SAS_SMC_PASSWORD.*must be set together/s);
    expect(() => credentialsFor('smc', config({ ...general, SAS_SMC_PASSWORD: 'x' }))).toThrow(/no user name for smc.*must be set together/s);
  });

  test('missing or empty values say which setting to set and where - and never print a value', () => {
    expect(() => credentialsFor('eg', config())).toThrow(/no user name for eg: set SAS_USER \(and SAS_PASSWORD\) in \.env\.qa\.local or a masked CI variable/);
    const error = (() => {
      try {
        credentialsFor('eg', config({ SAS_USER: 'ajoshi' }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error?.message).toMatch(/no password for eg: set SAS_PASSWORD/);
    expect(() => credentialsFor('eg', config({ SAS_USER: 'ajoshi', SAS_PASSWORD: '' }))).toThrow(/no password/);
    expect(() => credentialsFor('eg', config({ SAS_USER: '  ', SAS_PASSWORD: 'x' }))).toThrow(/no user name/);
  });

  test('an application name is validated and turned into variable names', () => {
    expect(credentialVariables('smc')).toEqual({ user: 'SAS_SMC_USER', password: 'SAS_SMC_PASSWORD' });
    for (const bad of ['SMC', 'a_b', '', 'x y', '../x']) expect(() => credentialVariables(bad), bad).toThrow(/application/);
  });

  test('hasCredentials never throws and never needs the password to be printed', () => {
    expect(hasCredentials('smc', config())).toBe(false);
    expect(hasCredentials('smc', config({ SAS_USER: 'a', SAS_PASSWORD: 'b' }))).toBe(true);
  });

  test('a password is taken exactly as written (no trimming), including # and spaces', () => {
    expect(credentialsFor('smc', config({ SAS_USER: ' u ', SAS_PASSWORD: ' my#pass word ' })).reveal()).toBe(' my#pass word ');
    expect(credentialsFor('smc', config({ SAS_USER: ' u ', SAS_PASSWORD: 'x' })).user).toBe('u');
  });
});

test.describe('the secret stays inside', () => {
  const credentials = new Credentials({ application: 'smc', user: 'ajoshi', password: PASSWORD, source: 'test' });

  test('JSON, string conversion, util.inspect, console formatting, spread, Object.keys and structuredClone never show it', () => {
    const shown = [
      JSON.stringify(credentials),
      JSON.stringify({ wrapped: credentials }),
      String(credentials),
      `${credentials}`,
      inspect(credentials),
      inspect({ deep: { credentials } }, { depth: 5, showHidden: true }),
      JSON.stringify({ ...credentials }),
      JSON.stringify(Object.keys(credentials)),
      JSON.stringify(Object.getOwnPropertyNames(credentials)),
      JSON.stringify(structuredClone({ ...credentials })),
      credentials.describe(),
    ];
    for (const text of shown) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('pa55');
    }
    expect(JSON.parse(JSON.stringify(credentials))).toEqual({ application: 'smc', user: 'ajoshi', password: '***' });
    expect(String(credentials)).toBe('Credentials(smc, ajoshi, ***)');
  });

  test('reveal() is the only way out', () => {
    expect(credentials.reveal()).toBe(PASSWORD);
  });

  test('a password is registered as a secret: it is removed from any text that passes through the masker', () => {
    new Credentials({ application: 'smc', user: 'ajoshi', password: PASSWORD }); // registers it (the registry is emptied before each test)
    expect(maskSecrets(`the tool said: bad password ${PASSWORD} for ajoshi`)).toBe('the tool said: bad password *** for ajoshi');
    expect(maskSecrets(`url-encoded: ${encodeURIComponent(PASSWORD)}`)).toBe('url-encoded: ***');
    expect(maskSecrets(`json: ${JSON.stringify(PASSWORD)}`)).toBe('json: "***"');
  });

  test('the fingerprint is stable per salt, differs per password and per salt, and does not contain the password', () => {
    const other = new Credentials({ application: 'smc', user: 'ajoshi', password: 'another-password' });
    expect(credentials.fingerprint('s1')).toBe(credentials.fingerprint('s1'));
    expect(credentials.fingerprint('s1')).not.toBe(credentials.fingerprint('s2'));
    expect(credentials.fingerprint('s1')).not.toBe(other.fingerprint('s1'));
    expect(credentials.fingerprint()).toMatch(/^[0-9a-f]{48}$/);
    expect(credentials.fingerprint()).toBe(new Credentials({ application: 'eg', user: 'AJOSHI', password: PASSWORD }).fingerprint());
  });

  test('an empty user or password cannot be constructed', () => {
    expect(() => new Credentials({ application: 'smc', user: '', password: 'x' })).toThrow(/user name is empty/);
    expect(() => new Credentials({ application: 'smc', user: 'u', password: '' })).toThrow(/password is empty/);
  });
});
