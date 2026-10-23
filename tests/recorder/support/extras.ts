import type { FakeElement, FakeSasDesktop } from '../../../src/desktop';

/**
 * Two things the stock fake programs do not have, added for the examples (test equipment, not part of the framework): a "New User..." button with a
 * "New User Properties" dialog in the fake Management Console (a Swing program: names and class names, no automation ids), and a "Tip of the Day"
 * dialog the fake Enterprise Guide shows at start (a Windows message box, class #32770). They appear when the program creates its main window, so
 * the same extras are there while a recording is made and while the converted test runs.
 */
export function installRecorderExtras(fake: FakeSasDesktop): void {
  const { desktop } = fake;
  const watch = <T extends { main?: FakeElement }>(state: T, enhance: (main: FakeElement) => void) => {
    let current: FakeElement | undefined;
    Object.defineProperty(state, 'main', {
      configurable: true,
      get: () => current,
      set: (value: FakeElement | undefined) => {
        current = value;
        if (value) enhance(value);
      },
    });
  };

  watch(fake.smc, (main) => {
    desktop.attach(main, {
      controlType: 'Button',
      name: 'New User...',
      className: 'JButton',
      on: {
        invoke: () => {
          const process_ = fake.smc.process;
          if (!process_) return;
          const dialog: FakeElement = desktop.addWindow(process_, {
            title: 'New User Properties',
            className: 'SunAwtDialog',
            children: [
              { controlType: 'Edit', name: 'Name:', className: 'JTextField', value: '' },
              { controlType: 'Edit', name: 'Display Name:', className: 'JTextField', value: '' },
              {
                controlType: 'Button',
                name: 'OK',
                className: 'JButton',
                on: {
                  invoke: () => {
                    const name = dialog.find((e) => e.name === 'Name:')?.value ?? '';
                    if (name === '') return;
                    fake.smc.options.users.push(name);
                    const table = main.find((e) => e.controlType === 'Table');
                    if (table) desktop.attach(table, { controlType: 'DataItem', name });
                    desktop.dispose(dialog);
                  },
                },
              },
              { controlType: 'Button', name: 'Cancel', className: 'JButton', on: { invoke: () => desktop.dispose(dialog) } },
            ],
          });
        },
      },
    });
  });

  watch(fake.eg, () => {
    const process_ = fake.eg.process;
    if (!process_) return;
    const tip: FakeElement = desktop.addWindow(process_, {
      title: 'Tip of the Day',
      className: '#32770',
      children: [
        { controlType: 'Text', name: 'Did you know you can run a whole project with one click?' },
        { controlType: 'Button', name: 'Close', on: { invoke: () => desktop.dispose(tip) } },
      ],
    });
  });
}
