# referenced-automation-sas

Test automation for the **SAS desktop programs** - SAS Management Console and SAS Enterprise Guide - on Playwright Test and TypeScript, with a policy gate in front of everything that can change a SAS system.

> **NOT VERIFIED.** This repository was written on a machine with no Windows and no SAS. Everything is tested against stand-ins: a fake desktop with a fake Management Console, a fake Enterprise Guide and a fake Enterprise Guide COM object model (also available as a stand-in bridge program speaking the real line protocol). What only a real Windows desktop with the real programs can prove - the PowerShell bridge, the window titles and control names, the Enterprise Guide object model's member names - is labelled NOT VERIFIED where it is described, and is checked by the conformance run on a real machine (`npm run doctor`, then `npm run test:conformance`; see [Windows first run](#windows-first-run-powershell-from-zero-to-your-first-test)).

## What this repo is for - and what it is not for

| | |
|---|---|
| **For** | SAS **9.4 desktop** programs: SAS Management Console (a Java Swing program) and SAS Enterprise Guide (a WPF program). Opening and running Enterprise Guide projects and reading their logs and results; checking what Management Console shows; the safety, logon-protection, audit and clean-up machinery every such test needs; recording what a person does in the programs and turning it into a test. |
| **Not for** | **SAS Viya.** Its REST APIs and web applications are automated by the family's [`api`](../referenced-automation-api) and [`ui`](../referenced-automation-ui) packages with ordinary code; nothing here targets Viya. Also not for SAS administration through its own tools beyond what `src/process` wraps (a generic, unverified batch-tool runner). |

### The order of preference

Anything a command line or an API can do is done that way. The screens exist only for tests *about the screens* - and keep those few: they are slower, break when a screen changes, and need an unlocked interactive desktop.

| # | Route | Where | Use it for |
|---|---|---|---|
| 1 | **Command line** (batch tools, metadata calls) | `src/process` | Administration and checks that need no window at all |
| 2 | **COM** through the bridge | `SasEnterpriseGuide`, the `egCom` fixture, the `@eg-com` tag | Open, run, read the log, export, save: "run this project and check the result" |
| 3 | **Screens** (Windows UI Automation) | `SasManagementConsole`, `SasEnterpriseGuideUi`, the `smc` / `eg` fixtures, `@smc-ui` / `@eg-ui` | Tests about Management Console's and Enterprise Guide's own screens |

The decisions behind this are [ADR 0001](docs/adr/0001-sas-automation-architecture.md) and [ADR 0002](docs/adr/0002-record-and-play-for-sas-desktop-apps.md); every option that was considered is in [`docs/AUTOMATION_APPROACHES.md`](docs/AUTOMATION_APPROACHES.md).

## Quick start

```bash
./scripts/setup.sh      # npm ci + the Playwright browser (scripts/setup.bat on Windows)
npm test                # the whole suite, against the built-in stand-in desktop: no SAS, any OS
npm run try:simulator   # the worked examples, with what each one does printed first
```

`setup.sh` / `setup.bat` run `npm ci`. They first run `npm config set registry "$NPM_REGISTRY_URL"` when that variable is set, so every package - the `@automation/*` ones too (`utils`, `api`, `ui`), each **by the version in `package.json`** - is fetched from your organisation's npm registry. If those packages are not published there yet, or you want to try an unpublished change, run `./scripts/setup.sh --local` (`.\scripts\setup.bat --local` on Windows): it builds the sibling repos this one depends on (they must be checked out next to this one) into `../shared-packages` and installs those instead, without touching `package.json` or the lockfile. See [Publishing](#publishing-a-package-to-the-registry-jfrog-artifactory) and [Using a package without a registry](#using-a-package-without-a-registry-local-generation).

Then write a test:

```ts
import { desktopTest as test, desktopExpect as expect } from '@automation/referenced-automation-sas';

test('the User Manager lists a known user @sas-desktop @smc-ui @smoke', async ({ smc, smcLoggedOn }) => {
  void smcLoggedOn;                                  // asking for it logs the console on, through the logon guard
  await smc.openPlugin('User Manager');
  expect(await smc.findUser('sasdemo')).toBe('sasdemo');
});

test('run a project by COM and read its log @sas-desktop @eg-com', async ({ egCom, runContext }) => {
  await egCom.openProject(`C:\\Projects\\${runContext.ns('Sales')}.egp`);   // inside this run's namespace: see the safety rules
  const statuses = await egCom.runProject();
  expect(statuses.every((s) => s.status !== 'Error')).toBe(true);
});
```

[`examples/README.md`](examples/README.md) explains the three worked examples (`tests/examples/`), each line with the `.env` setting it uses.

## What is in the box

| Folder | What | Layer ([architecture](docs/ARCHITECTURE.md)) |
|---|---|---|
| `src/core` | Environments allow-list, safety policy, credentials, logon guard, audit log, run context, health gate, clean-up registry | Core: security and reliability |
| `src/process` | `ProcessDriver` (child process, no shell, argument arrays) and `BatchToolRunner` | Driver: command line |
| `src/desktop` | The PowerShell bridge client, UI Automation locators and assertions, COM client, `SasEnterpriseGuide`, `SasManagementConsole`, `SasEnterpriseGuideUi`, the stand-in desktop, `sas-desktop-inspect` | Driver and domain: COM and screens |
| `src/recorder` | The GUI recorder and the converters to Playwright tests ([`docs/RECORD_AND_PLAY.md`](docs/RECORD_AND_PLAY.md)) | Domain: record and play |
| `src/fixtures` | `desktopTest` and `desktopExpect`: the worker session, the pre-flight gate, the policy adapter, the app, logon, clean-up and evidence fixtures | Test layer |
| `src/bdd` | `registerDesktopSteps`: the Gherkin vocabulary | Test layer |
| `features/` | Sample features and the steps file for playwright-bdd | Test layer |
| `tests/` | The repo's own tests (`tests/examples` = the worked examples, `tests/real` = checks for a real machine) | |
| `bridge/` | `sas-desktop-bridge.ps1` and its pinned SHA-256 | |
| `env/` | `sas-environments.json` (declared environments) and its example | |

