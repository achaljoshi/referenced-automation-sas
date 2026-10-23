import type { RunContext } from '../core';
import { SAMPLE_PROJECT, type FakeProject, type FakeSasDesktop } from '../desktop';

/**
 * The stand-in Enterprise Guide project the examples and the sample features open.
 *
 * Its file AND its programs are named with the run's NAMESPACE (`C:\Projects\AUTO_<runId>_Sales.egp`, programs `AUTO_<runId>_Program`
 * and `AUTO_<runId>_Summary`) on purpose: running a project or a program is an `update` (SAS code runs on the profile's server) and
 * the safety policy only lets a run change objects inside its own namespace. On a real system your project already exists under its
 * own name: either keep test projects and programs named with the namespace, or deliberately run an existing one with
 * SAS_ALLOW_OUTSIDE_NAMESPACE=true and a SAS_ALLOW_OUTSIDE_NAMESPACE_REASON (which is written to the audit log).
 */
export function sampleProjectPath(run: RunContext): string {
  return `C:\\Projects\\${run.ns('Sales')}.egp`;
}

/** The names of the sample project's programs, in the run's namespace: `sampleProgramName(run, 'Summary')` = `AUTO_<runId>_Summary`. */
export const SAMPLE_PROGRAMS = ['Program', 'Summary'] as const;
export type SampleProgram = (typeof SAMPLE_PROGRAMS)[number];

export function sampleProgramName(run: RunContext, program: SampleProgram): string {
  return run.ns(program);
}

/** The stand-in's sample project with every program renamed into the run's namespace. */
export function sampleProject(run: RunContext): FakeProject {
  const rename = (name: string): string => (SAMPLE_PROGRAMS.includes(name as SampleProgram) ? run.ns(name) : name);
  return {
    flows: SAMPLE_PROJECT.flows.map((flow) => ({ name: flow.name, programs: flow.programs.map(rename) })),
    programs: SAMPLE_PROJECT.programs.map((program) => ({ ...program, name: rename(program.name) })),
  };
}

/** Makes the sample project exist in the stand-in desktop (every worker has its own stand-in). Returns its path. */
export function registerSampleProject(simulator: FakeSasDesktop, run: RunContext): string {
  const file = sampleProjectPath(run);
  simulator.eg.options.projects[file] = sampleProject(run);
  return file;
}
