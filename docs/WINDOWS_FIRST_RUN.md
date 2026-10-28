# Windows first run (PowerShell, from zero to your first real test)

> **NOT VERIFIED.** Nobody has run these steps on a real Windows desktop with the real SAS programs: they were written from SAS documentation, community sources and the stand-in desktop. The first run on your machine is the conformance run - treat anything that differs as something to report.

For a Windows machine (a laptop, an AWS WorkSpace) with SAS Management Console and/or SAS Enterprise Guide installed. Commands are **PowerShell**: in VS Code use **Terminal > New Terminal** and check that the shell says `PowerShell`. The short version is in the [README](../README.md#windows-first-run-powershell-from-zero-to-your-first-test).

In PowerShell:

- an environment variable is set with `$env:NAME = "value"` and removed with `Remove-Item Env:NAME`; `set NAME=value` (cmd.exe) does nothing there;
- list what is set with `Get-ChildItem Env:SAS_*`: **a variable set in your shell wins over every `.env` file**, which is the first thing to look at when a value "does not take";
- paths to tests use **forward slashes** after `npx playwright test` (`tests/real/conformance.spec.ts`): a backslash path gives `No tests found`;
- inside this repo the tools run through npm (`npm run doctor`); the `npx sas-desktop-inspect` name exists only in projects that depend on this package.

## 0. What you need

| Need | Why |
|---|---|
| Node.js 18 or later (`node -v`) | runs the tests and the bridge client |
| Windows PowerShell 5.1 (`powershell.exe`, part of Windows) | the bridge to UI Automation and COM |
| SAS Management Console and/or SAS Enterprise Guide | the programs under test (SAS 9.4 desktop) |
| The Java Access Bridge enabled (Management Console only) | Windows cannot see Swing controls without it: section 3 |
| An unlocked, connected, interactive desktop | UI Automation, mouse and keyboard need one: section 8 |
| A SAS login - ideally a dedicated test account with least privilege | the programs ask for it |

`scripts\inventory-sas.ps1` lists what is installed on the machine (batch tools, COM class names, Java Access Bridge files) - useful to fill in `SAS_EG_PROGID` and to tell your SAS administrator what you found.

## 1. Install

```powershell
.\scripts\setup.bat            # npm ci + the Playwright browser
.\scripts\setup.bat --local    # instead, when the registry does not have the @automation packages yet: builds the sibling repos next to this one
```

`setup.bat` runs `npm config set registry` when `NPM_REGISTRY_URL` is set. If a later command says `'tsc' is not recognized`, this step did not run (there is no `node_modules` folder): run it and read its first error.

## 2. Build and check the machine

```powershell
npm run build
npm run doctor
```

`doctor` checks, in this order: the bridge script is the one this version ships (SHA-256), PowerShell starts the bridge, the machine is Windows with an interactive session, the desktop is unlocked, UI Automation works, elevation, the COM allow-list, the Java Access Bridge (and Java windows with an empty tree), `SAS_SMC_PATH` / `SAS_EG_PATH` exist, and the Enterprise Guide COM class can be created. **Fix what it says from the top**: each failure line ends with what to do. `Cannot find module '...\dist\desktop\cli\inspect.js'` means step 2's `npm run build` did not run.

## 3. The Java Access Bridge (Management Console)

Management Console is a Java Swing program. Windows UI Automation sees Swing controls **only when the Java Access Bridge is enabled**:

1. Find `jabswitch.exe` in the `bin` folder of the Java that Management Console uses - typically below `SASHome\SASPrivateJavaRuntimeEnvironment\9.4\jre\bin` (`npm run doctor` prints the paths it found).
2. In a command prompt: `jabswitch -enable`.
3. **Close and restart Management Console.** The change is only picked up by a program started afterwards.

The symptom of a disabled bridge: `npm run doctor` says "a Java window whose UI Automation tree is empty - the symptom of a disabled Java Access Bridge", and `npm run inspect -- --app smc` prints `(none found - for a Java application check the Java Access Bridge)`. (NOT VERIFIED: the heuristic - a Java window with fewer than three controls beyond its title bar - was never run against the real console.)

## 4. See what the programs look like to the automation

Start the program (Management Console logged on), then:

```powershell
npm run inspect -- --app smc          # --app eg, or --app "<window title regex>"; --depth 8 for more
npm run inspect:windows               # every open window with its process
```

Every control is printed with its name, automation id, type, class and a locator to paste, for example `Button name="OK" id="" class="javax.swing.JButton" -> .getByRole('Button', { name: 'OK' })`. **Every entry of the LOCATORS tables is a best guess** (`SMC_LOCATORS`, `EG_UI_LOCATORS`, `EG_COM` - each at the top of its file, each commented): compare, and fix the table where the real names differ. Passwords are never read.

## 5. Say where SAS is

1. **Environment.** Declare the environment your run works against - its kind and the hosts a driver may contact - in `env/sas-environments.json` (copy the entries you need from `env/sas-environments.json.example`). **An environment that is not declared is refused.** Production is `"kind": "prod"`: read-only by construction.
2. **Settings.** Edit `.env.qa` (or the file for your `ENV`): remove the `# ` in front of `SAS_SMC_PROFILE`, `SAS_EG_PROFILE`, `SAS_SMC_PATH`, `SAS_EG_PATH`, `SAS_USER` and replace the placeholders. The profile names are exactly what the programs' connection dialogs list. Every variable is explained in `.env.example`.
3. **The secret.** Only in the git-ignored secrets file, named for the environment:
   ```powershell
   Copy-Item .env.local.example .env.qa.local       # then edit it: SAS_PASSWORD="your password"  (double quotes!)
   ```
   A file named just `.env.local` is **not** read. A password with `#` or spaces must be in double quotes: an unquoted `#` starts a comment and cuts the password, which is then wrong - and a wrong password counts towards the account's lock limit.
4. **Log on by hand** to each program with exactly these values before running anything.

## 6. Run

```powershell
npm run try:simulator                                      # the examples on the stand-in: what a green run looks like (no SAS needed)
npm run test:conformance                                   # real machine: no login, nothing is changed (tests/real/conformance.spec.ts)
npm run test:real-samples                                  # real machine: the three read-only sample tests (command line, Management Console, Enterprise Guide)
npm run test:real-smoke                                    # real machine: log on, look, leave (read-only)
npx playwright test -g "User Manager"                      # one test, by part of its title
npx playwright show-report                                 # the report: screenshot, step journal and "On the screen now" on a failure
```

The tests of the real programs only run when asked for: a plain `npm test` skips them with the reason, so it never opens SAS or types a login. The three `test:real-*` / `test:conformance` scripts ask for them (they set `SAS_REAL_TESTS=true`). To run one of them with `npx playwright test`, set `$env:SAS_REAL_TESTS = "true"` first (the samples and the smoke checks are Gherkin: `npx bddgen`, then `--project=bdd-real`). The samples are described in the [README](../README.md#sample-tests-for-a-machine-with-sas); what to point them at (`SAS_SAMPLE_TOOL`, `SAS_SAMPLE_EG_PROJECT`, ...) is in `.env.example`, section 12.

Conformance first: it tells you whether the stand-in's assumptions hold on this machine. If a logon fails, **do not run again** until the credentials are fixed.

To run your own test against the real programs, use `desktopTest` from `src/fixtures` (or the package) **without** the `desktopSimulator` override that the examples and sample features use; `.env.<ENV>` decides the rest.

## 7. What a run refuses, and why

| Message | What to do |
|---|---|
| every real test is skipped: `the tests of the real SAS programs only run when asked for` | `npx playwright test tests/real/...` (or `--project=bdd-real`) was run directly | use `npm run test:conformance`, `npm run test:real-samples` or `npm run test:real-smoke`, or set `$env:SAS_REAL_TESTS = "true"` first |
| `REFUSED by safety policy rule "unknown-environment"` | declare the environment in `env/sas-environments.json` |
| `REFUSED by safety policy rule "outside-namespace"` | name what the test creates or runs with `run.ns(...)` (`AUTO_<runId>_...`), or deliberately set `SAS_ALLOW_OUTSIDE_NAMESPACE=true` with a written `SAS_ALLOW_OUTSIDE_NAMESPACE_REASON` (it goes to the audit log) |
| `REFUSED by safety policy rule "prod-read-only"` | run it against a nonprod environment; nothing allows a change in production |
| `REFUSED by safety policy rule "prod-reads-disabled"` | `SAS_ALLOW_PROD_READS=true` for a run that only reads |
| `logon NOT attempted - it would have repeated a logon that ... has just rejected` | change the credentials (that clears it), or delete `.sas-state\logon-failed.json`, or wait out `SAS_LOGON_FAILURE_COOLDOWN_MIN` |
| `N of M pre-flight check(s) are red; no test was started.` | each red check ends with "what to do" |
| `N workers with a real SAS desktop` | one desktop = one worker: `--workers=1` |

The audit log of the run is `test-results\sas-audit\audit-<runId>.jsonl`: one line per step, who and what and how it ended, never a secret.

## 8. The interactive-desktop requirement

UI Automation, mouse and keyboard input and screenshots need a **logged-in, unlocked, connected interactive desktop of the same user and elevation as the program under test**. A locked workstation, a disconnected RDP session, a service, or a scheduled task without a desktop makes UI steps fail with `SESSION_LOST` ("the desktop is locked or the session is disconnected"). A bridge that is not elevated cannot automate a program started "as administrator". The COM route needs no visible screen, but Enterprise Guide still starts in your session. If the programs live on a remote desktop host you reach by RDP, set `SAS_DESKTOP_TRANSPORT=remote` (section 7 of `.env.example`): the bridge then runs inside the logged-in RDP session on that host, which must stay connected and unlocked.

## 9. Troubleshooting

The table of exact messages is in the [README](../README.md#troubleshooting) and in [`DESKTOP_SAS.md`](DESKTOP_SAS.md#troubleshooting). The ones people meet on day one: `'tsc' is not recognized` (run `.\scripts\setup.bat`), `Cannot find module ...\dist...` (run `npm run build`), `Illegal characters in path` for `*.tgz` (update the repo: `rimraf --glob`), `No tests found` (forward slashes), `error TS5108: Option 'moduleResolution=node10' has been removed` (TypeScript 7: `tsconfig.json` uses `node16`), and `rejected the logon` / `logon NOT attempted` (fix the credentials; do not re-run first).
