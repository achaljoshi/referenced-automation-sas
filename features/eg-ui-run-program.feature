@sas-desktop @eg-ui @regression
Feature: Enterprise Guide's own screens run a program
  As a SAS developer
  I want to check that Enterprise Guide's screens connect, open a project and run a program
  So that I know the program itself works after an upgrade

  Background:
    Given SAS Enterprise Guide is open and I am logged on

  Scenario: A program is run from the screens and its log is read
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    And I run the program "{{namespace}}_Summary"
    Then the program "{{namespace}}_Summary" finished with the status "Warning"
    And the log of the program "{{namespace}}_Summary" contains "PROCEDURE MEANS"
    And the window title contains "Sales"

  Scenario: The status of a program can be remembered for later steps
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    And I run the program "{{namespace}}_Program"
    And I remember the title of the window as "title"
    Then the program "{{namespace}}_Program" finished without errors
    And the variable "title" is not empty
