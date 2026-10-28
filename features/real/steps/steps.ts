import { registerDataSteps } from '@automation/referenced-automation-ui';
import { createBdd } from 'playwright-bdd';
import { registerDesktopSteps } from '../../../src/bdd';
import { registerRealSteps } from '../../support/realSteps';
import { registerSasSteps } from '../../support/sasSteps';
import { test } from './fixtures';

const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });
registerDesktopSteps({ Given, When, Then });
registerSasSteps({ Given, When, Then });
registerRealSteps({ Given, When, Then });
