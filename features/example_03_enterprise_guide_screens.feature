# EXAMPLE 3 - SAS Enterprise Guide's own screens: connect, open a project, run a program, read the results. The SECOND way to drive
# Enterprise Guide (example 2, COM, is the first): use it only for tests ABOUT Enterprise Guide's screens, and keep them few. They
# are slower, break when a screen changes and need an unlocked interactive desktop.
#
#     npm run try:simulator -- 03_
#
# The settings the example relies on - every one is explained in .env.example:
#   SAS_DESKTOP_SIMULATOR   true = the built-in stand-in desktop with a fake Enterprise Guide window (features/steps/fixtures.ts forces it)
#   SAS_EG_PATH             the full path of SEGuide.exe: with it the fixture LAUNCHES Enterprise Guide (SAS_APP_MODE=launch / auto)
#   SAS_APP_MODE            launch | attach | auto
#   SAS_EG_PROFILE          the server profile chosen in the connect dialog, spelled as the dialog lists it
#   SAS_EG_USER, SAS_EG_PASSWORD  (or SAS_USER, SAS_PASSWORD)  the login; the password is a secret: .env.<ENV>.local only
#   SAS_LOGON_FAILURE_COOLDOWN_MIN  a rejected logon is never repeated within this many minutes (protects the account)
#   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  the declared SAS environment: running a program is an UPDATE, allowed only in a nonprod one
#   SAS_ALLOW_OUTSIDE_NAMESPACE (+ _REASON)  see example 2: the program below is named with the run's namespace for that reason
#   SAS_DESKTOP_TIMEOUT_MS  how long any one step waits; a long program needs the `timeoutMs` option of runProgram as well
#   SAS_ASSERT_TIMEOUT_MS   how long an assertion step keeps re-checking before it fails (5 s by default)
#   SAS_DESKTOP_EVIDENCE    `steps` adds a screenshot after every step that may change something (SAS_EVIDENCE=steps does the same)
@sas-desktop @eg-ui @example
Feature: EXAMPLE 3 - SAS Enterprise Guide screens: connect, open a project, run a program and read the results
  As a SAS developer
  I want to see how a test about Enterprise Guide's screens is written, line by line
  So that I can copy the parts I need for my own

  Scenario: Connect, open a project, run a program and read the results
    # Enterprise Guide is open AND connected. The fixture launched it (SAS_EG_PATH), clicked Connect, chose the profile (SAS_EG_PROFILE),
    # typed the login (SAS_EG_USER / SAS_EG_PASSWORD, else SAS_USER / SAS_PASSWORD) through the logon guard, and waited for
    # the "Connected to" message. A wrong login is typed ONCE: the guard then refuses the same login for a while.
    Given SAS Enterprise Guide is open and I am logged on
    Then the window title matches the pattern "SAS Enterprise Guide"
    And Enterprise Guide shows that it is connected
    # Say once what to do about a dialog that may appear in front of any step, instead of `if (dialog exists)` everywhere.
    And Enterprise Guide closes the "Tip of the Day" dialog whenever one appears
    # Ctrl+O, the file name, Open - then it waits until the main window carries the project's name.
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    Then the window title matches the pattern "Sales"
    # Selects the program, presses Run and waits until it is no longer running (Stop is disabled). It is an UPDATE: the program name is
    # judged by the safety policy, so it carries the run's namespace (see example 2 for why).
    When I run the program "{{namespace}}_Summary"
    # The results: the log and results text the screens show, and a count of ERROR / WARNING lines.
    Then the program "{{namespace}}_Summary" ended with the status "Warning", 0 errors and 1 warnings
    And the log of the program "{{namespace}}_Summary" contains the exact text "PROCEDURE MEANS"
    And the log shown on the screen is the log of the program "{{namespace}}_Summary"
    When I add a screenshot called "{{namespace}}_Summary done" to the report

  Scenario: Without the logon Enterprise Guide waits to be connected
    # Nothing was typed: nothing could have been rejected.
    Given SAS Enterprise Guide is open
    Then a window whose title contains "SAS Enterprise Guide" is open
    And the control named "Connect" is enabled
