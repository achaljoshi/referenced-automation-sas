# Contributing to referenced-automation-sas

The shared rules (tests with negative controls, no hard waits, no secrets, ADRs, review checklist, deprecation policy) are in
[`referenced-automation-utils/docs/governance/CONTRIBUTING.md`](../referenced-automation-utils/docs/governance/CONTRIBUTING.md).
Release and upgrade steps: [`RELEASING.md`](../referenced-automation-utils/docs/governance/RELEASING.md). Decisions: [`docs/adr`](docs/adr/README.md) (this repo's own: ADR 0001 and 0002).

## Before you push
```bash
npm run build && npm run lint && npm run typecheck && npm test && npm run security
npx automation-framework-audit --out /tmp/audit-sas --quiet      # no new high findings
```
`npm test` runs everything against the **stand-in desktop** (a fake Management Console, a fake Enterprise Guide, a fake COM object model, and a stand-in bridge program speaking the real line protocol). If you change the PowerShell bridge, a LOCATORS table (`SMC_LOCATORS`, `EG_UI_LOCATORS`), the Enterprise Guide COM members (`EG_COM`) or anything that assumes how the real programs behave, say plainly in the merge request that the change has **not** been run against a real Windows desktop with the real SAS programs unless it has - and label it NOT VERIFIED in the docs.

## Rules specific to this repo
- **SAS Viya is out of scope.** Do not add Viya code here: the family's `api` and `ui` packages are for that.
- **Order of preference: command line > COM > screens.** A new capability goes through the highest route that can do it; a screen-level test is only for tests about the screens.
- **Every privileged step passes the policy gate.** A new driver operation must be classified (read, create, update, destructive) and name the object it changes; read `src/fixtures/guardAdapter.ts` for how the desktop layer's operations reach the policy, and add a case to `tests/fixtures/guardAdapter.spec.ts`.
- **A new setting is documented in the same change**: add it to `.env.example` (purpose, valid values, default, required, secret, where to find it) and to the README's "Configuration reference" table; `tests/envDocs.spec.ts` fails otherwise. A secret also goes into `.env.local.example`. Read settings only through the shared `ConfigReader` (`loadEnv()`), never `process.env` directly.
- **New behaviour is a scenario; new library code gets a plain spec.** A flow a person would recognise (a logon, a project run, a refusal by the policy) goes into `features/` as a scenario, in the folder whose settings it needs (`features/*.feature` on the stand-in, `production/`, `real/`); a plain spec in `tests/` is for the library and the framework itself (a class, a converter, a documentation or portability guard). This repo's own steps are in `features/support/`.
- **A new Gherkin step is public API**: add it to the list in `tests/bdd/vocabulary.spec.ts` and say so in `CHANGELOG.md`. Changing or removing one is a breaking change.
- **No sleeps.** Wait for the control or the state (the desktop layer and the assertions already poll). A test that expects a failure has a twin that expects success.
- **After a reviewed change to `bridge/sas-desktop-bridge.ps1`** run `npm run bridge:hash` (the build does too) and commit the script and `src/desktop/bridgeHash.generated.ts` together; CI runs `npm run bridge:hash:check`.
- **No secret in any file, log, step title or error.** Passwords are held in `Credentials` and typed through a flagged command; test passwords are made up per run (never a real one).

Update `CHANGELOG.md`. This repo is in the chain `utils` -> `api`/`ui` -> `sas`: a change here is released as a new version and its consumers move to it.
