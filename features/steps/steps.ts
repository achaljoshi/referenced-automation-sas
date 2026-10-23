import { registerDataSteps } from '@automation/referenced-automation-ui';
import { createBdd } from 'playwright-bdd';
import { registerDesktopSteps } from '../../src/bdd';
import { test } from './fixtures';

// The business-readable SAS desktop vocabulary ("SAS Management Console is open and I am logged on", "I open the ... plug-in", "the
// program ... finished without errors") lives in the package (src/bdd/steps.ts) and is shared by every project; so are the data steps
// ("I generate a random email called ...", "the date 7 days from today ..."). Add this project's own steps below, with the same
// Given/When/Then.
const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });
registerDesktopSteps({ Given, When, Then });
