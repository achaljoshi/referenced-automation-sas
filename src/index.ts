export * as core from './core';
export * as process from './process';
export * as desktop from './desktop';
export * as fixtures from './fixtures';
export * as bdd from './bdd';
export * as recorder from './recorder';

// The two things a test file imports most, at the top level: `import { desktopTest, desktopExpect } from '@automation/referenced-automation-sas'`.
export { desktopTest, desktopExpect, TAGS } from './fixtures';
export { registerDesktopSteps } from './bdd';
