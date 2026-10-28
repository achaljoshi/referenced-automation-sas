# EXAMPLE 2 - SAS Enterprise Guide by COM: open a project, run it, read the log, export the results. THIS is the first way to drive
# Enterprise Guide: no window is clicked, no desktop has to be visible, and it is faster and steadier than the screens (example 3).
#
#     npm run try:simulator -- 02_
#
# The settings the example relies on - every one is explained in .env.example:
#   SAS_DESKTOP_SIMULATOR   true = the built-in stand-in desktop with a fake Enterprise Guide object model (features/steps/fixtures.ts forces it)
#   SAS_EG_PROGID           the exact COM class, e.g. SASEGObjectModel.Application.8.3 (the number is your Enterprise Guide's version;
#                           without it the newest registered class is found by itself)
#   SAS_EG_PROFILE          the server profile Enterprise Guide runs the project against (as its connection dialog lists it)
#   SAS_COM_PROGIDS         the COM classes the bridge may create at all (allow-list; SASEGObjectModel.Application.* by default)
#   SAS_DESKTOP_POWERSHELL  a 32-bit Enterprise Guide needs the 32-bit PowerShell, or its COM class is "not registered"
#   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  the declared SAS environment: running a project is an UPDATE, allowed only in a nonprod one
#   SAS_ALLOW_OUTSIDE_NAMESPACE (+ _REASON)  lets a run change objects that are not named AUTO_<runId>_...: see the project name below
#   SAS_CLEANUP_FAILURE     what a clean-up that could not remove something does to its scenario: fail (default) or warn
#   SAS_EVIDENCE            what the report gets automatically on failure
#
# The project is named with the run's NAMESPACE - {{namespace}} is `AUTO_<runId>` - because running it is an update and the safety policy
# lets a run change only objects named with its own. Your real project already has its own name: either name test projects
# AUTO_<runId>_..., or deliberately run an existing one with SAS_ALLOW_OUTSIDE_NAMESPACE=true and a SAS_ALLOW_OUTSIDE_NAMESPACE_REASON (the
# reason goes to the audit log). Example 4 shows what happens without.
@sas-desktop @eg-com @example
Feature: EXAMPLE 2 - SAS Enterprise Guide by COM: open a project, run it, read the log and export the results
  As a SAS developer
  I want to see how an Enterprise Guide test by COM is written, line by line
  So that I can copy the parts I need for my own

  Scenario: Open a project, run it, read the log and export the results
    # The fixture created the Enterprise Guide application object (SAS_EG_PROGID, else discovered) and activated the profile
    # (SAS_EG_PROFILE). Nothing was clicked. Enterprise Guide runs in the background.
    Given SAS Enterprise Guide is available through its automation interface
    Then the object model answers with a version
    # Opening a project is a 'read'; nothing runs yet. The name is the file name.
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp" and remember its name as "project"
    Then the variable "project" equals "{{namespace}}_Sales.egp"
    And the project holds exactly these items:
      | kind        | name                  |
      | processFlow | Main Flow             |
      | program     | {{namespace}}_Program |
      | program     | {{namespace}}_Summary |
    # SAS code runs on the profile's server - an UPDATE, so the safety policy judges it once, as a whole: the environment must be nonprod
    # and the project inside this run's namespace. The result is one status per program, taken from the object model's own member where
    # there is one, else from the ERROR / WARNING lines of the log.
    When I run the project
    Then the program "{{namespace}}_Program" ended with the status "Succeeded", 0 errors and 0 warnings
    And the program "{{namespace}}_Summary" ended with the status "Warning", 0 errors and 1 warnings
    # What the program wrote to the SAS log. Assert on what matters to you, not on the whole text.
    And the log of the program "{{namespace}}_Program" contains the exact text "observations read"
    # Exporting saves every result of a program into a folder. It CREATES files, so the folder must be inside the namespace too.
    # The scenario registers what it creates the moment it creates it: the clean-up undoes it after the scenario, pass or fail, newest first.
    When I export the results of the program "{{namespace}}_Summary" to the folder "C:\Exports\{{namespace}}_export" and clean it up afterwards
    Then these files were written:
      | file                                         |
      | C:\Exports\{{namespace}}_export\Summary.html |
      | C:\Exports\{{namespace}}_export\Summary.pdf  |
    And the stand-in desktop holds the written files
    # After the scenario the fixture quits Enterprise Guide and releases every COM object, even when the scenario failed.
    When I save the project

  Scenario: One process flow can be run on its own
    Given SAS Enterprise Guide is available through its automation interface
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    # The target the policy judges is "<project> / Main Flow": inside the namespace through the project.
    And I run the process flow "Main Flow"
    Then the program "{{namespace}}_Summary" finished with the status "Warning"
