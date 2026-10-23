import { test as uiTest } from '@automation/referenced-automation-ui';
import { getLogger, type placeholders } from '@automation/referenced-automation-utils';
import { LogonGuard, SafetyPolicy, loadEnvironments, type RunContext, type SasEnvironment } from '../core';
import {
  FAKE_EG_PATH,
  FAKE_SMC_PATH,
  SasEnterpriseGuide,
  SasEnterpriseGuideUi,
  SasManagementConsole,
  openDesktopSession,
  type DesktopApp,
  type DesktopSession,
  type FakeSasDesktop,
  type OpenedDesktopSession,
} from '../desktop';
import { FixtureCleanup, surfaceCleanupFailures } from './cleanup';
import { CredentialSource } from './credentials';
import { TestEvidence } from './evidence';
import { verifyBridgeForRun } from './bridge';
import { PolicyGuardAdapter } from './guardAdapter';
import { LogonHelper } from './logon';
import { assertSingleWorker } from './parallelism';
import { runDesktopPreflight } from './preflight';
import { registerSampleProject } from './sample';
import { DesktopScenario } from './scenario';
import { publishStandInEnvironment } from './standIn';
import { canRunDesktop, resolveSettings, type FixtureSettings } from './settings';

export { desktopExpect } from '../desktop';
export * from './bridge';
export * from './cleanup';
export * from './credentials';
export * from './evidence';
export * from './guardAdapter';
export * from './logon';
export * from './parallelism';
export * from './preflight';
export * from './sample';
export * from './scenario';
export * from './settings';
export * from './standIn';

const log = getLogger('sas-fixtures');

/** The tag conventions: put them in test titles or `{ tag: [...] }` so a run can select by capability (`--grep @eg-com`). */
export const TAGS = {
  /** Administration of SAS objects (users, groups, libraries ...) by command line or metadata calls - no window. */
  smcAdmin: '@smc-admin',
  /** Tests about Management Console's own screens (UI Automation + the Java Access Bridge). */
  smcUi: '@smc-ui',
  /** Enterprise Guide through its automation object model (COM). */
  egCom: '@eg-com',
  /** Tests about Enterprise Guide's own screens. */
  egUi: '@eg-ui',
  /** The quick, critical journeys: a pre-merge subset. */
  smoke: '@smoke',
  regression: '@regression',
  /** Everything that needs the SAS desktop layer (a Windows desktop, a remote host, or the stand-in). */
  sasDesktop: '@sas-desktop',
} as const;

/** Worker options. */
export interface DesktopOptions {
  /** true = run against the built-in stand-in desktop whatever SAS_DESKTOP_SIMULATOR says; undefined = follow SAS_DESKTOP_SIMULATOR (default false = the real programs). */
  desktopSimulator: boolean | undefined;
  /** Settings laid over the configuration for this project / describe block: `test.use({ sasSettings: { SAS_EVIDENCE: 'on' } })`. They win over files and the environment. */
  sasSettings: Record<string, string> | undefined;
}

export interface DesktopWorkerFixtures extends DesktopOptions {
  /** Every setting the fixtures decide from the configuration, resolved once. */
  desktopSettings: FixtureSettings;
  /** The run: its id (shared by every worker), its test namespace `AUTO_<runId>`, its evidence folder. */
  runContext: RunContext;
  /** The selected SAS environment (kind and host patterns from the environments file). */
  environment: SasEnvironment;
  /** The core safety policy and its audit log. */
  safetyPolicy: SafetyPolicy;
  /** The adapter that plugs the policy into the desktop layer as its OperationGuard. */
  desktopGuard: PolicyGuardAdapter;
  /** Where the logins come from (the configuration, or the stand-in's demo account). */
  sasCredentials: CredentialSource;
  /** The opened desktop session and what belongs to it. */
  desktopHost: OpenedDesktopSession;
  /** The worker's one connection to the desktop (the PowerShell bridge, the remote host or the stand-in), after the pre-flight gate. */
  desktopSession: DesktopSession;
  /** The stand-in desktop itself when it is in use (to look at or configure it in a test); undefined for the real programs. */
  fakeDesktop: FakeSasDesktop | undefined;
}