## Fixtures

`desktopTest` is Playwright's `test` (through the `ui` package's, so a test also has the scenario banner, a correlation id and `vars`) with these fixtures. Nothing starts until a test asks for it.

| Fixture | Scope | What it is |
|---|---|---|
| `desktopSession` | worker | The one connection to the desktop (PowerShell bridge, remote host or stand-in), after the **pre-flight gate** (`SAS_PREFLIGHT`, default on) |
| `environment`, `runContext` | worker | The selected SAS environment; the run id, its test namespace `AUTO_<runId>` and its evidence folder |
| `safetyPolicy`, `desktopGuard` | worker | The core policy and the adapter that plugs it into the desktop layer: every step is judged and audited |
| `fakeDesktop` | worker | The stand-in itself when `SAS_DESKTOP_SIMULATOR=true`, else `undefined` |
| `smcApp`, `egApp` | test | The program, launched (`SAS_SMC_PATH` / `SAS_EG_PATH`) or attached, **not** logged on |
| `smcLoggedOn`, `egLoggedOn` | test | The same program, logged on through the logon guard |
| `smc`, `eg` | test | The wrappers `SasManagementConsole`, `SasEnterpriseGuideUi` around those programs |
| `egCom` | test | The Enterprise Guide COM driver, connected |
| `cleanup` | test | Register what the test creates; it is undone after the test, pass or fail, while the program is still open |
| `vars` | test | The scenario's values and `{{placeholders}}`, plus `{{runId}}` and `{{namespace}}` |

- **One desktop is one worker.** Where a real desktop can be reached `playwright.config.ts` sets one worker, and the fixture refuses `--workers=4`. The stand-in has no such limit.
- **A rejected logon is typed once.** The logon guard writes a marker and refuses the same environment + program + user + password for `SAS_LOGON_FAILURE_COOLDOWN_MIN` minutes, so Playwright's retries, a CI re-run and the next test cannot lock the account. A logon happens once per **test** (each test gets its own program); keep the screen tests few.
- **Where no desktop can be reached the test is skipped with the reason**, never silently passed (`scripts/min-executed.js` counts the skips).
- **Evidence** (`SAS_EVIDENCE`): a screenshot and the step journal for a failed test by default; `on` after every test, `steps` after every step that may change something, `off` nothing. Screenshots go under the run's own folder, other runs' folders are pruned, and the bridge paints password fields black.

### Tags

| Tag | Meaning |
|---|---|
| `@sas-desktop` | Needs the SAS desktop layer (a Windows desktop, a remote host or the stand-in) |
| `@smc-admin` | Administration of SAS objects by command line / metadata calls - no window |
| `@smc-ui` | Management Console's screens |
| `@eg-com` | Enterprise Guide through COM |
| `@eg-ui` | Enterprise Guide's screens |
| `@smoke` / `@regression` | The quick critical journeys / the wider set (`npm run test:smoke`, `npm run test:regression`) |

## Gherkin

`features/*.feature` and `features/steps/` are generated into tests by `bddgen` (the npm scripts run it first) and run as the `bdd` project against the stand-in desktop. The step vocabulary lives in the package (`registerDesktopSteps`); its texts are a public contract (`tests/bdd/vocabulary.spec.ts`).

```gherkin
@sas-desktop @smc-ui @smoke
Feature: Management Console shows who and what an environment holds
  Background:
    Given SAS Management Console is open and I am logged on
  Scenario: The User Manager lists a known user
    When I open the "User Manager" plug-in
    Then the user "sasdemo" is listed

@sas-desktop @eg-com @smoke
Feature: Enterprise Guide projects run through the automation interface
  Scenario: Running the project reports each program
    Given SAS Enterprise Guide is available through its automation interface
    When I open the Enterprise Guide project "C:\Projects\{{namespace}}_Sales.egp"
    And I run the project
    Then the program "{{namespace}}_Program" finished without errors
```

Generic steps act by name or automation id (`I click the button named "OK"`, `I enter "x" in the field named "User ID:"`, `I switch to the window "SAS Logon"`), a secret is typed with `I enter the secret "SAS_PASSWORD" in the field named "Password:"` (the step gets the **name** of the setting and never echoes the value), and `I remember ... as "name"` stores values for `{{name}}` in later steps. There is deliberately no "I wait N seconds".

## Environments and configuration

Same pattern as the rest of the family: `.env.<ENV>` (committed, no secrets) selected by `ENV` (default `qa`), `.env.<ENV>.local` (git-ignored, **secrets**; template [`.env.local.example`](.env.local.example)), real environment variables on top. **[`.env.example`](.env.example) is the one authoritative reference**: for each variable it says what it is for, the valid values, the default, whether it is required, whether it is a secret and where to find the value in the SAS programs. The per-layer fragments the core, the desktop layer and the recorder started with were merged into it (the first two removed): `.env.example` wins.

