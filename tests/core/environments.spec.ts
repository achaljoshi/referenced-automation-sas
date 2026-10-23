import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  EnvironmentRegistry,
  PolicyViolation,
  assertHostAllowed,
  hostOf,
  isHostAllowed,
  loadEnvironments,
  parseEnvironments,
  parseLocation,
  selectedEnvironment,
  selectedEnvironmentName,
} from '../../src/core';
import { ENVIRONMENTS, config, registry, tempDir, useCleanSasEnv } from './support';

useCleanSasEnv();

const dev = ENVIRONMENTS[0]!;

test.describe('selecting an environment', () => {
  test('SAS_ENVIRONMENT wins; otherwise the ENV name is used; names are lower-cased', () => {
    expect(selectedEnvironmentName(config({ ENV: 'qa' }))).toBe('qa');
    expect(selectedEnvironmentName(config({ ENV: 'qa', SAS_ENVIRONMENT: ' DEV ' }))).toBe('dev');
  });

  test('an invalid name is refused', () => {
    expect(() => selectedEnvironmentName(config({ SAS_ENVIRONMENT: '../prod' }))).toThrow(/not a valid environment name/);
  });

  test('an environment that is not declared is refused with how to declare it', () => {
    const error = (() => {
      try {
        selectedEnvironment(config({ SAS_ENVIRONMENT: 'stage' }), registry());
      } catch (e) {
        return e as PolicyViolation;
      }
    })();
    expect(error).toBeInstanceOf(PolicyViolation);
    expect(error?.rule).toBe('unknown-environment');
    expect(error?.message).toContain('"stage" is not declared (declared: dev, prod, qa)');
    expect(error?.message).toContain('How to proceed: add "stage" to the environments file');
  });
});