export interface DesktopTestFixtures {
  /** Skips the test, with the reason, where no desktop can be reached. Automatic. */
  desktopGate: void;
  /** On the stand-in: its own login and profile names as SAS_USER, SAS_PASSWORD, SAS_SMC_PROFILE, SAS_EG_PROFILE for the duration of the test. Automatic. */
  standInEnvironment: void;
  /** What this test creates in SAS, undone after the test (pass or fail). */
  cleanup: FixtureCleanup;
  /** Screenshot + step journal for the report, decided by SAS_EVIDENCE. */
  failureEvidence: TestEvidence;
  logonGuard: LogonGuard;
  /** The logons of both programs, through the logon guard. */
  logon: LogonHelper;
  /** What a Gherkin scenario carries between steps. */
  desktopScenario: DesktopScenario;
  /** SAS Management Console's wrapper: launched (or attached), NOT logged on. */
  smc: SasManagementConsole;
  /** `smc`'s application, NOT logged on. */
  smcApp: DesktopApp;
  /** `smc`'s application after a logon through the logon guard. Ask for it (it logs `smc` on) when the test needs the console's data. */
  smcLoggedOn: DesktopApp;
  /** Enterprise Guide's screens wrapper: launched (or attached), NOT logged on. */
  eg: SasEnterpriseGuideUi;
  egApp: DesktopApp;
  /** `eg`'s application after connecting through the logon guard. */
  egLoggedOn: DesktopApp;
  /** Enterprise Guide through its automation object model (COM), connected: the FIRST route. */
  egCom: SasEnterpriseGuide;
  /** Names this test's values: also `{{runId}}` and `{{namespace}}` (`AUTO_<runId>`). */
  vars: placeholders.ScenarioVariables;
}

async function openSmc(session: DesktopSession, s: FixtureSettings): Promise<SasManagementConsole> {
  const path = s.desktop.smcPath ?? (s.simulated ? FAKE_SMC_PATH : undefined);
  const attach = s.appMode === 'attach' || (s.appMode === 'auto' && path === undefined);
  return attach ? SasManagementConsole.attach(session, { config: s.desktop }) : SasManagementConsole.launch(session, { config: s.desktop, path });
}

async function openEg(session: DesktopSession, s: FixtureSettings): Promise<SasEnterpriseGuideUi> {
  const path = s.desktop.egPath ?? (s.simulated ? FAKE_EG_PATH : undefined);
  const attach = s.appMode === 'attach' || (s.appMode === 'auto' && path === undefined);
  return attach ? SasEnterpriseGuideUi.attach(session, { config: s.desktop }) : SasEnterpriseGuideUi.launch(session, { config: s.desktop, path });
}

/**
 * `test` for the SAS desktop programs: Playwright's `test` (through the `ui` package's, so a test also has the scenario banner, the
 * correlation id and `vars`) plus these fixtures. Nothing opens until a test asks for it.
 *
 * Per WORKER (one desktop = one worker; see parallelism.ts):
 *   desktopSession   the connection to the desktop, after the pre-flight gate (SAS_PREFLIGHT, default on): one clear failure instead of hundreds
 *   environment      the selected SAS environment      runContext   the run id, namespace and evidence folder
 *   fakeDesktop      the stand-in desktop, when SAS_DESKTOP_SIMULATOR=true (or `desktopSimulator: true`): everything runs on any OS
 * Per TEST:
 *   smcApp / egApp                   the program, launched (SAS_SMC_PATH / SAS_EG_PATH) or attached, NOT logged on
 *   smcLoggedOn / egLoggedOn         the same program, logged on through the logon guard with SAS_SMC_* / SAS_EG_* (else SAS_USER / SAS_PASSWORD)
 *   smc / eg                         the wrappers (SasManagementConsole, SasEnterpriseGuideUi) around those programs
 *   egCom                            the Enterprise Guide COM driver
 *   cleanup                          register what the test creates; undone after the test, pass or fail
 *
 * Every step of every driver passes the safety policy (environment kind, test namespace) and is audited. The programs a test
 * started are closed at its end; programs it only attached to are left alone. On failure (SAS_EVIDENCE) the report gets a screenshot
 * and the step journal.
 *
 * Where no desktop can be reached the test is SKIPPED with the reason - never silently passed.
 */