Which SAS environments exist, their kind (`nonprod` or `prod`) and the hosts a driver may contact are declared in the committed `env/sas-environments.json` (shape and examples: [`env/sas-environments.json.example`](env/sas-environments.json.example)). An environment that is not declared is refused; production is read-only by construction.

## Configuration reference

Every environment variable this repo reads, in the order of [`.env.example`](.env.example) - which is the full reference. `tests/envDocs.spec.ts` fails when this table, `.env.example`, `.env.local.example` and the code disagree.

Settings are looked up in this order (the first one found wins): a real environment variable (PowerShell: `$env:NAME = "value"`, undo with `Remove-Item Env:NAME`) -> `.env.<ENV>.local` (git-ignored, **secrets**) -> `.env.<ENV>` (committed, no secrets) -> `.env`. `ENV` picks the files (default `qa`). A value with `#`, `$` or spaces must be in double quotes (`SAS_PASSWORD="my#pass word"`): an unquoted `#` starts a comment and cuts the password. A file named just `.env.local` is **not** read: use `.env.<ENV>.local`. The logger variables (`LOG_*`) are read from the real environment only.

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `ENV` | Which `.env.<ENV>` file (and `.env.<ENV>.local`) is loaded; the default of `SAS_ENVIRONMENT`. | qa | No | no |
| `SAS_ENVIRONMENT` | The SAS environment this run works against (must be declared in the environments file). | `ENV`; with the stand-in: `simulator` | No | no |
| `SAS_SMC_PATH` | Full path of `sasmc.exe`, to launch Management Console. | (none) | To launch it | no |
| `SAS_SMC_PROFILE` | The metadata profile Management Console connects to, as its dialog lists it. | (none) | When the console asks | no |
| `SAS_EG_PATH` | Full path of `SEGuide.exe`, to launch Enterprise Guide for the screen tests. | (none) | To launch it | no |
| `SAS_EG_PROFILE` | The Enterprise Guide server profile to activate, as it lists it. | (none) | To pin a server | no |
| `SAS_USER` | The SAS user name, for every program without its own `SAS_<APP>_USER`. | (none) | To log on | no |
| `SAS_PASSWORD` | The password of `SAS_USER`. A wrong one counts towards the account lockout. | (none) | To log on | **yes** |
| `SAS_ENVIRONMENTS_FILE` | The committed JSON file declaring each environment's kind (nonprod / prod) and host allow-list. | `env/sas-environments.json` | Yes, for a real run | no |
| `SAS_ALLOW_PROD_READS` | Allows reads (never changes) against a `prod` environment. | false | No | no |
| `SAS_ALLOW_OUTSIDE_NAMESPACE` | Lets a run change objects outside its `AUTO_<runId>` namespace (needs a reason; audited). | false | No | no |
| `SAS_ALLOW_OUTSIDE_NAMESPACE_REASON` | Why the run may leave its namespace (written to the audit log). | (none) | With the override | no |
| `SAS_NAMESPACE_PATTERN` | The test namespace pattern (`{runId}` filled in per run). | `AUTO_{runId}` | No | no |
| `SAS_RUN_ID` | The id of the run (namespace, audit file, evidence folder). | generated | No | no |
| `SAS_PREFLIGHT` | Run the pre-flight health gate once per worker. | true | No | no |
| `SAS_PREFLIGHT_TIMEOUT_MS` | Time limit of one pre-flight check. | 10000 | No | no |
| `SAS_<APP>_USER` | A login for one program (`SAS_SMC_USER`, `SAS_EG_USER`), replacing `SAS_USER` for it. | (none) | No | no |
| `SAS_<APP>_PASSWORD` | The password for `SAS_<APP>_USER` (`SAS_SMC_PASSWORD`, `SAS_EG_PASSWORD`). | (none) | With `SAS_<APP>_USER` | **yes** |
| `SAS_LOGON_FAILURE_COOLDOWN_MIN` | Minutes the same rejected logon is refused without contacting SAS. | 15 | No | no |
| `SAS_STATE_DIR` | Folder for the logon-failure marker and the created-objects list. | `.sas-state` | No | no |
| `SAS_APP_MODE` | How the app fixtures get their program: `launch`, `attach` or `auto`. | auto | No | no |
| `SAS_EG_PROGID` | The exact COM class of Enterprise Guide's object model (carries the version). | discovered | No | no |
| `SAS_COM_PROGIDS` | The COM classes the bridge may create (allow-list). | `SASEGObjectModel.Application.*,SASObjectManager.*` | No | no |
| `SAS_TOOL_DIRS` | Folders command-line tools may be run from (never PATH). | (none) | To run a tool by name | no |
| `SAS_CHILD_ENV_ALLOW` | Variables a command-line tool inherits (everything else is removed). | PATH, SystemRoot, TEMP, ... (see file) | No | no |
| `SAS_PROCESS_TIMEOUT_MS` | Default time limit of one command-line tool run. | 120000 | No | no |
| `SAS_PROCESS_MAX_OUTPUT_BYTES` | Most output kept per stream of a tool run. | 1048576 | No | no |
| `SAS_BATCH_TOOLS_FILE` | JSON file with the option tables of the command-line tools. | (none) | For the BatchToolRunner | no |
| `SAS_DESKTOP_TRANSPORT` | How the desktop is reached: `powershell` (this machine) or `remote` (a remote desktop host). | powershell | No | no |
| `SAS_DESKTOP_POWERSHELL` | The PowerShell that runs the bridge (the 32-bit one for an old Enterprise Guide). | powershell.exe | For 32-bit EG | no |
| `SAS_DESKTOP_SCRIPT_DIR` | Folder with an approved (signed) copy of the bridge script. | (none) | Where unsigned scripts must not run | no |
| `SAS_DESKTOP_REMOTE_BRIDGE_FILE` | With `remote`: an approved bridge script that lives on the remote host. | (none) | No | no |
| `REMOTE_ENABLED` | Turns the remote desktop client on (utils package). | false | With `remote` | no |
| `REMOTE_RDP_HOST` | The remote desktop host. | (none) | With `remote` | no |
| `REMOTE_RDP_PORT` | The RDP port of the host. | 3389 | No | no |
| `REMOTE_RDP_USER` | The Windows login on the remote host. | (none) | With `alternate-shell` | no |
| `REMOTE_RDP_PASSWORD` | The Windows password on the remote host. | (none) | With `alternate-shell` | **yes** |
| `REMOTE_RDP_DOMAIN` | The Windows domain of `REMOTE_RDP_USER`. | (none) | No | no |
| `REMOTE_SHARE_DIR` | Mailbox folder shared with the RDP session. | `.remote-mailbox` | No | no |
| `REMOTE_AGENT_START` | How the remote agent is started. | alternate-shell | No | no |
| `REMOTE_ALLOW` | Capabilities the remote agent may be asked for; the bridge needs `sap`. | http,db,sap | No | no |
| `SAS_EVIDENCE` | When screenshots and the step journal are kept: `off`, `failure`, `on` or `steps`. | failure | No | no |
| `SAS_EVIDENCE_DIR` | Folder for each run's evidence (`<folder>/<runId>/`). | `test-results/sas-evidence` | No | no |
| `SAS_EVIDENCE_RETENTION_DAYS` | Days another run's evidence folder is kept. | 7 | No | no |
| `SAS_DESKTOP_EVIDENCE` | Desktop-layer evidence: `steps` adds a screenshot after every changing step (`SAS_EVIDENCE=off` wins). | off | No | no |
| `SAS_DESKTOP_EVIDENCE_DIR` | Evidence folder of a session opened outside the fixtures. | `test-results/sas-desktop-evidence` | No | no |
| `SAS_DESKTOP_TIMEOUT_MS` | How long one UI step waits for its control. | 30000 | No | no |
| `SAS_DESKTOP_REQUEST_TIMEOUT_MS` | Backstop for one request to the bridge. | 60000 | No | no |
| `SAS_ASSERT_TIMEOUT_MS` | How long an assertion step keeps re-checking. | 5000 | No | no |
| `WORKERS` | Parallel workers (forced to 1 where a real desktop is in reach). | Playwright's | No | no |
| `RETRIES` | Test retries (a rejected logon is never repeated). | 0 (1 on CI) | No | no |
| `TEST_TIMEOUT_MS` | Time limit of one test. | 60000 | No | no |
| `EXPECT_TIMEOUT_MS` | Default time of Playwright's own assertions. | 10000 | No | no |
| `LOG_LEVEL` | Shared logger level (real environment only). | info | No | no |
| `LOG_TO_FILE` | Write the log to a file too. | true | No | no |
| `SAS_CLEANUP_FAILURE` | What a failed clean-up does to its test: `fail` or `warn`. | fail | No | no |
| `SAS_CLEANUP_TIMEOUT_MS` | Longest one clean-up may run. | 60000 | No | no |
| `SAS_CLEANUP_GRACE_MS` | Grace time of a clean-up that was asked to stop. | 10000 | No | no |
| `SAS_AUDIT_FILE` | The audit log file (one JSON line per privileged action). | `test-results/sas-audit/audit-<runId>.jsonl` | No | no |
| `SAS_AUDIT_KEEP_RUNS` | Audit files kept in the default folder. | 20 | No | no |
| `SAS_RECORDER_DIR` | Where recordings are written. | `recordings` | No | no |
| `SAS_RECORDER_STOP_KEY` | The key chord that ends a recording. | Ctrl+Alt+Q | No | no |
| `SAS_RECORDER_POLL_MS` | How often the recorder collects events. | 200 | No | no |
| `SAS_RECORDER_MAX_QUEUE` | Events the bridge keeps between two collections. | 5000 | No | no |
| `SAS_RECORDER_MODE` | What is recorded: `full` or `uia`. | full | No | no |
| `SAS_RECORDER_SECRET_PATTERNS` | Extra patterns that mark a field as a secret. | (none) | No | no |
| `SAS_PIN` | What a converted test reads instead of a recorded PIN. | (none) | For such recordings | **yes** |
| `SAS_OTP` | What a converted test reads instead of a recorded one-time code. | (none) | For such recordings | **yes** |
| `SAS_TOKEN` | What a converted test reads instead of a recorded token. | (none) | For such recordings | **yes** |
| `SAS_SECRET` | What a converted test reads instead of a recorded secret. | (none) | For such recordings | **yes** |
| `SAS_API_KEY` | What a converted test reads instead of a recorded API key. | (none) | For such recordings | **yes** |
| `SAS_DESKTOP_SIMULATOR` | Use the built-in stand-in desktop (any OS). | false | No | no |
| `SAS_REAL_TESTS` | Run the tests of the real SAS programs (`tests/real`); set by `npm run test:conformance` / `test:real-smoke`, not by hand. Without it a plain `npm test` never opens the real programs. | false | No | no |
| `SAS_TEST_NODE_LAUNCH` | Tests of this repo only: start the fake command-line tool through `node` (what Windows needs; `1` takes that route on any system). | (unset) | No | no |
| `MIN_EXECUTED` | The least number of tests that must have run (`scripts/min-executed.js`). | 1 | No | no |
| `NPM_REGISTRY_URL` | The npm registry the setup scripts use. | (npm's own) | No | no |
| `USE_LOCAL_PACKAGES` | Install the sibling packages locally instead of from the registry. | (unset) | No | no |
| `BRIDGE_JUNK` | Stand-in bridge fault: print a junk line first. | false | Tests only | no |
| `BRIDGE_NO_READY` | Stand-in bridge fault: never ready. | false | Tests only | no |
| `BRIDGE_DELAY_OPS` | Stand-in bridge fault: late answers. | (none) | Tests only | no |
| `BRIDGE_HANG_OPS` | Stand-in bridge fault: a hung operation. | (none) | Tests only | no |
| `BRIDGE_CRASH_OP` | Stand-in bridge fault: crash on an operation. | (none) | Tests only | no |
| `BRIDGE_CLOSE_STDIN` | Stand-in bridge fault: stdin closed. | false | Tests only | no |
| `BRIDGE_SESSION_LOST_OP` | Stand-in bridge fault: SESSION_LOST on an operation. | (none) | Tests only | no |

## Safety rules

Every step of every driver, the screens included, passes the same gate and leaves a line in the audit log (`test-results/sas-audit/audit-<runId>.jsonl`). A refusal changes nothing in SAS. The reasons are in [`docs/SECURITY.md`](docs/SECURITY.md).

| Rule | What it means |
|---|---|
| **Declared environments only** | An environment that is not in `env/sas-environments.json`, or a host that is not on its list, is refused (`unknown-environment`, `host-not-allowed`). The desktop programs reach SAS through their own saved profiles, so for their steps the host list cannot be enforced; the environment kind, the namespace rule and the audit log are |
| **Production is read-only** | Create / update / destructive in a `prod` environment is refused (`prod-read-only`); nothing overrides it. Reads need `SAS_ALLOW_PROD_READS=true` (`prod-reads-disabled`). The programs a test started are still closed at its end |
| **Change only your own objects** | A mutating step must name an object inside the run's namespace `AUTO_<runId>_...` (`outside-namespace`): running an Enterprise Guide project or program, exporting into a folder, creating anything. `SAS_ALLOW_OUTSIDE_NAMESPACE=true` with a written `SAS_ALLOW_OUTSIDE_NAMESPACE_REASON` lifts only that rule, is logged and marks the audit record |
| **A raw click names a control, not an object** | A raw UI step (click, fill, press) is not judged on the namespace - it is still refused in production. Raw COM calls are not exempt: fail closed |
| **A rejected password is typed once** | The same logon is refused without contacting SAS for `SAS_LOGON_FAILURE_COOLDOWN_MIN` minutes (default 15); the pre-flight gate reports an active cooldown before the first test |
| **No secret is ever echoed** | Passwords are held privately, typed through a flagged command, masked in logs, audit records, errors, step journals and step titles; password fields are painted black in screenshots |
| **One desktop, one worker** | A real desktop with more than one worker is refused |
| **Clean up what you create** | Register it with `cleanup`; it is undone after the test, pass or fail; a failed clean-up fails the test (`SAS_CLEANUP_FAILURE=warn` only annotates it) |
| **The bridge script is verified** | Its SHA-256 is pinned; an edited or stale copy is refused. After a reviewed change run `npm run bridge:hash` (the build does it) and commit both files |

## Windows first run (PowerShell, from zero to your first test)

For a Windows machine (an AWS WorkSpace, a laptop) with the SAS programs and VS Code. Commands are PowerShell: run them in the VS Code terminal (**Terminal > New Terminal**, the shell must say `PowerShell`). The longer walk-through is [`docs/WINDOWS_FIRST_RUN.md`](docs/WINDOWS_FIRST_RUN.md).

In PowerShell an environment variable is set with `$env:NAME = "value"` and removed with `Remove-Item Env:NAME`; `set NAME=value` (cmd.exe) does nothing there. Inside this repo the tools run through npm - the `npx sas-desktop-inspect` name exists only in projects that depend on this package.

1. **Install** (once). Node 18+ (`node -v`) and the SAS programs. In the repo folder:
   ```powershell
   .\scripts\setup.bat            # npm ci + the Playwright browser; add --local when the sibling repos are checked out next to this one
   ```
   `'tsc' is not recognized` later means this step did not run (no `node_modules` folder). `setup.bat` runs `npm config set registry` when `NPM_REGISTRY_URL` is set.
2. **Build and check the machine:**
   ```powershell
   npm run build
   npm run doctor
   ```
   `doctor` checks, in order: the bridge script is the one this version ships, PowerShell starts the bridge, the session is interactive and unlocked, UI Automation works, the Java Access Bridge (below), the program paths, and the Enterprise Guide COM class. Fix what it says from the top.
3. **See what the programs look like to the automation.** Start the program (Management Console logged on), then:
   ```powershell
   npm run inspect -- --app smc            # or --app eg, or --app "<window title regex>", --depth 8 for more
   ```
   Every control is printed with its name, automation id and a ready-to-paste locator. The LOCATORS tables (`SMC_LOCATORS` in `src/desktop/apps/managementConsole.ts`, `EG_UI_LOCATORS` in `src/desktop/apps/enterpriseGuideUi.ts`, `EG_COM` in `src/desktop/apps/enterpriseGuide.ts`) are best guesses (NOT VERIFIED): fix what `inspect` shows differs.
4. **Say where SAS is.** Edit `.env.qa` (remove the `# ` of the lines you need): `SAS_SMC_PROFILE`, `SAS_EG_PROFILE`, `SAS_SMC_PATH`, `SAS_EG_PATH`, `SAS_USER`. Declare the environment - its kind and hosts - in `env/sas-environments.json` (copy from `env/sas-environments.json.example`). Put the password only in the git-ignored secrets file:
   ```powershell
   Copy-Item .env.local.example .env.qa.local     # then edit it: SAS_PASSWORD="your password"  (double quotes!)
   ```
   **Log on by hand with exactly these values first.** A wrong password counts towards the account's lock limit. After a rejected logon the framework refuses to repeat it for `SAS_LOGON_FAILURE_COOLDOWN_MIN` minutes (15).
5. **Run the examples on the stand-in** - no SAS needed, to see what a green run looks like:
   ```powershell
   npm run try:simulator
   ```
6. **Run the real programs.** Forward slashes in test paths (a backslash gives `No tests found`). Conformance first (no login, nothing is changed), then the read-only smoke tests:
   ```powershell
   npx playwright test tests/real/conformance.spec.ts
   npm run test:real-smoke
   ```
   Select one test by title with `-g`: `npx playwright test -g "User Manager"`.
7. **Look at the report:** `npx playwright show-report` opens `playwright-report/index.html`. A failed test has a screenshot, the step journal (`desktop-steps`) and a message that says what is on the screen when a control is missing.

**Java Access Bridge for Management Console.** Management Console is a Java Swing program: Windows UI Automation sees its controls **only when the Java Access Bridge is enabled**. Find `jabswitch.exe` in the `bin` folder of the Java the console uses (typically below `SASHome\SASPrivateJavaRuntimeEnvironment\9.4\jre\bin`; `npm run doctor` prints what it found), run `jabswitch -enable` in a command prompt, then **close and restart the console**. The symptom of a disabled bridge is a console window with no controls for the tests (`doctor`: "a Java window whose UI Automation tree is empty").

**The interactive desktop.** UI Automation, mouse and keyboard input and screenshots need a logged-in, unlocked, connected desktop of the same user and elevation as the program under test. A locked workstation, a disconnected RDP session or a service makes UI steps fail with `SESSION_LOST`. Use one worker. The COM route needs no visible screen, but Enterprise Guide still starts in your session. For a remote desktop host see `SAS_DESKTOP_TRANSPORT=remote` in `.env.example`.

If a logon fails, **do not run again** until the credentials are fixed: SAS locks the account after a few wrong logons.

### Troubleshooting

The exact messages people saw (more in [`docs/DESKTOP_SAS.md`](docs/DESKTOP_SAS.md#troubleshooting) and [`docs/WINDOWS_FIRST_RUN.md`](docs/WINDOWS_FIRST_RUN.md)):

| You see | Cause | Do this |
|---|---|---|
| `'tsc' is not recognized as an internal or external command` (and there is no `node_modules` folder) | the install did not run or failed | `.\scripts\setup.bat` (`.\scripts\setup.bat --local` without a registry), read its first error |
| `Cannot find module '...\dist\desktop\cli\inspect.js'` | the project was not built | `npm run build` first |
| `Illegal characters in path` for `*.tgz` (from `npm run clean`, `create-package`) | an old clean script passed the pattern `*.tgz` to the OS; fixed (`rimraf --glob`) | update to the current version of the repo |
| `No tests found` | a Windows path with backslashes after `playwright test` | `npx playwright test tests/real/smoke.spec.ts` (forward slashes) or `-g "<part of the title>"` |
| `error TS5108: Option 'moduleResolution=node10' has been removed` in `tsconfig.json` | TypeScript 7 removed `moduleResolution: "node"` (nothing to do with the Node.js version) | `tsconfig.json` uses `"module": "node16"` and `"moduleResolution": "node16"` (same compiled output): update the repo, or change those two lines by hand |
| `The SAS desktop programs run on Windows: this test was skipped, not run` | started on macOS or Linux without the stand-in | use a Windows machine, `SAS_DESKTOP_TRANSPORT=remote`, or `SAS_DESKTOP_SIMULATOR=true` |
| `N of M pre-flight check(s) are red; no test was started.` | the gate found a problem before the first test | read the table and the "what to do" line of each red check; `SAS_PREFLIGHT=false` only to see one test fail on its own |
| `REFUSED by safety policy rule "unknown-environment"` | the environment is not in `env/sas-environments.json` | declare it (kind and hosts), or set `SAS_ENVIRONMENT` to a declared name |
| `REFUSED by safety policy rule "outside-namespace"` | the step would change something not named `AUTO_<runId>_...` (for example running an existing project) | name test objects with `run.ns(...)`, or deliberately set `SAS_ALLOW_OUTSIDE_NAMESPACE=true` with `SAS_ALLOW_OUTSIDE_NAMESPACE_REASON` |
| `REFUSED by safety policy rule "prod-read-only"` | a change was attempted in a `prod` environment | run it against a nonprod environment: nothing allows changes in production |
| `logon NOT attempted - it would have repeated a logon that smc in "..." has just rejected` | the logon guard: the same credentials failed less than `SAS_LOGON_FAILURE_COOLDOWN_MIN` minutes ago | change the credentials (clears it), or delete `.sas-state\logon-failed.json`, or wait |
| `rejected the logon of <user> on profile "..."` (`LogonRejected`) / `rejected the credentials of "<user>"` | wrong `SAS_USER` / `SAS_PASSWORD` (an unquoted `#` in the password cuts it), or a locked account | fix them in `.env.<ENV>.local` (password in double quotes), log on by hand once; do not re-run first |
| `asks for a profile but none is configured` | the program shows a profile list and `SAS_SMC_PROFILE` / `SAS_EG_PROFILE` is not set | set it to the name exactly as the dialog lists it |
| `... is not the bridge script this version of the framework ships` | the script was edited or is out of date | restore it; after a reviewed change `npm run bridge:hash` and commit both files |
| `SESSION_LOST: the desktop is locked or the session is disconnected` | locked workstation or disconnected RDP | keep the session connected and unlocked; `npm run doctor` shows it |
| `(none found - for a Java application check the Java Access Bridge)` | the Java Access Bridge is not enabled for the console's Java | `jabswitch -enable`, then **restart** the console |
| `the COM class "SASEGObjectModel.Application.x.y" is not registered` | wrong version in the name, Enterprise Guide missing, or a 32-bit Enterprise Guide with the 64-bit PowerShell | `npm run doctor`; set `SAS_EG_PROGID`; set `SAS_DESKTOP_POWERSHELL` to the 32-bit PowerShell |
| `Unknown name: Foo` from a COM call | a member name in `EG_COM` differs in your Enterprise Guide version | fix `EG_COM` (the unverified part) |
| `no control matched ...` followed by `On the screen now` | a LOCATORS entry does not match this SAS version, or the control is behind a dialog | compare with `npm run inspect`; fix the table |
| `N workers with a real SAS desktop` | `--workers=N` or `WORKERS` with a real desktop | `--workers=1`, or `SAS_DESKTOP_SIMULATOR=true` for the stand-in |

## Try it without SAS

`SAS_DESKTOP_SIMULATOR=true` (or the `desktopSimulator` option) starts a stand-in desktop with a fake Management Console, a fake Enterprise Guide and a fake Enterprise Guide COM object model, declared as the `simulator` environment with its own demo login. The examples, the sample features and the whole suite run on it:

```bash
npm run try:simulator           # the four worked examples, with what each does printed first
npm run try:simulator -- 02_    # one example
npm test                        # everything
```

It proves the framework's flows - waiting, retries, the policy, the logon guard, clean-up - **not** that SAS looks like this. The stand-in brings its own programs, profiles and demo login: what you configured for the real programs (`SAS_ENVIRONMENT`, the paths and profiles, the logins) is **ignored** while it is in use - a real password is never typed into a fake, and the tests behave the same on every machine. A test can supply them on purpose through the `sasSettings` option. For the duration of each test the fixtures put the stand-in's own login and profile names into `SAS_USER`, `SAS_PASSWORD`, `SAS_SMC_PROFILE` and `SAS_EG_PROFILE` (and put the environment back), so a converted recording that reads them works unchanged.

## Operating systems

Windows, macOS and Linux. Everything runs on all three except the real SAS programs: they are reached through Windows UI Automation and COM, so they need Windows (or `SAS_DESKTOP_TRANSPORT=remote` pointing at a Windows host); elsewhere those tests are skipped with the reason. `npm run doctor` prints what works on the machine it runs on. Details, the status of each system (Windows is NOT VERIFIED) and the rules for new code: [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Tests of this repo

| Command | What it runs |
|---|---|
| `npm test` | Everything on the stand-in (`bddgen`, then Playwright). The tests of the real programs (`tests/real`) are skipped with the reason on every system, Windows included: they run only when asked for (below) |
| `npm run test:bdd` | The Gherkin features only (parallel workers; ends with the minimum-executed gate) |
| `npm run test:smoke` / `npm run test:regression` | The `@smoke` / `@regression` tagged tests |
| `npm run test:ci` | What the pipeline runs: everything, then `scripts/min-executed.js`: the run **fails when fewer tests executed than expected** and prints how many were skipped and why |
| `npm run test:conformance` | **Real machine, on purpose:** the checks that need no login (`tests/real/conformance.spec.ts`); sets `SAS_REAL_TESTS=true` |
| `npm run test:real-smoke` | **Real machine, on purpose:** log on, look, leave (`tests/real/smoke.spec.ts`; read-only); sets `SAS_REAL_TESTS=true` |
| `npm run try:simulator` | The worked examples on the stand-in |
| `npm run doctor`, `npm run inspect -- --app smc`, `npm run inspect:windows`, `npm run bridge:path` | Check the machine; print what a program looks like to the automation; list the open windows; print where the bridge script is and the SHA-256 it must have |
| `npm run lint`, `npm run typecheck`, `npm run security` | The gates |

`SAS_DESKTOP_SIMULATOR=true npm run test:conformance` runs the real-machine checks against the stand-in, to show that the checks themselves work.

## Record and play

[`docs/RECORD_AND_PLAY.md`](docs/RECORD_AND_PLAY.md) (ADR 0002): record what a person does in Management Console or Enterprise Guide and convert it to a test with `CONSTANTS` and `LOCATORS`; the settings are in section 10 of [`.env.example`](.env.example). A recording never contains a password.

## Pipeline

[`.gitlab-ci.yml`](.gitlab-ci.yml): `build` (typecheck, lint, bridge-hash check) -> `test` (the whole suite on the Linux image against the stand-in, with the minimum-executed gate) and `security` (non-blocking until its first green run) -> `audit` (manual) and `pages`. Two **manual** templates for a Windows runner - `sas-desktop-conformance` and `sas-desktop-smoke` - run `npm run doctor` and the real-program tests; their runner tag is a placeholder and they are NOT VERIFIED.

## Allure reporting

Every test run writes raw results to `allure-results/` via the `allure-playwright` reporter. Turning those into the viewable HTML report needs a JRE on `PATH` (Allure's report generator is a Java tool), so it is a separate step:

```bash
npm test               # also writes allure-results/
npm run allure:report  # generates allure-report/ and opens it in a browser
```

## Publishing a package to the registry (JFrog Artifactory)

The other repos install `@automation/referenced-automation-sas` **by version** from your organisation's npm registry, so each new version has to be published there. In order:

1. **Know the registry URL.** It is the npm registry URL of your Artifactory - the one in your `~/.npmrc` and in the `NPM_REGISTRY_URL` CI/CD variable. This repo never hard-codes it.
2. **Be allowed to publish.** Publishing needs an npm identity with deploy permission on that repository; the scripts in this repo never log in for you.
3. **Choose the version and record it.** A version can be published only once: `npm version patch --no-git-tag-version` (or minor / major), add the change to `CHANGELOG.md`, commit both.
4. **Point the scripts at the registry** (once per terminal): `export NPM_REGISTRY_URL="<your registry URL>"` (PowerShell: `$env:NPM_REGISTRY_URL = "<your registry URL>"`).
5. **Publish** - a dry run first: `./scripts/publish-package.sh --dry-run`, then `./scripts/publish-package.sh` (Windows: `scripts\publish-package.bat`). The script runs `npm config set registry`, builds with `create-package.sh` (clean, build, `npm pack`) and runs `npm publish`.
6. **Check it arrived:** `npm view @automation/referenced-automation-sas versions --registry "$NPM_REGISTRY_URL"`.

**Order matters.** Publish what a package depends on first: `utils` -> `api` and `ui` -> `sas`.

## Upgrading a package: change one version

This repo lists the `@automation/*` packages it uses in `package.json` with a version range. To take a newer version, **change that number** (say `"^1.3.0"`), run `npm install`, run the tests and commit `package.json` and `package-lock.json`. `npm ci` installs exactly what the lockfile records, so a version only changes when someone commits a change. A package that is itself depended on must be published again before its consumers can ask for the new version.

## Using a package without a registry (local generation)

Use this when the packages are not in a registry yet, or you want to try a change before publishing it. Nothing in `package.json` or the lockfile changes.

**Automatic - when the repos are checked out next to each other:** `./scripts/setup.sh --local` (Windows: `.\scripts\setup.bat --local`). It builds the sibling repos this one depends on with their own `scripts/create-package.sh --local`, keeps the `.tgz` files in `../shared-packages` and installs them.

**Manual:** generate a tarball of each package in that package's own repo (`(cd ../referenced-automation-utils && ./scripts/create-package.sh --local)`, likewise `api` and `ui`; each lands in `../shared-packages`), then install them all in one command with `npm install --no-save ../shared-packages/automation-referenced-automation-utils-<version>.tgz ...`. `--no-save` keeps `package.json` and the lockfile unchanged; run it again after every `npm ci`. Run `npm ci` to go back to what the registry provides.

## IDE setup

Same as the other repos in this family: VS Code prompts for recommended extensions on open; the shared settings and the debug configurations are committed.

## What has and has not been verified

Verified here (macOS, no Windows, no SAS), all against the stand-in desktop: the policy gate and its adapter (every rule, with negative controls), the logon guard (a rejected logon typed once, refused afterwards, cleared by a changed password), the pre-flight gate, the fixtures (apps launched and closed, clean-up after pass and fail, evidence per mode, one worker), the Gherkin vocabulary and its steps, the worked examples, the configuration reference against the code, the audit log, the secrets handling, and the transports through a stand-in bridge program speaking the real line protocol.

**Not verified until it runs on a Windows machine with the real programs** (labelled NOT VERIFIED where described): the PowerShell bridge itself (it is checked only as text), every window title, control name and automation id in the LOCATORS tables, the Enterprise Guide object model's member names (`EG_COM`), the Java Access Bridge behaviour, that `sasmc.exe` and `SEGuide.exe` behave as the stand-in assumes, that the saved profiles reach the environments they are named after, and every SAS tool option. Run `npm run doctor`, then `npx playwright test tests/real/conformance.spec.ts`, then `npm run test:real-smoke`, and report anything the doctor or a failure message does not explain.

Known limits: one program per test (each test launches and logs on its own); the host allow-list cannot be enforced for the desktop programs (they connect through saved profiles); a program that was launched and left with no window is not killed by `dispose()`; the Management Console helpers (`listUsers`, `serverStatus` ...) are best effort - where a batch tool or metadata call can answer the question, use it.
