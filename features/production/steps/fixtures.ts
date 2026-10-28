import * as path from 'node:path';
import { baseTest } from '../../support/baseTest';

/**
 * The test of the production features: the stand-in desktop declared as a PRODUCTION environment (`prod-sim`, in
 * tests/fixtures/environments.json) - read-only by construction. Reads need SAS_ALLOW_PROD_READS=true, and even then nothing can change.
 * Worker options cannot change inside a project, so these scenarios have a folder - and a project - of their own.
 */
export const test = baseTest.extend({
  desktopSimulator: [
    async ({}, use) => {
      await use(true);
    },
    { scope: 'worker' },
  ],
  sasSettings: [
    async ({}, use) => {
      await use({
        SAS_STATE_DIR: 'test-results/sas-state-bdd-production',
        SAS_ENVIRONMENTS_FILE: path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'environments.json'),
        SAS_ENVIRONMENT: 'prod-sim',
        SAS_ALLOW_PROD_READS: 'true',
      });
    },
    { scope: 'worker' },
  ],
});
