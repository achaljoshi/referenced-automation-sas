@sas-desktop @eg-com @smoke
Feature: Enterprise Guide projects run through the automation interface
  As a SAS developer
  I want to run an Enterprise Guide project without clicking through the program
  So that I can check what its programs wrote to the log

  Background:
    Given SAS Enterprise Guide is available through its automation interface
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"

  Scenario: Running the project reports each program
    When I run the project
    Then the program "{{namespace}}_Program" finished without errors
    And the program "{{namespace}}_Summary" finished with the status "Warning"
    And the log of the program "{{namespace}}_Program" contains "19 observations read"

  Scenario: A process flow can be run on its own
    When I run the process flow "Main Flow"
    Then the program "{{namespace}}_Summary" finished without errors

  Scenario: The results of a program are exported to a folder of this run
    Given I make up the test object name "export" as "folder"
    And I run the project
    When I export the results of the program "{{namespace}}_Summary" to the folder "C:\Exports\{{folder}}"
    And I export the log of the program "{{namespace}}_Summary" to the file "C:\Exports\{{folder}}\summary.log"
    Then the program "{{namespace}}_Summary" finished with the status "Warning"
