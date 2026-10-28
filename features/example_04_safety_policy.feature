# EXAMPLE 4 - what the safety policy does when a test steps outside its rules. Every step of every driver passes the policy and leaves
# a line in the audit log; a refusal changes nothing in SAS. Read docs/SECURITY.md for the rules.
#
#     npm run try:simulator -- 04_
#
# The settings it relies on (all in .env.example):
#   SAS_DESKTOP_SIMULATOR   true = the built-in stand-in desktop (features/steps/fixtures.ts forces it)
#   SAS_ENVIRONMENT, SAS_ENVIRONMENTS_FILE  the declared environment and its kind: nonprod, or prod (read-only by construction)
#   SAS_ALLOW_OUTSIDE_NAMESPACE, SAS_ALLOW_OUTSIDE_NAMESPACE_REASON  the deliberate, logged exception to "only change what you created"
#   SAS_NAMESPACE_PATTERN   how the run's namespace is named (AUTO_{runId} by default)
#   SAS_AUDIT_FILE          where the audit log is written (test-results/sas-audit/audit-<runId>.jsonl by default)
@sas-desktop @eg-com @example
Feature: EXAMPLE 4 - the safety policy refuses what a test did not create, and says so in the audit log
  As the owner of a SAS system
  I want a test that steps outside its own objects to be stopped before anything runs
  So that a mistake in a test cannot change somebody else's project

  Scenario: Running a project that is not named with the run namespace is refused, and the refusal is audited
    Given SAS Enterprise Guide is available through its automation interface
    # A project that exists under its own name (the stand-in's default sample): opening it is a read, so it is allowed ...
    When I open the Enterprise Guide project "C:\Projects\Sales.egp" and remember its name as "own"
    Then the variable "own" equals "Sales.egp"
    # ... but RUNNING it is an update, and it is not inside this run's namespace (AUTO_<runId>_...): refused BEFORE anything runs.
    When I try to run the project
    Then the safety policy refuses it with the rule "outside-namespace"
    And the refusal explains how to proceed
    And nothing was run in Enterprise Guide for the project "C:\Projects\Sales.egp"
    # The audit log says so: who (run id, correlation id), what, where, and how it ended.
    And the audit log records one denial of "runProject" on "C:\Projects\Sales.egp" with the reason "outside-namespace"
    # The same project, inside the namespace, runs.
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    And I run the project
    Then the run reported at least one program
