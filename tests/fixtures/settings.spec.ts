import { expect, test } from '@playwright/test';
import { ConfigurationError } from '../../src/core';
import { canRunDesktop, overlay, resolveSettings } from '../../src/fixtures';
import { RUN_ID, reader, settingsFor, useCleanSasEnv } from './support';

useCleanSasEnv();

// What the fixtures decide from the configuration, once per worker: a mistake stops the worker with one message naming the setting.

test.describe('resolveSettings', () => {
  test('the stand-in desktop runs as the declared "simulator" environment, with its own programs, profiles and login - whatever is configured for the real ones', () => {
    expect(settingsFor({ SAS_DESKTOP_SIMULATOR: 'true' }).environmentName).toBe('simulator');
    expect(settingsFor({}, { simulator: true }).environmentName).toBe('simulator');
    const real = {
      SAS_ENVIRONMENT: 'prod-sim',
      SAS_SMC_PATH: 'C:\\Real\\sasmc.exe',
      SAS_SMC_PROFILE: 'Prod Metadata Server',
      SAS_EG_PATH: 'C:\\Real\\SEGuide.exe',
      SAS_EG_PROFILE: 'Prod SAS Server',
      SAS_EG_PROGID: 'SASEGObjectModel.Application.9.9',
    };
    const ignored = settingsFor({ SAS_DESKTOP_SIMULATOR: 'true', ...real });
    expect(ignored.environmentName).toBe('simulator');
    expect(ignored.desktop).toMatchObject({ smcPath: undefined, smcProfile: undefined, egPath: undefined, egProfile: undefined, egProgId: undefined });
    // only a test, on purpose (the sasSettings option), can choose differently
    const chosen = settingsFor({ SAS_DESKTOP_SIMULATOR: 'true' }, { overrides: { SAS_ENVIRONMENT: 'prod-sim', SAS_SMC_PROFILE: 'QA Metadata Server' } });
    expect(chosen.environmentName).toBe('prod-sim');
    expect(chosen.desktop.smcProfile).toBe('QA Metadata Server');
    expect(chosen.desktop.egProfile).toBeUndefined();
    expect([...chosen.explicit].sort()).toEqual(['SAS_ENVIRONMENT', 'SAS_SMC_PROFILE']);
    // negative control: without the stand-in the configured values are used as they are
    expect(settingsFor(real).desktop).toMatchObject({ smcPath: 'C:\\Real\\sasmc.exe', smcProfile: 'Prod Metadata Server', egProgId: 'SASEGObjectModel.Application.9.9' });
    expect(settingsFor(real).environmentName).toBe('prod-sim');
  });

  test('the desktopSimulator option wins over SAS_DESKTOP_SIMULATOR in both directions', () => {
    expect(settingsFor({ SAS_DESKTOP_SIMULATOR: 'false' }, { simulator: true }).simulated).toBe(true);
    expect(settingsFor({ SAS_DESKTOP_SIMULATOR: 'true' }, { simulator: false }).simulated).toBe(false);
    expect(settingsFor({ SAS_DESKTOP_SIMULATOR: 'true' }).desktop.simulator).toBe(true);
    expect(settingsFor({}).simulated).toBe(false);
  });

  test('sasSettings overrides win over the configuration and never touch the process environment', () => {
    const settings = settingsFor({ SAS_EVIDENCE: 'off' }, { overrides: { SAS_EVIDENCE: 'on', SAS_CLEANUP_FAILURE: 'warn' } });
    expect(settings.evidence).toBe('on');
    expect(settings.cleanupFailure).toBe('warn');
    expect(process.env.SAS_EVIDENCE).toBeUndefined();
    expect(overlay(reader({ SAS_STATE_DIR: 'a' }), { SAS_STATE_DIR: 'b' }).get('SAS_STATE_DIR')).toBe('b');
    expect(overlay(reader({ SAS_STATE_DIR: 'a' }), { SAS_OTHER: 'x' }).get('SAS_STATE_DIR')).toBe('a');
  });

  test('SAS_PREFLIGHT defaults to on, takes true/false, and a misspelling is an error that names the setting', () => {
    expect(settingsFor().preflight).toBe(true);
    expect(settingsFor({ SAS_PREFLIGHT: 'false' }).preflight).toBe(false);
    expect(() => settingsFor({ SAS_PREFLIGHT: 'ture' })).toThrow(/SAS_PREFLIGHT/);
  });

  test('SAS_CLEANUP_FAILURE is fail by default, warn on request, and nothing else', () => {
    expect(settingsFor().cleanupFailure).toBe('fail');
    expect(settingsFor({ SAS_CLEANUP_FAILURE: 'WARN' }).cleanupFailure).toBe('warn');
    expect(() => settingsFor({ SAS_CLEANUP_FAILURE: 'ignore' })).toThrow(/SAS_CLEANUP_FAILURE must be one of "fail", "warn"/);
  });

  test('SAS_APP_MODE: auto by default; the stand-in always launches but a misspelt value is still rejected', () => {
    expect(settingsFor().appMode).toBe('auto');
    expect(settingsFor({ SAS_APP_MODE: 'attach' }).appMode).toBe('attach');
    expect(settingsFor({ SAS_APP_MODE: 'attach' }, { simulator: true }).appMode).toBe('launch');
    expect(() => settingsFor({ SAS_APP_MODE: 'open' }, { simulator: true })).toThrow(/SAS_APP_MODE/);
  });

  test('SAS_EVIDENCE: steps is failure plus a screenshot after every step; off wins over SAS_DESKTOP_EVIDENCE=steps; the default is failure', () => {
    expect(settingsFor()).toMatchObject({ evidence: 'failure', evidenceSteps: false });
    expect(settingsFor({ SAS_EVIDENCE: 'steps' })).toMatchObject({ evidence: 'failure', evidenceSteps: true });
    expect(settingsFor({ SAS_EVIDENCE: 'on' })).toMatchObject({ evidence: 'on', evidenceSteps: false });
    expect(settingsFor({ SAS_DESKTOP_EVIDENCE: 'steps' })).toMatchObject({ evidence: 'failure', evidenceSteps: true });
    expect(settingsFor({ SAS_EVIDENCE: 'off', SAS_DESKTOP_EVIDENCE: 'steps' })).toMatchObject({ evidence: 'off', evidenceSteps: false });
    expect(() => settingsFor({ SAS_EVIDENCE: 'always' })).toThrow(ConfigurationError);
    // the run context the fixtures use understands what the settings say, including `steps`
    expect(settingsFor({ SAS_EVIDENCE: 'steps' }).run.shouldCaptureEvidence(true)).toBe(true);
    expect(settingsFor({ SAS_EVIDENCE: 'steps' }).run.shouldCaptureEvidence(false)).toBe(false);
    expect(settingsFor({ SAS_EVIDENCE: 'on' }).run.shouldCaptureEvidence(false)).toBe(true);
    expect(settingsFor({ SAS_EVIDENCE: 'off' }).run.shouldCaptureEvidence(true)).toBe(false);
  });

  test('the run is the given run id with its own namespace', () => {
    const settings = settingsFor();
    expect(settings.run.runId).toBe(RUN_ID);
    expect(settings.run.namespacePrefix).toBe(`AUTO_${RUN_ID}`);
    expect(resolveSettings({ env: reader({ SAS_NAMESPACE_PATTERN: 'TST_{runId}' }), runId: RUN_ID }).run.ns('x')).toBe(`TST_${RUN_ID}_x`);
  });

  test('a desktop setting that is wrong is reported by the desktop layer with the setting name', () => {
    expect(() => settingsFor({ SAS_DESKTOP_TRANSPORT: 'telepathy' })).toThrow(/SAS_DESKTOP_TRANSPORT/);
    expect(() => settingsFor({ SAS_DESKTOP_TIMEOUT_MS: '0' })).toThrow(/SAS_DESKTOP_TIMEOUT_MS/);
  });
});

test.describe('canRunDesktop', () => {
  const real = { simulated: false, desktop: { transport: 'powershell' } } as never;

  test('Windows can; the stand-in can anywhere; a remote desktop host can from anywhere', () => {
    expect(canRunDesktop(real, 'win32')).toEqual({ ok: true });
    expect(canRunDesktop({ simulated: true, desktop: { transport: 'powershell' } } as never, 'linux')).toEqual({ ok: true });
    expect(canRunDesktop({ simulated: false, desktop: { transport: 'remote' } } as never, 'darwin')).toEqual({ ok: true });
  });

  test('anywhere else the answer is no, with the three ways to go on', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const answer = canRunDesktop(real, platform);
      expect(answer.ok).toBe(false);
      if (!answer.ok) for (const hint of ['Windows', 'SAS_DESKTOP_TRANSPORT=remote', 'SAS_DESKTOP_SIMULATOR=true', 'skipped, not run']) expect(answer.reason).toContain(hint);
    }
  });
});
