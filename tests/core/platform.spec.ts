import { expect, test } from '@playwright/test';
import { describePlatform, formatPlatform } from '../../src/desktop';

const capability = (platform: NodeJS.Platform, id: string, facts: { transport?: string; simulated?: boolean } = {}) =>
  describePlatform({ platform, ...facts }).capabilities.find((c) => c.id === id);

test.describe('what works on which operating system', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    test(`${platform}: the core, the command-line driver, the converters and the stand-in are available`, () => {
      for (const id of ['core', 'process', 'converters', 'simulator']) expect(capability(platform, id)?.available, id).toBe(true);
    });
  }

  test('the real desktop is available on Windows, and elsewhere only through a remote host or as the stand-in', () => {
    expect(capability('win32', 'desktop')?.available).toBe(true);
    for (const platform of ['darwin', 'linux'] as const) {
      expect(capability(platform, 'desktop')?.available).toBe(false);
      expect(capability(platform, 'desktop', { transport: 'remote' })?.available).toBe(true);
      expect(capability(platform, 'desktop', { simulated: true })?.available).toBe(true);
    }
  });

  test('the text says what to do instead, and that Windows tools are .exe and shells are never used', () => {
    expect(capability('linux', 'desktop')?.detail).toMatch(/SAS_DESKTOP_TRANSPORT=remote.*SAS_DESKTOP_SIMULATOR=true|SAS_DESKTOP_SIMULATOR=true.*remote/s);
    expect(capability('win32', 'process')?.detail).toContain('.exe');
    expect(capability('win32', 'process')?.detail).toContain('a .bat or .cmd file is refused');
    expect(capability('darwin', 'process')?.detail).not.toContain('.exe');
    expect(capability('darwin', 'desktop', { simulated: true })?.detail).toContain('The real programs need Windows');
  });

  test('formatPlatform names the system and marks what is missing', () => {
    const text = formatPlatform(describePlatform({ platform: 'darwin' }));
    expect(text).toContain('Operating system: macOS');
    expect(text).toMatch(/NO\s+real Management Console/);
    expect(text).toMatch(/yes\s+policy gate/);
  });

  test('an unknown system is named as it is reported', () => {
    expect(describePlatform({ platform: 'freebsd' }).name).toBe('freebsd');
  });
});
