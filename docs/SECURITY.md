# Security model of the SAS automation core

For a security reviewer. Covers `src/core` (policy, credentials, logon guard, audit, clean-up, health gate) and `src/process` (the command-line driver). The design decisions are in [ADR 0001](adr/0001-sas-automation-architecture.md); every setting is documented in `.env.example` (the one authoritative reference; `tests/envDocs.spec.ts` keeps it in step with the code).

**Principle.** Anything a command-line tool or a COM object can do is done that way: the command-line and COM routes come first. GUI automation (UI Automation against SAS Management Console or Enterprise Guide) exists only for tests about the GUI itself or tasks with no API. Every route, GUI included, passes the same gate below.

**What this protects against.** A test run that (1) changes or deletes something it did not create, (2) acts on the wrong system (production, an unlisted host), (3) locks a personal account by repeating a rejected logon, (4) leaks a password into a log, report, audit record, error message or child process, (5) leaves test objects behind, (6) runs a tool other than the one intended.
**What it does not protect against.** A developer who edits the policy code or the committed environments file (that is what code review is for); malware on the machine; the permissions the SAS account itself holds (use a least-privilege test account); a SAS tool that echoes a secret in a form we cannot recognise.

## Credentials
- A personal login is read through the shared config from `SAS_USER` / `SAS_PASSWORD`, or per application (`SAS_SMC_USER` / `SAS_SMC_PASSWORD`, `SAS_EG_USER` / `SAS_EG_PASSWORD`), in `.env.<ENV>.local` (git-ignored) or a masked CI variable. The secret scanner and `.gitignore` keep them out of the repository. User and password are always taken **as a pair** from one source; a half-set override is an error (a mixed pair would be a wrong logon).
- The `Credentials` object keeps the password in a private field: it does not appear in `JSON.stringify`, `console.log`, `util.inspect`, spread, `Object.keys` or `structuredClone`. The only way out is the explicit `reveal()`, called by the code that types or sends it. The password is also registered with a masker that removes it (and its URL-encoded, JSON-escaped and base64 forms) from audit records, clean-up reports, process results and logon messages.
- Target state: a dedicated test account with least privilege. A personal login is accepted with the protections below.

