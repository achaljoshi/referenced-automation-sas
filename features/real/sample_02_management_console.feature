# SAMPLE 2 - SAS MANAGEMENT CONSOLE (screens): log on, open a plug-in, read what it lists. READ-ONLY: nothing is created or changed.
#
#     npm run test:real-samples
#
# Screens are the LAST resort of this repo - use them for tests ABOUT the console. On the real machine the desktop must be unlocked and the
# Java Access Bridge enabled (`npm run doctor` checks both). Settings - each one is explained in .env.example:
#   SAS_SMC_PATH, SAS_SMC_PROFILE   which program to start and which connection profile to choose in its dialog
#   SAS_SMC_USER, SAS_SMC_PASSWORD  (or SAS_USER, SAS_PASSWORD, in .env.<ENV>.local) the login; a rejected one is typed once, never retried
#   SAS_SAMPLE_SMC_USER             optional: a user the User Manager must list, spelled as it lists it (the stand-in has "sasdemo")
@real-sample @sas-desktop @smc-ui
Feature: SAMPLE 2 - SAS Management Console: log on, open the User Manager and read the users
  As a SAS administrator on a machine with SAS
  I want to see the console log on and list its users
  So that I know its screens can be driven here before I build on them

  Scenario: Log on, open the User Manager and read the users
    # Asking for the logon logs the console on, through the logon guard.
    Given SAS Management Console is open and I am logged on
    Then the window title matches the pattern "SAS Management Console"
    # empty to UI Automation = the Java Access Bridge is not enabled (npm run doctor says so)
    And the navigation tree is shown
    When I open the "User Manager" plug-in
    Then the User Manager lists at least one user
    And the User Manager lists the sample user when one is known
