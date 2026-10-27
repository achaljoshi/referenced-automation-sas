# Operating systems

The package runs on **Windows, macOS and Linux**. One part of it - the real SAS programs - can only be reached from Windows, because
Management Console and Enterprise Guide are driven through Windows UI Automation and Windows COM objects. Everywhere else the tests
that need them are **skipped with the reason** (and counted by the minimum-executed gate), or reach a Windows machine remotely.

`npm run doctor` prints this table for the machine it runs on. On a system that cannot reach a Windows desktop it says so and exits 0: the command-line half works there, and only `doctor` on the Windows machine can check the desktop half.

| What | Windows | macOS / Linux | Notes |
|---|---|---|---|
| Policy gate, logon guard, audit log, clean-up, run context | yes | yes | Pure Node |
| Command-line tools (batch tools, `sas`) through the process driver | yes | yes | See "Command-line tools" below |
| Recorder converter, Enterprise Guide script importer | yes | yes | They read files and write TypeScript |
| The built-in stand-in desktop (`SAS_DESKTOP_SIMULATOR=true`) | yes | yes | Runs the whole suite with no SAS installed |
| Real Management Console and Enterprise Guide (UI Automation, COM) | yes | **no** | Unless `SAS_DESKTOP_TRANSPORT=remote` points at a Windows host |
| The recorder (capturing what a person does) | yes | **no** | It records through UI Automation. Against the stand-in it works on any system |

## Command-line tools

- **Windows:** a bare tool name is looked up in `SAS_TOOL_DIRS` with `.exe` and `.com` tried. A `.bat` or `.cmd` file is refused: it can only run through a shell, and the driver never uses one. Call the program the batch file calls.
- **macOS / Linux:** a tool is an executable file or script (with a shebang) in `SAS_TOOL_DIRS`; a tool folder that anybody can write to is reported by `health()`.
- **Both:** the arguments are an array, the child gets only the variables in the allow-list, and a timeout ends the whole process tree (`taskkill /T /F` on Windows, the process group elsewhere).
- Paths **inside SAS** (a project on the SAS machine, `C:\Projects\...`) are Windows paths whatever the system the tests run on; the code handles them with `path.win32` where it must.

## Reaching Windows from another system

Set `SAS_DESKTOP_TRANSPORT=remote` and the remote desktop settings in section 7 of `.env.example`: the tests run on the Linux or macOS machine, and the bridge runs in a Windows session through the shared mailbox drive. This is the same utility the other repos of the family use.

## What has been checked, and where

| System | Status |
|---|---|
| macOS | The whole suite runs here (the development machine). |
| Linux | The pipeline's `test` job runs the whole suite on a Linux image. |
| Windows | **NOT VERIFIED.** The code is written for it (the process driver, the bridge, `path.win32` handling, LF line endings for every text file in `.gitattributes`, POSIX-only tests skipped with a reason) and the Windows branches are tested with a fake platform, but the suite has not been run on Windows by the author. Run `npm run test:ci` on a Windows machine, or the manual `test-windows` job, and send the failures. It is safe on a machine that has SAS: see the next section. |

## Running the suite on a Windows machine that has SAS

`npm test` and `npm run test:ci` run the suite against the **stand-in desktop**; they do not open Management Console or Enterprise Guide and do not type a login. The tests under `tests/real` - the only ones that would - are skipped with the reason unless you ask for them on purpose:

| To | Run |
|---|---|
| Check the machine (changes nothing) | `npm run doctor` |
| The real-program checks that need no login | `npm run test:conformance` |
| Log on, look, leave (read-only; uses your login, once - a rejected logon is never retried) | `npm run test:real-smoke` |

Both set `SAS_REAL_TESTS=true` for their own run through `scripts/run-real.js`, which works the same in PowerShell, cmd and sh. A new spec file under `tests/real` must ask for that opt-in or `tests/optInForRealTests.spec.ts` fails.

How the Windows-only differences are tested without Windows:

- Windows branches take the platform as a parameter (`resolveTool(..., { platform: 'win32' })`, `killProcessTree(pid, grace, 'win32')`, `canRunDesktop(settings, platform)`), so macOS and Linux exercise them with a fake platform.
- The tests that start the fake tool by its bare name (a script cannot be started like that on Windows) start it as `node <script>` on Windows. `SAS_TEST_NODE_LAUNCH=1 npm test` takes that same route on any system.

## Rules for new code

1. A call that exists only on Windows goes behind a platform check that returns a clear message and a skip reason - never a stack trace.
2. No shell strings: `child_process` with an argument array. No `rm`, `ls`, `cp`, `/tmp`, `$HOME`; use `fs`, `os.tmpdir()`, `os.homedir()`.
3. Join paths with `path`; paths on the SAS machine are `path.win32`.
4. A test that needs a POSIX feature (a signal, a mode bit, a symbolic link) says so with `test.skip(process.platform === 'win32', '<reason>')`.
5. Text files are LF in the repository (`.gitattributes`); only `.bat` files are CRLF.
6. One rule decides whether a desktop can be reached (`reachesRealDesktop` / `reachesDesktop` in `src/desktop/platform.ts`); the test gate, the worker plan and `doctor` all call it. Do not write the check again.

Rules 1 and 2 are enforced by `tests/portability.spec.ts` (it scans `src/`; an exception goes in its `ALLOWED` table with a reason). The other rules are for review.