export const desktopTest = uiTest.extend<DesktopTestFixtures, DesktopWorkerFixtures>({
  desktopSimulator: [undefined, { option: true, scope: 'worker' }],
  sasSettings: [undefined, { option: true, scope: 'worker' }],

  desktopSettings: [
    async ({ desktopSimulator, sasSettings }, use) => {
      await use(resolveSettings({ simulator: desktopSimulator, overrides: sasSettings }));
    },
    { scope: 'worker' },
  ],

  runContext: [
    async ({ desktopSettings }, use) => {
      try {
        desktopSettings.run.pruneEvidence(); // bounded retention: other runs' evidence older than SAS_EVIDENCE_RETENTION_DAYS goes
      } catch (error) {
        log.warn(`[sas-fixtures] could not prune old evidence: ${error instanceof Error ? error.message : String(error)}`);
      }
      await use(desktopSettings.run);
    },
    { scope: 'worker' },
  ],

  environment: [
    async ({ desktopSettings }, use) => {
      await use(loadEnvironments(desktopSettings.env).require(desktopSettings.environmentName, 'sas-fixtures', 'environment'));
    },
    { scope: 'worker' },
  ],

  safetyPolicy: [
    async ({ desktopSettings, environment }, use) => {
      void environment; // the environment must exist before anything can be authorised
      await use(new SafetyPolicy({ env: desktopSettings.env, run: desktopSettings.run }));
    },
    { scope: 'worker' },
  ],

  desktopGuard: [
    async ({ safetyPolicy, desktopSettings }, use) => {
      await use(new PolicyGuardAdapter(safetyPolicy, desktopSettings.environmentName));
    },
    { scope: 'worker' },
  ],

  desktopHost: [
    async ({ desktopSettings: s, desktopGuard, runContext }, use, workerInfo) => {
      assertSingleWorker({ simulated: s.simulated, workers: workerInfo.config.workers, transport: s.desktop.transport });
      verifyBridgeForRun(s); // a modified or stale bridge script is refused before anything starts it
      const host = await openDesktopSession({
        config: s.desktop,
        session: {
          guard: desktopGuard,
          evidence: s.evidenceSteps ? 'steps' : 'off',
          evidenceDir: runContext.evidenceDir,
          ...(s.simulated ? { pollMs: 20 } : {}),
        },
      });
      if (host.simulator) registerSampleProject(host.simulator, runContext);
      try {
        await use(host);
      } finally {
        await host.close().catch((error: unknown) => log.warn(`[sas-fixtures] could not close the desktop session: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
    { scope: 'worker' },
  ],

  sasCredentials: [
    async ({ desktopSettings, desktopHost }, use) => {
      await use(new CredentialSource(desktopSettings.env, desktopHost.simulator, desktopSettings.explicit));
    },
    { scope: 'worker' },
  ],

  desktopSession: [
    async ({ desktopHost, desktopSettings, sasCredentials }, use) => {
      await runDesktopPreflight({ settings: desktopSettings, session: desktopHost.session, credentials: sasCredentials, guard: new LogonGuard({ env: desktopSettings.env }) });
      await use(desktopHost.session);
    },
    { scope: 'worker' },
  ],

  fakeDesktop: [
    async ({ desktopHost }, use) => {
      await use(desktopHost.simulator);
    },
    { scope: 'worker' },
  ],

  // ---------------------------------------------------------------------------------------------------- per test

  desktopGate: [
    async ({ desktopSettings }, use, testInfo) => {
      const can = canRunDesktop(desktopSettings);
      testInfo.skip(!can.ok, can.ok ? undefined : can.reason);
      await use();
    },
    { auto: true },
  ],

  standInEnvironment: [
    async ({ desktopSettings: s }, use) => {
      const restore = s.simulated ? publishStandInEnvironment(process.env, s.explicit) : undefined;
      try {
        await use();
      } finally {
        restore?.();
      }
    },
    { auto: true },
  ],

  vars: async ({ vars, runContext }, use) => {
    if (!vars.has('runId')) vars.set('runId', runContext.runId);
    if (!vars.has('namespace')) vars.set('namespace', runContext.namespacePrefix);
    await use(vars);
  },

  cleanup: async ({ desktopSettings: s }, use, testInfo) => {
    const cleanup = new FixtureCleanup({ environment: s.environmentName, driver: 'sas-desktop', run: s.run, env: s.env, testName: testInfo.titlePath.slice(1).join(' > ') });
    await use(cleanup);
    surfaceCleanupFailures(await cleanup.flush(), testInfo, s.cleanupFailure, s.run.runId);
  },

  failureEvidence: async ({ desktopSession, desktopSettings: s }, use, testInfo) => {
    const evidence = new TestEvidence({ session: desktopSession, run: s.run, testInfo });
    await use(evidence);
    await evidence.capture();
  },

  logonGuard: async ({ desktopSettings: s }, use) => {
    await use(new LogonGuard({ env: s.env }));
  },

  logon: async ({ desktopSettings: s, sasCredentials, logonGuard, fakeDesktop }, use) => {
    await use(
      new LogonHelper({
        guard: logonGuard,
        credentials: sasCredentials,
        environment: s.environmentName,
        defaultProfiles: { smc: s.desktop.smcProfile ?? fakeDesktop?.smc.options.profiles[0], eg: s.desktop.egProfile ?? fakeDesktop?.eg.options.profiles[0] },
      }),
    );
  },

  desktopScenario: async ({}, use) => {
    await use(new DesktopScenario());
  },

  smc: async ({ desktopSession, desktopSettings: s, desktopGuard, cleanup, failureEvidence }, use) => {
    const smc = await openSmc(desktopSession, s);
    try {
      await use(smc);
    } finally {
      await failureEvidence.capture(); // before anything is closed: the screen as the failure left it
      try {
        await cleanup.flush(); // an undo may need the program open
      } finally {
        await desktopGuard.housekeeping(() => smc.dispose());
      }
    }
  },

  smcApp: async ({ smc }, use) => {
    await use(smc.app);
  },

  smcLoggedOn: async ({ smc, logon }, use) => {
    await logon.smc(smc);
    await use(smc.app);
  },

  eg: async ({ desktopSession, desktopSettings: s, desktopGuard, cleanup, failureEvidence }, use) => {
    const eg = await openEg(desktopSession, s);
    try {
      await use(eg);
    } finally {
      await failureEvidence.capture();
      try {
        await cleanup.flush();
      } finally {
        await desktopGuard.housekeeping(() => eg.dispose());
      }
    }
  },

  egApp: async ({ eg }, use) => {
    await use(eg.app);
  },

  egLoggedOn: async ({ eg, logon }, use) => {
    await logon.eg(eg);
    await use(eg.app);
  },

  egCom: async ({ desktopSession, desktopSettings: s, cleanup, failureEvidence }, use) => {
    const egCom = await SasEnterpriseGuide.connect(desktopSession, { config: s.desktop });
    try {
      await use(egCom);
    } finally {
      await failureEvidence.capture();
      try {
        await cleanup.flush();
      } finally {
        await egCom.quit();
      }
    }
  },
});
