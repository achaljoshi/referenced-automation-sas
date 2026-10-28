# EXAMPLE 1 - SAS Management Console: log on, open the User Manager, find a user. Read it top to bottom, then copy the parts you need.
#
#     npm run try:simulator -- 01_
#
# SAS Management Console is a Java Swing program. Its screens are the LAST resort of this framework (a command line or a metadata call is
# faster and does not need a window): use this layer for tests ABOUT the console - is it usable, does the User Manager list who it should -
# and keep those tests few. On a real machine the Java Access Bridge must be enabled (`jabswitch -enable`, then restart the console), and
# the desktop must be unlocked: `npm run doctor` checks both.
#
# The settings the example relies on - every one is explained in .env.example (what it is for, valid values, default, where to find it):
#   SAS_DESKTOP_SIMULATOR   true = run on the built-in stand-in desktop (what `npm run try:simulator` sets; features/steps/fixtures.ts also forces it)
#   SAS_SMC_PATH            the full path of sasmc.exe: with it the fixture LAUNCHES the console (SAS_APP_MODE=launch / auto)
#   SAS_APP_MODE            launch | attach | auto: attach = use a console that is already open and never close it
#   SAS_SMC_PROFILE         the metadata profile chosen in the console's connection dialog, spelled as the dialog lists it
#   SAS_SMC_USER, SAS_SMC_PASSWORD  (or SAS_USER, SAS_PASSWORD)  the login; the password is a secret: .env.<ENV>.local only
#   SAS_LOGON_FAILURE_COOLDOWN_MIN  after a rejected logon the same login is not typed again for this long (protects the account)
#   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  which declared SAS environment this run works against (dev, qa ...) and where they are declared
#   SAS_DESKTOP_TIMEOUT_MS  how long any one step waits for its control (30 s by default)
#   SAS_ASSERT_TIMEOUT_MS   how long an assertion step ("Then the tab ... is shown") keeps re-checking before it fails (5 s by default)
#   SAS_EVIDENCE            what the report gets automatically (a screenshot and the step journal on failure by default)
#
# What this flow looks for - the user, the group, the plug-in, the title - describes the stand-in: change the values in the steps and
# every step that uses them follows. Nothing here sleeps: every step waits for its control, up to SAS_DESKTOP_TIMEOUT_MS.
@sas-desktop @smc-ui @example
Feature: EXAMPLE 1 - SAS Management Console: log on, open the User Manager and find a user
  As a SAS administrator
  I want to see how a Management Console test is written, line by line
  So that I can copy the parts I need for my own

  Scenario: Log on, open the User Manager and find a user
    # "SAS Management Console is open and I am logged on": the fixture launched the console (SAS_SMC_PATH), chose the profile
    # (SAS_SMC_PROFILE), typed the login (SAS_SMC_USER / SAS_SMC_PASSWORD, else SAS_USER / SAS_PASSWORD) through the logon guard and
    # waited for the navigation tree. An assertion step retries until it holds.
    Given SAS Management Console is open and I am logged on
    Then the window title matches the pattern "SAS Management Console"
    And the navigation tree is shown
    # Opening a plug-in selects it in the navigation tree (expanding the node it sits under) and waits until it is selected.
    When I open the "User Manager" plug-in
    # Reading the User Manager's list is best effort and NOT VERIFIED on the real console; where a metadata call or a batch tool
    # (src/process) can answer "does this user exist?", prefer it.
    Then the User Manager lists the user "sasdemo" spelled exactly like that
    And the user "Nobody Atall" is not listed
    And the User Manager lists the group "SAS Administrators" spelled exactly like that
    # A control is found the way a person finds it - by role and name - from its window.
    And the tab "Users" is shown
    # A screenshot that goes into the test report (`npx playwright show-report`). SAS_EVIDENCE decides what is taken on its own.
    When I add a screenshot called "user manager" to the report

  Scenario: A control that is not on the screen fails with what IS on the screen
    Given SAS Management Console is open and I am logged on
    When I open the "User Manager" plug-in
    # The control below does not exist on this screen, on purpose. The assertion fails and says what is there - window title, controls with
    # their names and ids, the closest matches - so the test can be repaired without opening SAS.
    Then looking for the control named "Add User" fails and says what is on the screen

  Scenario: Without the logon the console waits at its connection dialog
    # "SAS Management Console is open" launches the console but does NOT log on - what a test about the logon dialogs itself starts from.
    # Nothing was typed, so nothing can have been rejected.
    Given SAS Management Console is open
    Then a window whose title contains "Connection Profile" is open
