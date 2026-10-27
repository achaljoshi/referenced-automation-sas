# The worked examples

Four heavily commented specs in [`tests/examples/`](../tests/examples), one per program, that run on the built-in **stand-in desktop** - no SAS, no Windows, any OS:

```bash
npm run try:simulator          # all of them; prints what each one does first
npm run try:simulator -- 02_   # one
```

Read one top to bottom, then copy the parts you need. **Each line is explained with the `.env` key it uses**; every key is documented in [`.env.example`](../.env.example) (what it is for, valid values, default, where to find the value in the SAS program).

| Example | Program | Route | What it shows |
|---|---|---|---|
| [`01_management_console.spec.ts`](../tests/examples/01_management_console.spec.ts) | SAS Management Console | screens (last resort) | Log on through the logon guard (`smcLoggedOn`), open the User Manager, find a user, group; your own locators; evidence; the failure message that says what *is* on the screen; the logon dialog before logging on (`smcApp`) |
| [`02_enterprise_guide_com.spec.ts`](../tests/examples/02_enterprise_guide_com.spec.ts) | SAS Enterprise Guide | **COM (first choice)** | Open a project, run it, read each program's status and log, export the results, register the export for clean-up, quit |
| [`03_enterprise_guide_screens.spec.ts`](../tests/examples/03_enterprise_guide_screens.spec.ts) | SAS Enterprise Guide | screens (second) | Connect (`egLoggedOn`), open a project, run a program, read the results; a dialog handler; evidence |
| [`04_safety_policy.spec.ts`](../tests/examples/04_safety_policy.spec.ts) | (policy) | | What happens when a test steps outside its rules: a run outside the namespace is refused before anything runs, and the refusal is in the audit log |

## The keys the examples use

| Key | Where | What it does in the example |
|---|---|---|
| `SAS_DESKTOP_SIMULATOR` | 01-04 | `true` = the stand-in desktop. `npm run try:simulator` sets it, and `tests/examples/support/exampleTest.ts` forces it |
| `SAS_SMC_PATH`, `SAS_SMC_PROFILE` | 01 | launch the console, choose its connection profile |
| `SAS_EG_PATH`, `SAS_EG_PROFILE` | 02, 03 | launch Enterprise Guide for the screens; activate the server profile |
| `SAS_EG_PROGID`, `SAS_COM_PROGIDS`, `SAS_DESKTOP_POWERSHELL` | 02 | which COM class to create; which classes are allowed at all; the 32-bit PowerShell for a 32-bit Enterprise Guide |
| `SAS_SMC_USER`, `SAS_SMC_PASSWORD`, `SAS_EG_USER`, `SAS_EG_PASSWORD`, `SAS_USER`, `SAS_PASSWORD` | 01, 03 | the login (the password is a secret: `.env.<ENV>.local` only); the stand-in has its own demo login |
| `SAS_LOGON_FAILURE_COOLDOWN_MIN` | 01, 03 | a rejected logon is typed once, then refused for this long |
| `SAS_APP_MODE` | 01, 03 | `launch` (start the program), `attach` (use the open one, never close it), `auto` |
| `SAS_ENVIRONMENT`, `SAS_ENVIRONMENTS_FILE` | 01-04 | which declared environment the run works against (the stand-in is `simulator`) |
| `SAS_ALLOW_OUTSIDE_NAMESPACE`, `SAS_ALLOW_OUTSIDE_NAMESPACE_REASON`, `SAS_NAMESPACE_PATTERN` | 02-04 | the run's namespace `AUTO_<runId>`; the logged exception to "change only what you created" |
| `SAS_DESKTOP_TIMEOUT_MS`, `SAS_DESKTOP_EVIDENCE` | 01, 03 | how long a step waits; `steps` = a screenshot after every changing step |
| `SAS_EVIDENCE` | 01, 03 | what the report gets automatically (failure by default) |
| `SAS_CLEANUP_FAILURE` | 02 | what a failed clean-up does to its test |
| `SAS_AUDIT_FILE` | 04 | where the audit log is written |

## The stand-in's project

The sample Enterprise Guide project is filed under the run's namespace on purpose (`C:\Projects\AUTO_<runId>_Sales.egp`, programs `AUTO_<runId>_Program` and `AUTO_<runId>_Summary`): **running a project or a program is an update, and a run may only change objects named with its own namespace.** Your real project has its own name. Either name test projects `AUTO_<runId>_...`, or deliberately run an existing one with `SAS_ALLOW_OUTSIDE_NAMESPACE=true` and a `SAS_ALLOW_OUTSIDE_NAMESPACE_REASON` (written to the audit log). Example 4 shows the refusal.

## Against the real programs

The stand-in proves the framework's flows, **not** that SAS looks like this (NOT VERIFIED on a real desktop). To run an example against the real programs: in `tests/examples/support/exampleTest.ts` delete the two worker options (`desktopSimulator`, `sasSettings`), fill in `.env.<ENV>` and `.env.<ENV>.local` ([README, Windows first run](../README.md#windows-first-run-powershell-from-zero-to-your-first-test)), change the `CONSTANTS` at the top of the example to names that exist in your SAS system, and run it by path with forward slashes: `npx playwright test tests/examples/01_management_console.spec.ts`.

For a first run on the machine where SAS is installed, use the read-only [sample tests](../README.md#sample-tests-for-a-machine-with-sas) (`npm run test:real-samples`) before changing an example: they take what to look at from `SAS_SAMPLE_*` settings and never hard-code a name from the stand-in.
