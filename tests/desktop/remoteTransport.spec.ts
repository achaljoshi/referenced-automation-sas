import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { remote, testing } from '@automation/referenced-automation-utils';
import { assertBridgeVerified, bridgeHash, BRIDGE_SHA256, DesktopTransportError, RemoteTransport, readBridgeScript } from '../../src/desktop';
import { standInBridge, withEnv } from './support';

// RemoteTransport against a fake host object and against the utils package's STAND-IN agent hosting the stand-in bridge.
// NOT VERIFIED on a real RDP host with a real agent.

interface Rig {
  dir: string;
  agent: InstanceType<typeof testing.StandInAgent>;
  host: remote.RemoteHost;
  live(): number;
  done(): Promise<void>;
}

type Hosted = Map<string, { child: { exitCode: number | null; signalCode: string | null } }>;

async function rig(allow: remote.RemoteCapability[] = ['http', 'db', 'sap']): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-remote-'));
  const agent = new testing.StandInAgent({ shareDir: dir, allow });
  await agent.start();
  const host = new remote.RemoteHost(testing.standInRemoteConfig(dir, { allow }));
  await host.connect();
  const procs = () => (agent as unknown as { procs: Hosted }).procs;
  return {
    dir,
    agent,
    host,
    live: () => [...procs().values()].filter((p) => p.child.exitCode === null && p.child.signalCode === null).length,
    done: async () => {
      await host.close().catch(() => undefined);
      await agent.stop().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let r: Rig | undefined;
test.afterEach(async () => {
  await r?.done();
  r = undefined;
});

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as DesktopTransportError);

test.describe('RemoteTransport runs the bridge on the remote desktop host', () => {
  test('sends the VERIFIED shipped script as text (no byte order mark: the agent adds its own) with shell powershell and the allow-list as arguments', async () => {
    const specs: unknown[] = [];
    const sent: string[] = [];
    const host = {
      startProcess: async (spec: unknown) => {
        specs.push(spec);
        return {
          send: async (line: string) => (sent.push(line), line === '' ? '{"rid":0,"ok":true,"value":"ready"}' : '{"rid":1,"ok":true,"value":"pong"}'),
          stop: async () => undefined,
        };
      },
    } as unknown as remote.RemoteHost;
    const t = await RemoteTransport.start({ host, allowProgIds: ['SASEGObjectModel.Application.*', 'SASObjectManager.*'] });
    const spec = specs[0] as { scriptText: string; shell: string; args: string[] };
    expect(spec.shell).toBe('powershell');
    expect(spec.scriptText.charCodeAt(0)).not.toBe(0xfeff);
    expect(bridgeHash(spec.scriptText)).toBe(BRIDGE_SHA256); // exactly the verified script
    expect(spec.scriptText).toBe(readBridgeScript().replace(/^\uFEFF/, ''));
    expect(spec.args).toEqual(['-AllowProgIds', 'SASEGObjectModel.Application.*,SASObjectManager.*']);
    expect(await t.request({ op: 'ping' })).toBe('pong');
    expect(sent).toEqual(['', JSON.stringify({ rid: 1, op: 'ping' })]); // the blank line reads the ready message
    await t.close();
    expect(assertBridgeVerified().ok).toBe(true);
  });

  test('an approved script that already lives on the host is run instead (by path), and no script text is sent', async () => {
    const specs: unknown[] = [];
    const host = {
      startProcess: async (spec: unknown) => {
        specs.push(spec);
        return { send: async () => '{"rid":0,"ok":true,"value":"ready"}', stop: async () => undefined };
      },
    } as unknown as remote.RemoteHost;
    await RemoteTransport.start({ host, bridgeFile: 'C:\\approved\\sas-desktop-bridge.ps1' });
    expect(specs[0]).toEqual({ file: 'C:\\approved\\sas-desktop-bridge.ps1', shell: 'powershell' });
  });

  test('starts, answers requests, and close() stops the remote process but leaves the RemoteHost usable', async () => {
    r = await rig();
    const t = await RemoteTransport.start({ host: r.host, bridgeFile: standInBridge(), requestTimeoutMs: 2000, startupTimeoutMs: 4000 });
    expect(r.live()).toBe(1);
    expect(await t.request({ op: 'ping' })).toMatchObject({ bridge: 'sas-desktop-bridge' });
    await t.close();
    expect(r.live()).toBe(0);
    expect((await r.host.ping()).host).toBeTruthy(); // the host is still open for other steps
    await t.close(); // twice is fine
    expect((await caught(t.request({ op: 'ping' })))?.code).toBe('BRIDGE_EXITED');
  });

  test('the allow-list reaches the remote bridge as an argument: a class outside it is DENIED', async () => {
    r = await rig();
    const t = await RemoteTransport.start({ host: r.host, bridgeFile: standInBridge(), allowProgIds: ['SASEGObjectModel.Application.*'], startupTimeoutMs: 4000 });
    expect((await caught(t.request({ op: 'com.create', progId: 'SASObjectManager.X' })))?.code).toBe('DENIED');
    expect(await t.request({ op: 'com.create', progId: 'SASEGObjectModel.Application.8.3' })).toMatchObject({ handle: expect.any(String) });
    await t.close();
  });

  test('the codes survive: NOT_FOUND, DENIED, SESSION_LOST; null and structured values arrive intact', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_SESSION_LOST_OP: 'windows' }, () => RemoteTransport.start({ host: r!.host, bridgeFile: standInBridge(), startupTimeoutMs: 4000 }));
    expect((await caught(t.request({ op: 'info', ref: 'e99999' })))?.code).toBe('NOT_FOUND');
    expect((await caught(t.request({ op: 'com.create', progId: 'WScript.Shell' })))?.code).toBe('DENIED');
    expect((await caught(t.request({ op: 'windows' })))?.code).toBe('SESSION_LOST');
    expect(await t.request({ op: 'com.release', handle: 'o1' })).toBeNull();
    expect(await t.request({ op: 'ping' })).toBeTruthy(); // none of those stopped the bridge
    await t.close();
  });

  test('concurrent requests get their own replies even when the bridge answers out of order', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_DELAY_OPS: 'ping:300' }, () => RemoteTransport.start({ host: r!.host, bridgeFile: standInBridge(), startupTimeoutMs: 4000 }));
    const [slow, fast, again] = await Promise.all([t.request({ op: 'ping' }), t.request({ op: 'environment' }), t.request({ op: 'ping' })]);
    expect([!!slow, (fast as { uiaAvailable: boolean }).uiaAvailable, !!again]).toEqual([true, true, true]);
    await t.close();
  });

  test('a non-JSON line before the ready message is skipped, not fatal', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_JUNK: '1' }, () => RemoteTransport.start({ host: r!.host, bridgeFile: standInBridge(), startupTimeoutMs: 4000 }));
    expect(await t.request({ op: 'ping' })).toBeTruthy();
    await t.close();
  });

  test('a bridge that never says ready fails the start with TIMEOUT and leaves no process behind', async () => {
    r = await rig();
    const error = await caught(withEnv({ BRIDGE_NO_READY: '1' }, () => RemoteTransport.start({ host: r!.host, bridgeFile: standInBridge(), startupTimeoutMs: 400 })));
    expect(error?.code).toBe('TIMEOUT');
    expect(error?.message).toContain('did not become ready within 400ms');
    expect(r.live()).toBe(0);
  });

  test('a request that gets no reply: TIMEOUT, the remote process is killed, and later requests fail at once', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_HANG_OPS: 'environment' }, () => RemoteTransport.start({ host: r!.host, bridgeFile: standInBridge(), requestTimeoutMs: 400, startupTimeoutMs: 4000 }));
    expect(r.live()).toBe(1);
    const first = await caught(t.request({ op: 'environment' }));
    expect(first?.code).toBe('TIMEOUT');
    expect(first?.message).toContain('no reply to "environment" within 400ms');
    expect(r.live()).toBe(0);
    const startedAt = Date.now();
    const later = await caught(t.request({ op: 'ping' }));
    expect(later?.code).toBe('BRIDGE_EXITED');
    expect(later?.message).toContain('stopped after "environment"');
    expect(Date.now() - startedAt).toBeLessThan(150);
    await t.close();
  });

  test('requests queued behind the one that times out fail at once instead of waiting their own timeout', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_HANG_OPS: 'environment' }, () => RemoteTransport.start({ host: r!.host, bridgeFile: standInBridge(), requestTimeoutMs: 400, startupTimeoutMs: 4000 }));
    const startedAt = Date.now();
    const results = await Promise.all([caught(t.request({ op: 'environment' })), caught(t.request({ op: 'ping' })), caught(t.request({ op: 'ping' }))]);
    expect(results.map((e) => e?.code)).toEqual(['TIMEOUT', 'BRIDGE_EXITED', 'BRIDGE_EXITED']);
    expect(Date.now() - startedAt).toBeLessThan(1500);
    await t.close();
  });

  test('a host whose REMOTE_ALLOW lacks "sap" is refused with the setting to change', async () => {
    r = await rig(['http', 'db']);
    const error = await caught(RemoteTransport.start({ host: r.host, bridgeFile: standInBridge(), startupTimeoutMs: 2000 }));
    expect(error?.message).toMatch(/REMOTE_ALLOW must include "sap"/);
  });

  test('an agent that stopped answering (the RDP session was closed or locked) is SESSION_LOST and the bridge is given up', async () => {
    const host = {
      startProcess: async () => ({
        send: async (line: string) => {
          if (line === '') return '{"rid":0,"ok":true,"value":"ready"}';
          throw new remote.RemoteError('AGENT_STALE', 'the agent has not written its heartbeat for 60 s');
        },
        stop: async () => undefined,
      }),
    } as unknown as remote.RemoteHost;
    const t = await RemoteTransport.start({ host });
    const first = await caught(t.request({ op: 'ping' }));
    expect(first?.code).toBe('SESSION_LOST');
    expect(first?.message).toMatch(/Keep the RDP session connected and unlocked/);
    expect((await caught(t.request({ op: 'ping' })))?.code).toBe('SESSION_LOST'); // fails at once with the same reason
  });
});
