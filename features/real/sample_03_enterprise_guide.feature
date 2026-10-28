# SAMPLE 3 - SAS ENTERPRISE GUIDE: the automation object model (COM, the first choice) and its screens. READ-ONLY: it opens a project and
# lists what is in it; it does not run it, save it or change it. (Running a project is an update: see features/example_02_enterprise_guide_com.feature
# and the safety rules.)
#
#     npm run test:real-samples
#
# Settings - each one is explained in .env.example:
#   SAS_EG_PATH, SAS_EG_PROFILE     which program to start and which server profile to activate (the screens)
#   SAS_EG_PROGID, SAS_COM_PROGIDS  which COM class to create and which classes are allowed at all (`npm run doctor` lists what is registered)
#   SAS_EG_USER, SAS_EG_PASSWORD    (or SAS_USER, SAS_PASSWORD) the login for the screens
#   SAS_SAMPLE_EG_PROJECT           the full path of an existing .egp to open and list (the stand-in has its own)
@real-sample @sas-desktop @eg-com @eg-ui
Feature: SAMPLE 3 - SAS Enterprise Guide: the object model and the screens
  As a SAS developer on a machine with SAS
  I want to see Enterprise Guide answer by COM and connect by its screens
  So that I know both ways of driving it work here before I build on them

  Scenario: By COM: the object model answers with its version
    Given SAS Enterprise Guide is available through its automation interface
    Then the object model answers with a version

  Scenario: By COM: open a project and list its process flows and programs
    Given SAS Enterprise Guide is available through its automation interface
    And an existing Enterprise Guide project to look at is remembered as "project"
    # Opening is a READ for the policy: nothing changes.
    When I open the Enterprise Guide project "{{project}}" and remember its name as "name"
    Then the variable "name" matches ".*\.[eE][gG][pP]"
    And the project holds at least one process flow or program
    When I close the project

  Scenario: By screens: connect and see the main window
    Given SAS Enterprise Guide is open and I am logged on
    Then the window title matches the pattern "SAS Enterprise Guide"
    And Enterprise Guide shows that it is connected
