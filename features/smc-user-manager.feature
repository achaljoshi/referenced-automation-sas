@sas-desktop @smc-ui @smoke
Feature: Management Console shows who and what an environment holds
  As a SAS administrator
  I want to look at users, groups, libraries and servers in SAS Management Console
  So that I can check an environment is set up before anyone relies on it

  Background:
    Given SAS Management Console is open and I am logged on

  Scenario: The User Manager lists a known user
    When I open the "User Manager" plug-in
    Then the user "sasdemo" is listed
    And the window title contains "SAS Management Console"

  Scenario: A user that does not exist is not listed
    When I open the "User Manager" plug-in
    Then the user "Nobody Atall" is not listed

  Scenario: The User Manager lists the groups
    When I open the "User Manager" plug-in
    Then the group "SAS Administrators" is listed

  Scenario: The Data Library Manager lists the libraries
    When I open the "Library Manager" plug-in
    Then the library "Orion" is listed

  Scenario Outline: The servers report their status
    When I open the "Server Manager" plug-in
    Then the server "<server>" has the status "<status>"

    Examples:
      | server                         | status  |
      | SASMeta - Metadata Server      | Running |
      | SASApp - Stored Process Server | Stopped |
