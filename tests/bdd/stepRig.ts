import { placeholders } from '@automation/referenced-automation-utils';
import { registerDataSteps } from '@automation/referenced-automation-ui';
import { LogonGuard } from '../../src/core';
import { SasEnterpriseGuide, SasEnterpriseGuideUi, SasManagementConsole, startFakeDesktop, FAKE_EG_PATH, FAKE_SMC_PATH, clearRejectedLogons, type FakeSasDesktopOptions } from '../../src/desktop';
import { registerDesktopSteps, type DesktopStepFixtures } from '../../src/bdd';
import { registerRealSteps } from '../../features/support/realSteps';
import { registerSasSteps } from '../../features/support/sasSteps';
import { CredentialSource, DesktopScenario, LogonHelper, registerSampleProject, sampleProgramName, sampleProjectPath } from '../../src/fixtures';
import { reader, settingsFor, tempDir } from '../fixtures/support';

/** What `registerDesktopSteps` registers: keyword, pattern and implementation. */
export interface RecordedStep {
  keyword: 'Given' | 'When' | 'Then';
  pattern: string;
  implementation: (fixtures: Record<string, unknown>, ...args: unknown[]) => unknown;
}

export function recordSteps(): RecordedStep[] {
  const steps: RecordedStep[] = [];
  const make = (keyword: RecordedStep['keyword']) => (pattern: string | RegExp, implementation: RecordedStep['implementation']) => void steps.push({ keyword, pattern: String(pattern), implementation });
  registerDesktopSteps({ Given: make('Given'), When: make('When'), Then: make('Then') });
  return steps;
}

/** The data steps of the ui package (registered next to ours in features/steps/steps.ts), recorded the same way. */
export function recordDataSteps(): RecordedStep[] {
  const steps: RecordedStep[] = [];
  const make = (keyword: RecordedStep['keyword']) => (pattern: string | RegExp, implementation: RecordedStep['implementation']) => void steps.push({ keyword, pattern: String(pattern), implementation });
  registerDataSteps({ Given: make('Given'), Then: make('Then') });
  return steps;
}

/** This repository's own steps (features/support): the ones every folder of features/ shares, then the ones of features/real only. */
export function recordProjectSteps(): { shared: RecordedStep[]; real: RecordedStep[] } {
  const record = (register: (steps: Parameters<typeof registerSasSteps>[0]) => void): RecordedStep[] => {
    const steps: RecordedStep[] = [];
    const make = (keyword: RecordedStep['keyword']) => (pattern: string | RegExp, implementation: RecordedStep['implementation']) => void steps.push({ keyword, pattern: String(pattern), implementation });
    register({ Given: make('Given'), When: make('When'), Then: make('Then') });
    return steps;
  };
  return { shared: record(registerSasSteps), real: record(registerRealSteps) };
}

/**
 * The steps of the vocabulary wired to the REAL desktop layer on the stand-in, with the fixtures a scenario would have. `step('I open the {string} plug-in', 'User Manager')`
 * runs one step the way playwright-bdd would: the step's own fixture names are taken from this rig.
 */
export function stepRig(options: { desktop?: FakeSasDesktopOptions; values?: Record<string, string> } = {}) {
  clearRejectedLogons();
  const dir = tempDir();
  // assertion steps re-check for SAS_ASSERT_TIMEOUT_MS (5 s by default): short here, so a step that is expected to fail does not make the suite slow
  const values = { SAS_STATE_DIR: dir, SAS_EVIDENCE_DIR: dir, SAS_ASSERT_TIMEOUT_MS: '400', ...options.values };
  const settings = settingsFor(values, { simulator: true });
  const fake = startFakeDesktop(options.desktop);
  const session = fake.session();
  const run = settings.run;
  registerSampleProject(fake, run);
  const guard = new LogonGuard({ env: settings.env });
  const logon = new LogonHelper({ guard, credentials: new CredentialSource(settings.env, fake), environment: settings.environmentName, defaultProfiles: { smc: 'Dev Metadata Server', eg: 'Dev SAS Server' } });
  const scenario = new DesktopScenario();
  const vars = new placeholders.ScenarioVariables(reader(values));
  vars.set('namespace', run.namespacePrefix);
  const steps = recordSteps();
  const lazy: Partial<DesktopStepFixtures> = {};

  const fixtures = (): DesktopStepFixtures =>
    ({
      desktopScenario: scenario,
      logon,
      desktopSettings: settings,
      runContext: run,
      vars,
      get smc() {
        return lazy.smc as SasManagementConsole;
      },
      get eg() {
        return lazy.eg as SasEnterpriseGuideUi;
      },
      get egCom() {
        return lazy.egCom as SasEnterpriseGuide;
      },
      get smcLoggedOn() {
        return (lazy.smc as SasManagementConsole).app;
      },
      get egLoggedOn() {
        return (lazy.eg as SasEnterpriseGuideUi).app;
      },
    }) as DesktopStepFixtures;

  return {
    fake,
    session,
    run,
    settings,
    scenario,
    vars,
    logon,
    guard,
    dir,
    steps,
    project: sampleProjectPath(run),
    program: (name: 'Program' | 'Summary') => sampleProgramName(run, name),
    /** Launch the console (and, with `loggedOn`, log it on) the way the fixtures do. */
    async openSmc(loggedOn = true) {
      lazy.smc = await SasManagementConsole.launch(session, { path: FAKE_SMC_PATH });
      if (loggedOn) await logon.smc(lazy.smc);
      return lazy.smc;
    },
    async openEg(loggedOn = true) {
      lazy.eg = await SasEnterpriseGuideUi.launch(session, { path: FAKE_EG_PATH });
      if (loggedOn) await logon.eg(lazy.eg);
      return lazy.eg;
    },
    async openEgCom() {
      lazy.egCom = await SasEnterpriseGuide.connect(session, {});
      return lazy.egCom;
    },
    /** Runs the step registered under `"<Keyword> <pattern>"` (the way the vocabulary is written) with these arguments. */
    async step(keywordAndPattern: string, ...args: unknown[]): Promise<void> {
      const found = steps.filter((s) => `${s.keyword} ${s.pattern}` === keywordAndPattern);
      if (found.length !== 1) throw new Error(`${found.length} steps are registered as "${keywordAndPattern}"`);
      await (found[0] as RecordedStep).implementation(fixtures() as unknown as Record<string, unknown>, ...args);
    },
  };
}
