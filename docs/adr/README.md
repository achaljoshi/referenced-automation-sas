# Architecture decision records

One file per decision, numbered, never rewritten: a changed decision is a new ADR that says which one it replaces. The shared rules (when an ADR is needed, how it is approved) are in [`referenced-automation-utils/docs/governance/CONTRIBUTING.md`](../../../referenced-automation-utils/docs/governance/CONTRIBUTING.md); the family's own ADRs are in [`referenced-automation-utils/docs/adr`](../../../referenced-automation-utils/docs/adr/README.md).

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-sas-automation-architecture.md) | SAS desktop automation: command-line and COM drivers behind a policy gate, a Windows UI Automation layer, all in TypeScript on Playwright Test. SAS Viya is out of scope (the family's `api` and `ui` packages cover it) | Proposed - approver not yet recorded |
| [0002](0002-record-and-play-for-sas-desktop-apps.md) | Record and play for the SAS desktop programs: our own recorder in the bridge, a converter to Playwright tests, protocol-level capture for Management Console administration | Proposed - approver not yet recorded |

Where each decision shows up in the code: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).
