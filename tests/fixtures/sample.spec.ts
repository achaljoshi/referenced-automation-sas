import { expect, test } from '@playwright/test';
import { SAMPLE_PROJECT, startFakeDesktop } from '../../src/desktop';
import { SAMPLE_PROGRAMS, registerSampleProject, sampleProgramName, sampleProject, sampleProjectPath } from '../../src/fixtures';
import { RUN_ID, makeRun, useCleanSasEnv } from './support';

useCleanSasEnv();

// The stand-in project the examples and the sample features open lives inside the run's namespace, because running it is an update.

test('the project path and its programs are named with the run namespace, so the safety policy accepts running them', () => {
  const run = makeRun();
  expect(sampleProjectPath(run)).toBe(`C:\\Projects\\AUTO_${RUN_ID}_Sales.egp`);
  expect(sampleProgramName(run, 'Summary')).toBe(`AUTO_${RUN_ID}_Summary`);
  for (const target of [sampleProjectPath(run), ...SAMPLE_PROGRAMS.map((p) => sampleProgramName(run, p))]) expect(run.isInNamespace(target), target).toBe(true);
  expect(run.isInNamespace('C:\\Projects\\Sales.egp')).toBe(false); // negative control: the plain name is outside
});

test('every program of the sample project is renamed, in its flows too, and the logs are the stand-in\'s own', () => {
  const run = makeRun();
  const project = sampleProject(run);
  expect(project.programs.map((p) => p.name)).toEqual(SAMPLE_PROGRAMS.map((p) => `AUTO_${RUN_ID}_${p}`));
  expect(project.flows[0]?.programs).toEqual(project.programs.map((p) => p.name));
  expect(project.programs.map((p) => p.log)).toEqual(SAMPLE_PROJECT.programs.map((p) => p.log));
});

test('registering it makes the stand-in able to open exactly that file, next to the default sample', () => {
  const run = makeRun();
  const fake = startFakeDesktop();
  const file = registerSampleProject(fake, run);
  expect(Object.keys(fake.eg.options.projects).sort()).toEqual(['C:\\Projects\\Sales.egp', file].sort());
});
