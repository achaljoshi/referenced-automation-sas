import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENVIRONMENTS_FILE } from './support';

/** Where the specs that run on the stand-in keep their state: under test-results, which Playwright empties at the start of every run. */
export const STATE = 'test-results/sas-state-fixtures';
export const EVIDENCE_DIR = path.resolve('test-results', 'sas-evidence-fixtures');

/** `sasSettings` for a spec file: worker options cannot be set inside a describe block, so each setting gets its own file. */
export const settings = (values: Record<string, string> = {}): Record<string, string> => ({ SAS_STATE_DIR: STATE, SAS_ENVIRONMENTS_FILE: ENVIRONMENTS_FILE, SAS_EVIDENCE_DIR: EVIDENCE_DIR, ...values });

/** The file-name part the desktop session derives from an evidence label. */
export const slug = (title: string): string => title.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export const alive = (fake: { desktop: { processes: Array<{ name: string; alive: boolean }> } } | undefined, name: string): boolean => fake?.desktop.processes.some((p) => p.name === name && p.alive) ?? false;

/** The evidence files of one run. */
export const evidenceFiles = (runId: string): string[] => (fs.existsSync(path.join(EVIDENCE_DIR, runId)) ? fs.readdirSync(path.join(EVIDENCE_DIR, runId)) : []);
