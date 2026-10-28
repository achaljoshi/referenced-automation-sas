# SMOKE tests of the REAL programs: log on, look, leave. They only READ (no project is run, nothing is created), so they are allowed in
# any nonprod environment - and in production when SAS_ALLOW_PROD_READS=true. They need the logins (SAS_SMC_USER / SAS_SMC_PASSWORD,
# SAS_EG_USER / SAS_EG_PASSWORD, or SAS_USER / SAS_PASSWORD in .env.<ENV>.local) and the program settings of .env.example (SAS_SMC_PATH,
# SAS_SMC_PROFILE, SAS_EG_PATH, SAS_EG_PROFILE).
#
# Log on by hand with exactly these values first: a wrong password counts towards the account's lock limit. A rejected logon is never
# repeated, and the logon guard refuses the same login for SAS_LOGON_FAILURE_COOLDOWN_MIN minutes.
#
# NOT VERIFIED on a real desktop. `SAS_DESKTOP_SIMULATOR=true npm run test:real-smoke` runs the same scenarios against the stand-in desktop
# so they cannot rot unnoticed; where no desktop can be reached they are SKIPPED with the reason.
@sas-desktop @real-smoke
Feature: Smoke of the real programs: log on, look, leave
  As a SAS administrator on a machine with SAS
  I want a quick, read-only look at both programs
  So that I know they start, log on and answer before any bigger test relies on them

  @smc-ui
  Scenario: Management Console: log on, see the navigation tree, open the User Manager
    # Asking for the logon logs the console on, through the logon guard.
    Given SAS Management Console is open and I am logged on
    # empty to UI Automation = the Java Access Bridge is not enabled (npm run doctor)
    Then the navigation tree is shown
    When I open the "User Manager" plug-in
    Then the User Manager lists at least one user

  @eg-ui
  Scenario: Enterprise Guide: connect and see the main window
    Given SAS Enterprise Guide is open and I am logged on
    Then the window title matches the pattern "SAS Enterprise Guide"
    And Enterprise Guide shows that it is connected

  @eg-com
  Scenario: Enterprise Guide by COM: the object model answers
    Given SAS Enterprise Guide is available through its automation interface
    Then the object model answers with a version
