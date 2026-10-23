# 0002. Record and play for SAS desktop programs: our own recorder in the bridge, a converter to Playwright tests, and protocol-level capture for Management Console administration

- **Status:** Proposed
- **Date:** 2026-10-23
- **Approved by:** _not yet recorded_

## Context
The UI repo converts Playwright codegen recordings, and the SAP repo converts SAP GUI Scripting recordings (VBScript), into framework tests with `CONSTANTS` and `LOCATORS` at the top. Users want the same for SAS Management Console (a Java Swing program) and SAS Enterprise Guide (a WPF program).

What exists, from SAS documentation and community sources (to be confirmed against the installed releases):
- **SAS Enterprise Guide** has an *Editor Macros* recorder, but it records edits in the code editor only, not clicks in the application. It also has an automation object model, and *File > Schedule Project* generates a VBScript that runs a project through that object model.
- **SAS Management Console** has no recorder.
- Windows has no neutral recorder that produces test code. Microsoft's WinAppDriver UI Recorder is archived and Power Automate Desktop produces its own flows, neither of which fits a TypeScript pipeline.
- The SAS metadata server can write what administrators do into its logs: the `Audit.Meta.Updates` logger records add/update/delete events with user and time, the `Audit.Meta.Security.*` loggers record user, group, ACT and permission changes, and the `App.OMI` logger set to TRACE captures the XML requests (limited in length by `JNLLINEMAX` / `JNLSTRMAX`; to be reset afterwards).

## Decision
We provide three complementary ways to turn what a person does into a framework test, in this order of preference:

1. **GUI recorder (our own), for both programs.** The PowerShell bridge gets `record.start` / `record.stop`. While recording it subscribes to Windows UI Automation events (invoke, selection, toggle, expand/collapse, value change, window opened/closed, focus) and to low-level mouse and keyboard hooks; at each click the element under the pointer is resolved through UI Automation and described as a **locator candidate chain** (window title pattern, then ancestors and the element by `AutomationId`, `Name`, `ControlType`, `ClassName` and sibling index, with a coordinate fallback that is flagged). Typing is coalesced into one `setText` at commit time. **A value typed into a password field, or a field whose name looks secret, is never recorded**: the event says "secret" and the converter writes an environment read (`SAS_PASSWORD`), as the SAP converter does. Output is a `.sasrec.json` file (a recording is data, not code).
2. **Converter `sas-desktop-to-playwright`** (like `sap-vbs-to-playwright`): `recording -> tests/*.spec.ts` with `CONSTANTS` (typed values, secrets as environment getters) and `LOCATORS` (each control named once, chosen by stability: `AutomationId` > `Name` + type > `ClassName` + index; a coordinate-only target is a `TODO(manual)` and fails `--strict`), options `--page-objects`, `--data` (CSV-driven), `--expect-text`, `--expect-window`, `--strict`, `--fixture`. Generated tests carry no sleeps (the framework waits), and ship with a failing guard until an assertion is added, exactly as the SAP converter does.
3. **Protocol-level capture for Management Console administration.** When the goal is to automate *what an administrator changes* rather than how the screens look, the recording is taken from the metadata server instead of the screen: with the server's loggers raised in a **non-production** environment (App.OMI TRACE, plus the audit loggers), a command (`sas-metadata-capture start|stop`) reads the server log slice for the session, extracts the metadata requests, and converts them into replayable calls in the `MetadataAdmin` layer (SAS code or batch-tool commands), with the audit entries as the expected-outcome check. This is far less fragile than clicks. It needs a server administrator to raise the loggers, and the captured text is limited by the logger's line limits; it is offered only for non-production and is off by default.

Enterprise Guide also gets a **schedule-script importer**: `sas-eg-import-script file.vbs` reads the VBScript that *File > Schedule Project* generates (open a project, run it, optionally save/export) and produces a test that uses the Enterprise Guide COM driver.

## Security
Recordings never contain passwords; the recorder refuses to start unless the target is an allow-listed environment; the hooks run only for the chosen application's windows (other windows' keystrokes are not recorded); recordings are plain JSON a reviewer can read and the secret scanner checks them; captured server logs can contain personal data and are processed in memory, written only as the derived calls, and never attached to reports.

## Consequences
The same developer experience as the UI and SAP repos for the two desktop programs. Recording quality depends on how much of the program UI Automation can see: Enterprise Guide (WPF) exposes many `AutomationId`s; Management Console (Swing) exposes names and roles only after the Java Access Bridge is enabled, so its recordings have weaker locators and more `TODO(manual)` items, which is why protocol-level capture exists for administration. A real hook-based recorder can only be proven on Windows with the real programs; until then it is NOT VERIFIED and developed against the fake desktop bridge.

## Alternatives considered
Power Automate Desktop or the WinAppDriver recorder (output is not code we can own); image-based recorders (brittle); recording only through Enterprise Guide's Editor Macros (code-editor edits only); asking users to hand-write locators from the `inspect` output (kept as the fallback, and the converter's output is exactly that, generated).
