import { registerDataSteps } from '@automation/referenced-automation-ui';
import { createBdd } from 'playwright-bdd';
import { registerDesktopSteps } from '../../../src/bdd';
import { registerSasSteps } from '../../support/sasSteps';
import { test } from './fixtures';

const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });
registerDesktopSteps({ Given, When, Then });
registerSasSteps({ Given, When, Then });
