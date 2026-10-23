import { expect, test } from '@playwright/test';
import { ComClassRefusedError, ComClient, ComObject, FakeComError, startFakeDesktop, type GuardedOperation, type GuardedResult, type OperationGuard } from '../../src/desktop';

// The COM route, against the stand-in's fake COM runtime (the PowerShell bridge's com.* operations are NOT VERIFIED on Windows).

function recordingGuard(deny?: (op: GuardedOperation) => boolean): OperationGuard & { asked: GuardedOperation[]; results: GuardedResult[] } {
  const asked: GuardedOperation[] = [];
  const results: GuardedResult[] = [];
  return {
    asked,
    results,
    authorize(op) {
      asked.push(op);
      if (deny?.(op)) throw new Error(`policy: ${op.operation} refused`);
    },
    record: (r) => void results.push(r),
  };
}

test.describe('COM client', () => {
  test('creates an allow-listed class, reads, writes and calls members case-insensitively; results that are objects come back as handles', async () => {
    const fake = startFakeDesktop();
    const sample = { Name: 'root', Count: 2, child: { Label: 'kid', Items: [1, 'two', true, null] }, Add: (a: number, b: number) => a + b, Echo: (o: { Label: string }) => o.Label };
    fake.desktop.com.register('SASObjectManager.Sample', () => sample);
    const com = new ComClient(fake.session());
    const root = await com.create('SASObjectManager.Sample');
    expect(await root.get('name')).toBe('root'); // COM member names are case-insensitive
    expect(await root.call('Add', [2, 3])).toBe(5);
    const child = (await root.get('Child')) as ComObject;
    expect(child).toBeInstanceOf(ComObject);
    expect(await child.get('Label')).toBe('kid');
    expect(await root.get('Child.Items')).toEqual([1, 'two', true, null]); // arrays and null survive
    expect(await root.call('Echo', [child])).toBe('kid'); // a COM object passes back in as an argument
    await root.set('Name', 'renamed');
    expect(sample.Name).toBe('renamed');
    await root.set('Child.Label', 'changed'); // dotted path: the last segment is written
    expect(sample.child.Label).toBe('changed');
  });

  test('an unknown member, a missing path and an unknown handle are errors with a message, not a crash', async () => {
    const fake = startFakeDesktop();
    fake.desktop.com.register('SASObjectManager.Sample', () => ({ Name: 'x', Fail: () => { throw new FakeComError('the server is gone', 'SESSION_LOST'); }, Boom: () => { throw new Error('boom'); } }));
    const com = new ComClient(fake.session());
    const o = await com.create('SASObjectManager.Sample');
    await expect(o.get('NoSuchMember')).rejects.toThrow(/Unknown name/);
    await expect(o.get('Name.Deeper')).rejects.toThrow(/returned nothing|does not lead/);
    await expect(o.call('Boom')).rejects.toThrow(/boom/);
    await expect(o.call('Fail')).rejects.toMatchObject({ cause: { code: 'SESSION_LOST' } });
    await o.release();
    await expect(o.get('Name')).rejects.toThrow(/unknown COM object handle/);
  });

  test('allow-list: a class outside it is refused before anything is sent, and creating nothing leaves no handle behind', async () => {
    const fake = startFakeDesktop();
    fake.desktop.com.register('WScript.Shell', () => ({ Run: () => 0 }));
    const com = new ComClient(fake.session());
    for (const bad of ['WScript.Shell', 'Excel.Application', 'SASEGObjectModel', 'SASObjectManager', 'SASObjectManager.X;calc', '{00000000-0000-0000-0000-000000000000}', '..\\evil']) {
      await expect(com.create(bad), bad).rejects.toBeInstanceOf(ComClassRefusedError);
    }
    expect(fake.desktop.calls.filter((c) => c.op === 'com.create')).toHaveLength(0); // never reached the bridge
    expect(fake.desktop.com.openHandles).toBe(0);
  });

  test('allow-list: the bridge refuses on its own even when the TypeScript side was widened (defence in depth)', async () => {
    const fake = startFakeDesktop(); // the bridge's allow-list stays the default
    fake.desktop.com.register('WScript.Shell', () => ({ Run: () => 0 }));
    const widened = new ComClient(fake.session(), { allowProgIds: ['WScript.*'] });
    const error = await widened.create('WScript.Shell').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComClassRefusedError);
    expect(fake.desktop.com.refused).toEqual(['WScript.Shell']); // the bridge itself said no
    expect(fake.desktop.com.created).toEqual([]);
  });

  test('allow-list: patterns are case-insensitive whole-name wildcards, configurable, and the bridge is told them', async () => {
    const fake = startFakeDesktop({ allowProgIds: ['MyVendor.Thing.*'] });
    fake.desktop.com.register('myvendor.thing.2', () => ({ Ok: true }));
    fake.desktop.com.register('SASObjectManager.ObjectFactoryMulti2', () => ({}));
    const com = new ComClient(fake.session(), { allowProgIds: ['MyVendor.Thing.*'] });
    expect(com.isAllowed('MYVENDOR.THING.7')).toBe(true);
    expect(com.isAllowed('MyVendor.Thing')).toBe(false);
    expect(com.isAllowed('XMyVendor.Thing.1')).toBe(false);
    await expect(com.create('SASObjectManager.ObjectFactoryMulti2')).rejects.toBeInstanceOf(ComClassRefusedError); // the default is replaced, not extended
    expect(await (await com.create('myvendor.thing.2')).get('Ok')).toBe(true);
  });

  test('an allowed class that is not registered says so (and mentions the 32-bit PowerShell)', async () => {
    const fake = startFakeDesktop();
    const error = (await new ComClient(fake.session()).create('SASEGObjectModel.Application.9.9').catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/not registered/);
    expect(error.message).toMatch(/32-bit/);
  });

  test('list shows only registered classes the allow-list lets through, optionally by prefix', async () => {
    const fake = startFakeDesktop();
    fake.desktop.com.register('SASEGObjectModel.Application.7.1', () => ({}));
    fake.desktop.com.register('SASEGObjectModel.Application.8.3', () => ({}));
    fake.desktop.com.register('WScript.Shell', () => ({}));
    const com = new ComClient(fake.session());
    expect(await com.list()).toEqual(['SASEGObjectModel.Application.7.1', 'SASEGObjectModel.Application.8.3']);
    expect(await com.list('SASEGObjectModel.Application.8')).toEqual(['SASEGObjectModel.Application.8.3']);
    await expect(com.list('..\\x')).rejects.toThrow(/prefix/);
  });

  test('handles are released one by one and all at once; the bridge keeps no object after releaseAll', async () => {
    const fake = startFakeDesktop();
    fake.desktop.com.register('SASObjectManager.Sample', () => ({ Kid: { A: 1 }, Kids: [{ B: 1 }, { B: 2 }] }));
    const com = new ComClient(fake.session());
    const o = await com.create('SASObjectManager.Sample');
    await o.get('Kid');
    await o.get('Kids');
    expect(fake.desktop.com.openHandles).toBe(4); // the object, one child, two array elements
    await o.release();
    expect(fake.desktop.com.openHandles).toBe(3);
    await com.releaseAll();
    expect(fake.desktop.com.openHandles).toBe(0);
  });

  test('a secret argument is flagged for the bridge and still delivered to the method', async () => {
    const fake = startFakeDesktop();
    let received = '';
    fake.desktop.com.register('SASObjectManager.Sample', () => ({ Connect: (_user: string, password: string) => { received = password; return true; } }));
    const com = new ComClient(fake.session());
    const o = await com.create('SASObjectManager.Sample');
    await o.call('Connect', ['sasdemo', 'Sup3rS3cret!'], { secret: true });
    expect(received).toBe('Sup3rS3cret!');
    const sent = fake.desktop.calls.find((c) => c.op === 'com.call');
    expect(sent).toMatchObject({ secret: true });
  });

  test('guard: reads are classified read, set and call update unless the caller says read; a refusal stops the call and is recorded as denied', async () => {
    const fake = startFakeDesktop();
    const calls: string[] = [];
    fake.desktop.com.register('SASObjectManager.Sample', () => ({ Name: 'x', Do: () => { calls.push('Do'); return 1; }, Peek: () => 2 }));
    const guard = recordingGuard((op) => op.operation === 'com.call' && op.kind === 'update');
    const com = new ComClient(fake.session({ guard }));
    const o = await com.create('SASObjectManager.Sample');
    await o.get('Name');
    await o.call('Peek', [], { kind: 'read' });
    await expect(o.call('Do')).rejects.toThrow(/policy: com.call refused/);
    expect(calls).toEqual([]); // the method was never called
    expect(guard.asked.map((a) => `${a.operation}:${a.kind}`)).toEqual(['com.create:read', 'com.get:read', 'com.call:read', 'com.call:update']);
    expect(guard.asked.every((a) => a.driver === 'desktop-com')).toBe(true);
    expect(guard.results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok', 'denied']);
  });
});
