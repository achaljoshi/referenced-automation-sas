import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { ConfigurationError, isHostAllowed, loadEnvironments, parseEnvironments } from '../../src/core';
import { ConfigReader } from '@automation/referenced-automation-utils';
import { useCleanSasEnv } from './support';

useCleanSasEnv();

// The two files that declare the SAS environments: the committed one (only the stand-in) and the example the team copies from.
const root = path.resolve(__dirname, '..', '..');
const parse = (file: string) => parseEnvironments(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')), file);

test('the committed file declares the stand-in as a nonprod environment that contacts nothing but localhost - and nothing else', () => {
  const environments = parse('env/sas-environments.json');
  expect(environments.map((e) => `${e.name}:${e.kind}`)).toEqual(['simulator:nonprod']);
  const [simulator] = environments;
  expect(simulator?.hosts).toEqual(['localhost']);
  expect(isHostAllowed(simulator as never, 'http://localhost:8080')).toBe(true);
  expect(isHostAllowed(simulator as never, 'sasmeta.example.com')).toBe(false);
});

test('the default environments file is that one: loadEnvironments finds it from the repo root', () => {
  const previous = process.cwd();
  process.chdir(root);
  try {
    expect(loadEnvironments(new ConfigReader({ ENV: 'qa' })).names).toEqual(['simulator']);
  } finally {
    process.chdir(previous);
  }
});

test('the example declares dev, qa, stage as nonprod and prod as prod; every host pattern is accepted by the policy\'s own validation', () => {
  const environments = parse('env/sas-environments.json.example');
  expect(environments.map((e) => `${e.name}:${e.kind}`)).toEqual(['dev:nonprod', 'qa:nonprod', 'stage:nonprod', 'prod:prod']);
  const dev = environments.find((e) => e.name === 'dev');
  expect(isHostAllowed(dev as never, 'sasmeta.dev.example.com')).toBe(true);
  expect(isHostAllowed(dev as never, 'app1.dev.example.com:8561')).toBe(true);
  expect(isHostAllowed(dev as never, 'sasmeta.qa.example.com')).toBe(false); // dev's list does not open qa
  expect(isHostAllowed(environments.find((e) => e.name === 'prod') as never, 'sasmeta.dev.example.com')).toBe(false);
});

test('a file that would let a run turn production into "nonprod" by omission is refused: the kind has no default', () => {
  expect(() => parseEnvironments({ environments: { prod: { hosts: ['sasmeta.example.com'] } } })).toThrow(ConfigurationError);
  expect(() => parseEnvironments({ environments: { dev: { kind: 'nonprod', hosts: ['*'] } } })).toThrow(/too broad/);
});
