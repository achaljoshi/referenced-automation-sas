@sas-desktop @smc-ui @regression
Feature: A wrong password is typed once and never again
  As the owner of a personal SAS login
  I want a rejected logon to be refused when anything tries it again
  So that a failed run, a retry or a re-run cannot lock my account

  Scenario: A rejected logon is not repeated
    Given SAS Management Console is open
    When I try to log on to SAS Management Console with a wrong password
    Then the logon is rejected
    And the same logon is not attempted again
