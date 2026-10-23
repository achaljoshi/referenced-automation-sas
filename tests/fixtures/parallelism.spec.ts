import { expect, test } from '@playwright/test';
import { BridgeTamperedError, assertBridgeVerified } from '../../src/desktop';
import { assertSingleWorker, desktopWorkerPlan, realDesktopReachable, verifyBridgeForRun } from '../../src/fixtures';
import { reader, useCleanSasEnv } from './support';

useCleanSasEnv();

// One desktop = one worker (the config sets it, the fixtures refuse anything else for a real desktop), and the bridge script is checked before it is started.

test.describe('realDesktopReachable', () => {
  test('Windows with no stand-in: yes. The stand-in: no, anywhere. A remote desktop host: yes, from anywhere. Linux or macOS alone: no', () => {
    expect(realDesktopReachable(reader({}), 'win32')).toBe(true);
    expect(realDesktopReachable(reader({ SAS_DESKTOP_SIMULATOR: 'true' }), 'win32')).toBe(false);
    expect(realDesktopReachable(reader({ SAS_DESKTOP_TRANSPORT: 'remote' }), 'darwin')).toBe(true);
    expect(realDesktopReachable(reader({ SAS_DESKTOP_TRANSPORT: 'remote', SAS_DESKTOP_SIMULATOR: 'true' }), 'darwin')).toBe(false);
    expect(realDesktopReachable(reader({}), 'linux')).toBe(false);
    expect(realDesktopReachable(reader({}), 'darwin')).toBe(false);
  });
});

test.describe('desktopWorkerPlan (what playwright.config.ts does)', () => {
  test('a reachable real desktop gets one worker; WORKERS=4 is ignored with a message that says why', () => {
    expect(desktopWorkerPlan(reader({}), 'win32')).toEqual({ oneWorker: true });
    expect(desktopWorkerPlan(reader({ WORKERS: '1' }), 'win32')).toEqual({ oneWorker: true });
    const plan = desktopWorkerPlan(reader({ WORKERS: '4' }), 'win32');
    expect(plan.oneWorker).toBe(true);
    expect(plan.ignored).toContain('WORKERS=4 ignored');
    expect(plan.ignored).toContain('SAS_DESKTOP_SIMULATOR=true');
  });

  test('the stand-in, or a machine that cannot reach a real desktop, keeps the parallelism it was given', () => {
    expect(desktopWorkerPlan(reader({ SAS_DESKTOP_SIMULATOR: 'true', WORKERS: '4' }), 'win32')).toEqual({ oneWorker: false });
    expect(desktopWorkerPlan(reader({ WORKERS: '4' }), 'linux')).toEqual({ oneWorker: false });
  });
});

test.describe('assertSingleWorker (what the desktopHost fixture does)', () => {
  test('a real desktop with more than one worker is refused, naming the way out', () => {
    expect(() => assertSingleWorker({ simulated: false, workers: 4 })).toThrow(/4 workers with a real SAS desktop[\s\S]*--workers=1[\s\S]*SAS_DESKTOP_SIMULATOR=true/);
    expect(() => assertSingleWorker({ simulated: false, workers: 2, transport: 'remote' })).toThrow(/remote desktop/);
  });

  test('one worker is fine, and so is any number with the stand-in (every worker starts its own)', () => {
    expect(() => assertSingleWorker({ simulated: false, workers: 1 })).not.toThrow();
    expect(() => assertSingleWorker({ simulated: true, workers: 8 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------- the bridge hash

test.describe('verifyBridgeForRun (what the desktopHost fixture does before a transport is opened)', () => {
  const real = { simulated: false, desktop: { transport: 'powershell' } } as never;

  test('the shipped script is checked against the pinned hash for the PowerShell and the remote transports - and passes', () => {
    expect(verifyBridgeForRun(real)).toMatchObject({ checked: true });
    expect(verifyBridgeForRun({ simulated: false, desktop: { transport: 'remote' } } as never)).toMatchObject({ checked: true });
    expect(assertBridgeVerified().ok).toBe(true);
  });

  test('a script that is not the shipped one stops the run with BridgeTamperedError (negative control of the line above)', () => {
    const tampered = () => assertBridgeVerified(undefined, '0'.repeat(64));
    expect(() => verifyBridgeForRun(real, tampered)).toThrow(BridgeTamperedError);
    expect(() => verifyBridgeForRun(real, tampered)).toThrow(/not the bridge script this version of the framework ships/);
  });

  test('it is not checked where the shipped script is not what runs: the stand-in, or an approved copy on the remote host', () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return assertBridgeVerified();
    };
    expect(verifyBridgeForRun({ simulated: true, desktop: { transport: 'powershell' } } as never, counting).checked).toBe(false);
    expect(verifyBridgeForRun({ simulated: false, desktop: { transport: 'remote', remoteBridgeFile: 'C:\\approved\\sas-desktop-bridge.ps1' } } as never, counting).checked).toBe(false);
    expect(calls).toBe(0);
  });
});