## Lockout protection
A rejected logon is never retried by the framework. When the caller classifies a failure as "rejected credentials", `LogonGuard` writes `.sas-state/logon-failed.json` (environment, application, user, a **salted scrypt fingerprint** of the password, time, a masked reason; never the password; file mode 0600) and refuses the same environment + application + user + password for `SAS_LOGON_FAILURE_COOLDOWN_MIN` minutes (default 15, `0` = off) **without contacting SAS**. A changed password or user is a different fingerprint, so fixing the credentials clears the stop by itself; deleting the file also does. The refusal says what happened, when, and the three ways on. A timeout or an unreachable server is not a rejection and writes nothing. The marker lives outside `test-results` (Playwright empties that folder at the start of each run). The health gate reports an active cooldown before the first test. One file holds all environment/application/user markers (written atomically). Concurrent workers logging on at the same instant can still each send one wrong logon; the fixtures log on once per test (so an app fixture can be a program that is not logged on); the cooldown makes every later attempt with rejected credentials fail without contacting SAS (that is the fixtures' job, NOT part of this layer).

## Environment allow-list
Environments (`dev`, `qa`, ...) are declared once in a committed JSON file (`SAS_ENVIRONMENTS_FILE`, no secrets - keys that look like secrets are rejected). Each has a **kind** (`nonprod` or `prod`; no default, a missing or misspelt kind is an error) and **host patterns** for metadata servers, web addresses and UNC paths. Kind and hosts come only from this file, never from an environment variable. `*` matches part of one name label, `**` crosses dots, `:port` pins the port; patterns that would allow too much (`*`, `*.corp`, `**.com`, `10.20.*.*`) are refused. Locations are parsed with the platform URL parser, so `https://allowed.example.com@evil.example.net/` is the host `evil.example.net`. An unknown environment, or no environments file, means every operation is refused.

## Safety policy
Every privileged action is described as `{driver, operation, kind: read|create|update|destructive, target, environment, host}` and passes `SafetyPolicy.authorize`. A refusal is a `PolicyViolation` naming the rule and how to proceed, and a `denied` audit record; nothing is sent to SAS.

| Rule | Refuses |
|---|---|
| `unknown-environment` | an environment that is not declared |
| `invalid-operation` | a kind that is not read/create/update/destructive |
| `host-not-allowed` | a host not on the environment's allow-list (reads too) |
| `host-required` | a mutating action that names no host and is not marked `local`; a read in prod without a host |
| `prod-read-only` | create/update/destructive in `prod`. Nothing overrides it |
| `prod-reads-disabled` | reads in `prod` unless `SAS_ALLOW_PROD_READS=true` |
| `target-required` | a mutating action without a target |
| `invalid-target` | control characters, `.`/`..` segments, wildcards on a destructive action |
| `outside-namespace` | a mutating target not inside the run's namespace `AUTO_<runId>` (any path segment may carry it, boundary at `_`, case-insensitive; configurable with `SAS_NAMESPACE_PATTERN`) |
| `override-reason-missing` | `SAS_ALLOW_OUTSIDE_NAMESPACE=true` without a reason (`SAS_ALLOW_OUTSIDE_NAMESPACE_REASON`, 8+ characters) |

`SAS_ALLOW_OUTSIDE_NAMESPACE=true` lifts only the namespace check; it logs a warning and marks the audit record (`override`, `reason`). It does not lift production, the host list or the target checks. The policy fails closed: if the audit log cannot be written, no action starts. Drivers depend on the `OperationGuard` interface (`authorize`, `record`); the package exports no allow-all guard. NOT enforced here: that a driver classifies its operations honestly - that is reviewed per driver and checked by its tests.

## Process hygiene
`ProcessDriver` uses `child_process.spawn` **without a shell** (arguments are an array; `.bat`/`.cmd` are refused). The executable is a bare name found only in `SAS_TOOL_DIRS` (never PATH or the working directory; a link leading out of a folder is refused; the real path is used) or an absolute path (switchable off). Relative paths and `..` are refused. The child gets a minimal environment: an allow-list (`SAS_CHILD_ENV_ALLOW`; a secret-looking name on it is refused), plus the call's own entries; the parent's `SAS_PASSWORD`, cloud keys etc. never reach it. Fixed working directory. Time limit with a kill of the **whole process tree** (process group: SIGTERM then SIGKILL; Windows: `taskkill /T /F` by absolute path), on timeout, abort and `close()`. Output capture is capped per stream (the run continues, `truncated` is set; a secret cut by the cap is trimmed). Secrets: `secretArgs` (and `stdin`, always) are replaced by `***` in the logged command line, stdout, stderr, errors and results; the value after a flag *named* like a secret (`-password x`) is masked in logs even if the caller forgot. Start failures keep only the error code (Node's error object carries the arguments). Prefer standard input or an encoded form for passwords; a password on a command line is visible to other users of the machine. Each call is authorized and audited (tool name, exit code, time-out flag; never the arguments).

## Audit log
JSON lines, one per privileged action, file mode 0600, `SAS_AUDIT_FILE` or `test-results/sas-audit/audit-<runId>.jsonl` (one file per run, newest `SAS_AUDIT_KEEP_RUNS` kept). `readAudit()` reads it for tests and reports and names the line of a damaged record.
```json
{"time":"2026-10-23T21:45:03.120Z","runId":"261023214501a3f9","correlationId":"<uuid>","driver":"sas-process","environment":"dev","operation":"delete-group","kind":"destructive","target":"AUTO_261023214501a3f9_Users","host":"sasmeta.dev.example.com","outcome":"ok","durationMs":412,"detail":{"tool":"<tool>","exitCode":0,"timedOut":false}}
```
`outcome` is `ok`, `denied` (with `reason` = the rule) or `error`. Records pass through the shared logger's redaction (secret-looking keys, Bearer tokens, `password=...`, URL passwords) and the known-secret masker. Playwright empties `test-results` at the start of a run: for retention across runs set `SAS_AUDIT_FILE` elsewhere, or collect the folder as a CI artifact.

## Evidence hygiene
Screenshots and dumps of administration screens can hold personal data. `SAS_EVIDENCE` defaults to `failure` (`off`, `failure`, `steps`; the core's own modes are `off`, `failure`, `on`, and the fixtures map `steps` to `on`; `SAS_EVIDENCE=off` always wins); files go under `<SAS_EVIDENCE_DIR>/<runId>/`, a label is reduced to `[A-Za-z0-9._-]` so it cannot leave that folder, folders of other runs are pruned after `SAS_EVIDENCE_RETENTION_DAYS` (default 7). Masking of secret fields on screen is the desktop layer's job (not in this core).

## Clean-up and orphans
Created objects are registered with an undo at creation time and recorded in `.sas-state/created-objects.jsonl` (created / removed / kept). Undo runs newest first, one at a time, each with a time limit and an abort signal; failures are reported (`CleanupFailed`), not swallowed. `findOrphans(olderThanMs)` lists what was never removed, so a sweeper can delete leftovers by run-id prefix. A sweeper itself is not part of this layer.

## Supply chain
No new third-party runtime dependency: Node built-ins plus the family's `utils` package. The scanner (`npm run security`) and audit allow-list apply as in the other repositories.

## NOT VERIFIED (nothing here has run against SAS or Windows)
- Everything was tested on macOS with a fake batch tool (a Node script that mimics exit codes, output, descendants and signals). No SAS installation was available.
- The Windows tree kill (`taskkill /T /F`): only the command line is tested. Windows executable resolution (`.exe`/`.com` candidates) is tested with a fake platform argument.
- No SAS batch-tool option name, exit code or output format is built in. The `BatchToolRunner` option tables (`SAS_BATCH_TOOLS_FILE`) are NOT VERIFIED until a conformance run with the real tool passes; the result says `verified: false`.
- Output decoding of Windows tools (OEM/ANSI code pages) is a per-call option, untested against real tools.
- Whether SAS tools accept a password on standard input, and how they signal a rejected logon, is unknown until the installation inventory.
