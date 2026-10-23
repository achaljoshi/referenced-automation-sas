import { FakeDesktop, DesktopSession, type DesktopApp, type DesktopSessionOptions, type FakeElement, type FakeProcess, type NodeInit } from '../../src/desktop';

/** A small desktop with one program ("demo.exe") whose window `build` fills in: the tool for locator, waiting and assertion tests. */
export interface Demo {
  desktop: FakeDesktop;
  session: DesktopSession;
  app: DesktopApp;
  process: FakeProcess;
  window: FakeElement;
  /** What the handlers recorded, in order. */
  log: string[];
}

export const DEMO_PATH = 'C:\\demo\\demo.exe';

export async function startDemo(build: (window: FakeElement, demo: Pick<Demo, 'desktop' | 'process' | 'log'>) => void, options: { session?: DesktopSessionOptions; title?: string } = {}): Promise<Demo> {
  const desktop = new FakeDesktop();
  const log: string[] = [];
  let window!: FakeElement;
  let process!: FakeProcess;
  desktop.registerProgram(DEMO_PATH, {
    process: 'demo',
    onLaunch: (d, p) => {
      process = p;
      window = d.addWindow(p, { title: options.title ?? 'Demo window', className: 'DemoWnd' });
      build(window, { desktop: d, process: p, log });
    },
  });
  const session = new DesktopSession(desktop, { timeoutMs: 2_000, pollMs: 10, ...options.session });
  const app = await session.launch({ path: DEMO_PATH, windowTitle: /./ });
  return { desktop, session, app, process, window, log };
}

/** A button that records its name when invoked. */
export const button = (name: string, log: string[], extra: Partial<NodeInit> = {}): NodeInit => ({
  controlType: 'Button',
  name,
  on: { invoke: () => void log.push(`invoked ${extra.automationId ?? name}`) },
  ...extra,
});
