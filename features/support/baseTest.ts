import { mergeTests } from '@playwright/test';
import { test as bddTest } from 'playwright-bdd';
import { desktopTest } from '../../src/fixtures';
import { SasWorld } from './world';

/**
 * The test every Gherkin project of this repository starts from: `desktopTest` (session, environment, safety policy, audit, logon guard,
 * clean-up, evidence ...) with playwright-bdd's own `test` underneath (mergeTests combines them) and the scenario's `world`.
 *
 * Each project (features/steps, features/production, features/real) extends it with the worker options that make its scenarios what
 * they are - the built-in stand-in desktop, a production environment, the real programs. Worker options cannot change inside a
 * project, which is why those scenarios live in separate folders.
 */
export const baseTest = mergeTests(bddTest, desktopTest).extend<{ world: SasWorld }>({
  world: async ({}, use) => {
    await use(new SasWorld());
  },
});
