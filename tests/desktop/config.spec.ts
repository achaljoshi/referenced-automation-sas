import { expect, test } from '@playwright/test';
import { ConfigReader } from '@automation/referenced-automation-utils';
import { DEFAULT_COM_PROGIDS, desktopConfig, FakeDesktop, openDesktopSession, startDesktopTransport } from '../../src/desktop';
import { useCleanSasEnv } from '../core/support';
import { withEnv } from './support';

// A ConfigReader falls back to process.env for a key it does not hold: another spec of the same worker that sets SAS_* variables (the recorder's
// generated tests do, at import) must not change what "the defaults" are. useCleanSasEnv hides them for each test and puts them back.
useCleanSasEnv();

const env = (values: Record<string, string>) => new ConfigReader(values);

test.describe('desktopConfig reads the shared environment', () => {
  test('defaults', () => {
    expect(desktopConfig(env({}))).toEqual({
      transport: 'powershell',
      simulator: false,
      powershell: undefined,
      scriptDir: undefined,
      remoteBridgeFile: undefined,
      timeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      evidence: 'off',
      evidenceDir: 'test-results/sas-desktop-evidence',
      smcPath: undefined,
      smcProfile: undefined,
      egPath: undefined,
      egProfile: undefined,
      egProgId: undefined,
      comProgIds: [...DEFAULT_COM_PROGIDS],
    });
  });

  test('every setting is read from its key', () => {
    const c = desktopConfig(
      env({
        SAS_DESKTOP_TRANSPORT: 'Remote',
        SAS_DESKTOP_SIMULATOR: 'yes',
        SAS_DESKTOP_POWERSHELL: 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
        SAS_DESKTOP_SCRIPT_DIR: 'C:\\approved',
        SAS_DESKTOP_REMOTE_BRIDGE_FILE: 'C:\\r\\b.ps1',
        SAS_DESKTOP_TIMEOUT_MS: '45000',
        SAS_DESKTOP_REQUEST_TIMEOUT_MS: '90000',
        SAS_DESKTOP_EVIDENCE: 'STEPS',
        SAS_DESKTOP_EVIDENCE_DIR: 'out/evidence',
        SAS_SMC_PATH: 'C:\\sasmc.exe',
        SAS_SMC_PROFILE: 'Dev Metadata Server',
        SAS_EG_PATH: 'C:\\SEGuide.exe',
        SAS_EG_PROFILE: 'Dev SAS Server',
        SAS_EG_PROGID: 'SASEGObjectModel.Application.7.1',
        SAS_COM_PROGIDS: 'SASEGObjectModel.Application.*, My.Class',
      }),
    );
    expect(c).toMatchObject({
      transport: 'remote',
      simulator: true,
      powershell: 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
      scriptDir: 'C:\\approved',
      remoteBridgeFile: 'C:\\r\\b.ps1',
      timeoutMs: 45_000,
      requestTimeoutMs: 90_000,
      evidence: 'steps',
      evidenceDir: 'out/evidence',
      smcPath: 'C:\\sasmc.exe',
      smcProfile: 'Dev Metadata Server',
      egPath: 'C:\\SEGuide.exe',
      egProfile: 'Dev SAS Server',
      egProgId: 'SASEGObjectModel.Application.7.1',
      comProgIds: ['SASEGObjectModel.Application.*', 'My.Class'],
    });
  });

  test('empty values are "not set", not an empty setting', () => {
    const c = desktopConfig(env({ SAS_SMC_PATH: '  ', SAS_EG_PROGID: '', SAS_DESKTOP_POWERSHELL: '' }));
    expect(c.smcPath).toBeUndefined();
    expect(c.egProgId).toBeUndefined();
    expect(c.powershell).toBeUndefined();
  });

  test('wrong values are errors that name the key and what is allowed', () => {
    expect(() => desktopConfig(env({ SAS_DESKTOP_TRANSPORT: 'java' }))).toThrow(/SAS_DESKTOP_TRANSPORT must be one of "powershell", "remote" \(found "java"\)/);
    expect(() => desktopConfig(env({ SAS_DESKTOP_EVIDENCE: 'always' }))).toThrow(/SAS_DESKTOP_EVIDENCE must be one of "off", "failure", "steps"/);
    expect(() => desktopConfig(env({ SAS_DESKTOP_TIMEOUT_MS: '0' }))).toThrow(/SAS_DESKTOP_TIMEOUT_MS must be a positive number/);
    expect(() => desktopConfig(env({ SAS_DESKTOP_REQUEST_TIMEOUT_MS: '-5' }))).toThrow(/SAS_DESKTOP_REQUEST_TIMEOUT_MS/);
    expect(() => desktopConfig(env({ SAS_DESKTOP_SIMULATOR: 'ture' }))).toThrow();
    for (const bad of ['Evil;calc', 'a b', '{GUID}', 'x/y', 'c:\\path']) {
      expect(() => desktopConfig(env({ SAS_COM_PROGIDS: bad })), bad).toThrow(/SAS_COM_PROGIDS entry/);
    }
  });

  test('with no reader given it uses the shared loader: a real environment variable wins', async () => {
    const c = await withEnv({ SAS_EG_PROFILE: 'From the process environment', SAS_DESKTOP_TIMEOUT_MS: '1234' }, () => desktopConfig());
    expect(c.egProfile).toBe('From the process environment');
    expect(c.timeoutMs).toBe(1234);
  });
});

test.describe('starting a transport from the configuration', () => {
  test('the simulator is used on any OS, with the configured allow-list', async () => {
    const started = await startDesktopTransport({ ...desktopConfig(env({})), simulator: true, comProgIds: ['Only.This'] });
    expect(started.name).toBe('the built-in simulator');
    expect(started.transport).toBeInstanceOf(FakeDesktop);
    expect(started.simulator?.desktop.com.patterns).toEqual(['Only.This']);
  });

  test('openDesktopSession wraps it in a session with the configured timeout and evidence settings, and closes cleanly', async () => {
    const opened = await openDesktopSession({ config: { ...desktopConfig(env({ SAS_DESKTOP_TIMEOUT_MS: '777', SAS_DESKTOP_EVIDENCE: 'steps' })), simulator: true } });
    expect(opened.session.timeoutMs).toBe(777);
    expect(await opened.session.healthCheck()).toBe(true);
    await opened.close();
    expect(await opened.session.healthCheck()).toBe(false);
  });

  test('powershell on a machine that is not Windows is refused with the alternatives', async () => {
    test.skip(process.platform === 'win32', 'this check is about non-Windows machines');
    await expect(startDesktopTransport(desktopConfig(env({})))).rejects.toThrow(/Windows-only[\s\S]*SAS_DESKTOP_TRANSPORT=remote[\s\S]*SAS_DESKTOP_SIMULATOR=true/);
  });

  test('remote without the remote desktop host configured says which keys to set', async () => {
    await expect(startDesktopTransport(desktopConfig(env({ SAS_DESKTOP_TRANSPORT: 'remote' })), env({}))).rejects.toThrow(/REMOTE_ENABLED=true[\s\S]*REMOTE_ALLOW including "sap"/);
  });
});