test.describe('the environments file', () => {
  const valid = { environments: { Dev: { kind: 'nonprod', hosts: ['sasmeta.dev.example.com'], description: 'Development' }, prod: { kind: 'prod', hosts: ['*.sas.example.com'] } } };

  test('is read from SAS_ENVIRONMENTS_FILE; names are lower-cased; kind and hosts are kept', () => {
    const dir = tempDir();
    const file = path.join(dir, 'envs.json');
    fs.writeFileSync(file, JSON.stringify(valid));
    const loaded = loadEnvironments(config({ SAS_ENVIRONMENTS_FILE: file }));
    expect(loaded.names).toEqual(['dev', 'prod']);
    expect(loaded.get('DEV')).toEqual({ name: 'dev', kind: 'nonprod', hosts: ['sasmeta.dev.example.com'], description: 'Development' });
    expect(loaded.get('prod')?.kind).toBe('prod');
  });

  test('a configured file that does not exist is an error; a missing DEFAULT file means no environment is known', () => {
    expect(() => loadEnvironments(config({ SAS_ENVIRONMENTS_FILE: path.join(tempDir(), 'nope.json') }))).toThrow(/does not exist/);
    const cwd = process.cwd();
    process.chdir(tempDir());
    try {
      expect(loadEnvironments(config()).names).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  test('invalid JSON is reported with the file name', () => {
    const file = path.join(tempDir(), 'bad.json');
    fs.writeFileSync(file, '{ nope');
    expect(() => loadEnvironments(config({ SAS_ENVIRONMENTS_FILE: file }))).toThrow(/bad\.json is not valid JSON/);
  });

  test('a missing or unknown kind is refused - there is no default, so a typo cannot make production "nonprod"', () => {
    expect(() => parseEnvironments({ environments: { x1: { hosts: ['a.example.com'] } } })).toThrow(/"kind" must be exactly "nonprod" or "prod"/);
    expect(() => parseEnvironments({ environments: { x1: { kind: 'Prod', hosts: ['a.example.com'] } } })).toThrow(/"kind" must be exactly/);
    expect(() => parseEnvironments({ environments: { x1: { kind: 'test', hosts: ['a.example.com'] } } })).toThrow(/"kind" must be exactly/);
  });

  test('no hosts, a duplicate name, unknown entries and secrets are refused', () => {
    expect(() => parseEnvironments({ environments: { x1: { kind: 'nonprod', hosts: [] } } })).toThrow(/non-empty list/);
    expect(() => parseEnvironments({ environments: { x1: { kind: 'nonprod', hosts: ['a.example.com'] }, X1: { kind: 'nonprod', hosts: ['b.example.com'] } } })).toThrow(/declared twice/);
    expect(() => parseEnvironments({ environments: { x1: { kind: 'nonprod', hosts: ['a.example.com'], owner: 'me' } } })).toThrow(/unknown entries "owner"/);
    expect(() => parseEnvironments({ environments: { x1: { kind: 'nonprod', hosts: ['a.example.com'], password: 'x' } } })).toThrow(/"password" entry: this file is committed and holds no secrets/);
    expect(() => parseEnvironments([])).toThrow(/expected an object/);
  });

  test('host patterns that would allow too much are refused', () => {
    for (const bad of ['*', '**', '**.com', '*.corp', '*.*', 'ab', '.example.com', 'a..example.com', 'sas meta.example.com', '*.example.*', 'host:99999x', '10.20.*.*'])
      expect(() => parseEnvironments({ environments: { x1: { kind: 'nonprod', hosts: [bad] } } }), bad).toThrow(/host pattern/);
    for (const good of ['sasmeta', 'sasmeta*', '*.sas.corp', '**.dev.example.com', 'meta-*.example.com:8561', '10.20.1.5'])
      expect(() => parseEnvironments({ environments: { x1: { kind: 'nonprod', hosts: [good] } } }), good).not.toThrow();
  });
});

test.describe('which host a location refers to', () => {
  test('URLs, host:port, UNC paths and plain hosts', () => {
    expect(parseLocation('https://SASMeta.Dev.Example.com:8561/SASLogon/login')).toEqual({ host: 'sasmeta.dev.example.com', port: 8561 });
    expect(parseLocation('sasmeta.dev.example.com:8561')).toEqual({ host: 'sasmeta.dev.example.com', port: 8561 });
    expect(parseLocation('sasmeta.dev.example.com')).toEqual({ host: 'sasmeta.dev.example.com' });
    expect(parseLocation('\\\\fileserver.dev.example.com\\share\\folder')).toEqual({ host: 'fileserver.dev.example.com' });
    expect(parseLocation('//fileserver.dev.example.com/share')).toEqual({ host: 'fileserver.dev.example.com' });
    expect(parseLocation('sasmeta.dev.example.com.')).toEqual({ host: 'sasmeta.dev.example.com' });
  });

  test('a user-info trick names the host the URL really goes to', () => {
    expect(hostOf('https://sasmeta.dev.example.com@evil.example.net/')).toBe('evil.example.net');
    expect(hostOf('https://sasmeta.dev.example.com:pw@evil.example.net:8443/')).toBe('evil.example.net');
  });

  test('a drive path, an empty string and text with spaces or control characters have no host', () => {
    for (const text of ['C:\\SAS\\tools', '', '   ', 'host with space', 'host\u0000name', 'host\nname']) expect(parseLocation(text), JSON.stringify(text)).toBeUndefined();
  });
});

test.describe('the host allow-list', () => {
  test('an exact host, and a single-label wildcard that does not cross dots', () => {
    expect(isHostAllowed(dev, 'sasmeta.dev.example.com')).toBe(true);
    expect(isHostAllowed(dev, 'SASMETA.DEV.EXAMPLE.COM')).toBe(true);
    expect(isHostAllowed(dev, 'sasmeta.qa.example.com')).toBe(false);
    const env: typeof dev = { name: 'x', kind: 'nonprod', hosts: ['meta-*.dev.example.com'] };
    expect(isHostAllowed(env, 'meta-1.dev.example.com')).toBe(true);
    expect(isHostAllowed(env, 'meta-1.sub.dev.example.com')).toBe(false);
    expect(isHostAllowed(env, 'meta-.dev.example.com')).toBe(true);
    expect(isHostAllowed(env, 'meta-1.dev.example.com.evil.net')).toBe(false);
    expect(isHostAllowed(env, 'xmeta-1.dev.example.com')).toBe(false);
  });

  test('** crosses dots; the domain must still match at the end', () => {
    expect(isHostAllowed({ ...dev, hosts: ['**.dev.example.com'] }, 'a.b.dev.example.com')).toBe(true);
    expect(isHostAllowed({ ...dev, hosts: ['**.dev.example.com'] }, 'dev.example.com')).toBe(false);
    expect(isHostAllowed({ ...dev, hosts: ['**.dev.example.com'] }, 'a.dev.example.com.evil.net')).toBe(false);
    expect(isHostAllowed({ ...dev, hosts: ['**.dev.example.com'] }, 'a.dev-example.com')).toBe(false);
  });

  test('a dot in a pattern is a dot, not "any character"', () => {
    expect(isHostAllowed({ ...dev, hosts: ['sasmeta.dev.example.com'] }, 'sasmetaXdev.example.com')).toBe(false);
  });

  test('a pattern with a port needs that port; one without accepts any', () => {
    expect(isHostAllowed(dev, 'https://a.dev.example.com:8561/x')).toBe(true);
    expect(isHostAllowed(dev, 'a.dev.example.com:9999')).toBe(false);
    expect(isHostAllowed(dev, 'a.dev.example.com')).toBe(false); // pattern needs :8561
    expect(isHostAllowed(dev, 'sasmeta.dev.example.com:9999')).toBe(true); // exact pattern has no port
  });

  test('UNC paths and URLs are checked by their host; the user-info trick is refused', () => {
    expect(isHostAllowed(dev, '\\\\sasmeta.dev.example.com\\share')).toBe(true);
    expect(isHostAllowed(dev, '\\\\other.example.com\\share')).toBe(false);
    expect(isHostAllowed(dev, 'https://sasmeta.dev.example.com@evil.example.net/')).toBe(false);
  });

  test('assertHostAllowed names the host, the environment, the allowed patterns, and how to proceed', () => {
    expect(() => assertHostAllowed(dev, 'sasmeta.dev.example.com')).not.toThrow();
    const error = (() => {
      try {
        assertHostAllowed(dev, 'https://prodmeta.example.com:8561', { driver: 'sas-process', operation: 'export' });
      } catch (e) {
        return e as PolicyViolation;
      }
    })();
    expect(error).toBeInstanceOf(PolicyViolation);
    expect(error?.rule).toBe('host-not-allowed');
    expect(error?.message).toContain('host "prodmeta.example.com:8561" is not on the allow-list of environment "dev" (nonprod)');
    expect(error?.message).toContain('sasmeta.dev.example.com');
    expect(error?.message).toContain('How to proceed');
    expect(error?.message).toMatch(/^\[sas-process\] export failed:/);
  });

  test('a location with no determinable host is refused with its own message', () => {
    expect(() => assertHostAllowed(dev, 'C:\\SAS')).toThrow(/not a network location/);
  });

  test('the registry looks names up case-insensitively', () => {
    expect(new EnvironmentRegistry(ENVIRONMENTS).get(' QA ')?.name).toBe('qa');
  });
});
