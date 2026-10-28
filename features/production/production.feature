@sas-desktop @mode:serial
Feature: Production is read-only
  As the owner of a production SAS system
  I want a test run against production to look but never to change anything
  So that a test can check production is healthy without any risk to it

  # The environment of this folder is a production one (`prod-sim`, declared in tests/fixtures/environments.json), with reads allowed
  # (SAS_ALLOW_PROD_READS=true). The scenarios run in this order, in one worker: the last one looks at what the first one left behind.

  Scenario: Reads work, a raw click is refused before the program is touched, and the audit says so
    Given the selected SAS environment is a production one
    And SAS Management Console is open and I am logged on
    When I open the "User Manager" plug-in
    Then the User Manager lists the user "sasdemo" spelled exactly like that
    When I try to click the tab named "Groups"
    Then the safety policy refuses it with the rule "prod-read-only"
    And the audit log records a denied "click" in the environment "prod-sim"

  Scenario: The program a scenario started is still closed at its end, because housekeeping is not a change
    Then SAS Management Console, started by the scenario before, is no longer running

  Scenario: Running a project by COM is refused in production, whatever it is called
    Given SAS Enterprise Guide is available through its automation interface
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    And I try to run the project
    Then the safety policy refuses it with the rule "prod-read-only"
