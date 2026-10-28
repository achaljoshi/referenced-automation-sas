# SAMPLE 1 - the COMMAND LINE route (the first choice of this repo): run a program, let the safety policy judge it, read the audit log.
# No window is involved, so this sample runs on Windows, macOS and Linux. It only READS: nothing is created, changed or run on SAS.
#
#     npm run test:real-samples
#
# It needs the run to be asked for on purpose (the real-system tests are opt-in: see features/real/steps/fixtures.ts and
# tests/support/realOptIn.ts) and a declared SAS environment (SAS_ENVIRONMENT, env/sas-environments.json). Settings - each one is
# explained in .env.example, section 12:
#   SAS_TOOL_DIRS            the folders tools are run from; a bare tool name is looked up ONLY here, never on PATH
#   SAS_SAMPLE_TOOL          the tool to run: a name inside SAS_TOOL_DIRS, or an absolute path. Pick a command that only prints something
#                            (a version or help option of a SAS tool: NOT VERIFIED which options YOUR release has)
#   SAS_SAMPLE_TOOL_ARGS     its arguments, separated by commas (so an argument cannot contain a comma): --version
#   SAS_SAMPLE_TOOL_EXPECT   optional: a regular expression the output must match, case-insensitive
#   SAS_SAMPLE_TOOL_EXIT     optional: the exit code that means success (default 0)
#
# Without SAS_SAMPLE_TOOL the scenario that runs a tool is SKIPPED with the reason - never silently passed. The other two need no tool.
@real-sample @sas-cli
Feature: SAMPLE 1 - the command line: run a command, let the safety policy judge it, read the audit log
  As a SAS developer on a machine with SAS
  I want to see a command run through the policy gate and leave a record
  So that I know the command-line route works here before I build on it

  Scenario: The tool folders are usable: they exist and nobody else can write into them
    Then the tool folders exist and nobody else can write into them

  Scenario: A read-only command runs through the policy gate and leaves one audit record
    Given a command that only prints something is configured
    When I run the sample command as the read-only operation "sample:read"
    Then the sample command finished in time with the exit code it is expected to end with
    And the output of the sample command matches the expected pattern, when one is set
    And the audit log holds a record of the sample command as the read-only operation "sample:read"

  Scenario: A change outside this run's own objects is refused before anything starts
    When I try to run a command that deletes "A Library Somebody Else Owns" as the operation "sample:delete"
    Then the safety policy refuses it
    And the audit log holds a denied record of the operation "sample:delete"
    And the names this run may change start with "AUTO_"
