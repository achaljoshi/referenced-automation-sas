import * as path from 'node:path';
import { FAKE_EG_PATH, FAKE_PROJECT_PATH, FAKE_SMC_PATH, startFakeDesktop } from '../../../src/desktop';
import { convertRecording, Recorder, type ConvertOptions, type ConvertResult, type Recording } from '../../../src/recorder';
import { installRecorderExtras } from './extras';
import { egRunProject, smcCreateUser } from './scenarios';

export const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Makes an example recording the way a person would: the fake program runs, the recorder is started on it, the scenario is performed by the
 * stand-in's "user", the recorder is stopped. Virtual time and a fixed start time and tool name make the file the same every time.
 */
export async function recordExample(which: 'smc' | 'eg'): Promise<Recording> {
  const fake = startFakeDesktop();
  installRecorderExtras(fake);
  const session = fake.session();
  const account = fake.smc.options.accounts[0] as { user: string; password: string };
  try {
    await session.launch({ path: which === 'smc' ? FAKE_SMC_PATH : FAKE_EG_PATH, windowTitle: /./ });
    const recorder = await Recorder.start(session, { app: which, pollMs: 20, startedAt: '2026-10-23T09:00:00.000Z', tool: 'sas-desktop-record 1 (stand-in desktop)' });
    const actions = which === 'smc' ? smcCreateUser(account, fake.smc.options.profiles[0] as string) : egRunProject(account, fake.eg.options.profiles[0] as string, FAKE_PROJECT_PATH);
    await fake.desktop.simulateUserActions(actions, { virtualTime: true });
    const { recording } = await recorder.stop();
    return recording;
  } finally {
    await session.close();
  }
}

const common: ConvertOptions = { testImport: '../recorder/support/desktopTest', desktopImport: '../../src/desktop' };

/** The committed generated tests: which recording, which options, and the files they are written to (under tests/desktop-generated). */
export const GENERATED = [
  { id: 'smc_create_user', recording: 'smc' as const, options: { ...common, expectText: ['AUTO_demo_user'], sourceName: 'examples/smc_create_user.sasrec.json', name: 'smc_create_user' } },
  { id: 'eg_run_project', recording: 'eg' as const, options: { ...common, pageObjects: true, expectText: ['PROCEDURE MEANS'], sourceName: 'examples/eg_run_project.sasrec.json', name: 'eg_run_project' } },
  { id: 'eg_run_project_data', recording: 'eg' as const, options: { ...common, pageObjects: true, data: true, expectText: ['PROCEDURE MEANS'], sourceName: 'examples/eg_run_project.sasrec.json', name: 'eg_run_project_data' } },
];

export function generate(entry: (typeof GENERATED)[number], recording: Recording): ConvertResult {
  return convertRecording(recording, entry.options);
}
