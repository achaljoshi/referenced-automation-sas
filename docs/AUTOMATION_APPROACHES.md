# Ways to automate SAS Viya, SAS Management Console and SAS Enterprise Guide

A decision document: every realistic way to automate each product, what each needs from the SAS installation, and what it costs. Nothing here has been run against a real SAS system by the author. The facts come from SAS documentation, SAS blogs/communities and the Python/Java ecosystems (sources at the end); **version-specific details (ProgIDs, jar names, folders) must be checked against the installed release** - `scripts/inventory-sas.ps1` does that on your machine.

## 1. At a glance

| Product | What it is | Best first choice | Use the GUI for |
|---|---|---|---|
| **SAS Viya** | Web apps (SAS Drive, SAS Studio, Environment Manager, Visual Analytics) on a REST platform | **REST APIs** (official, stable, fast) | Only what REST cannot show: rendering, navigation, report behaviour |
| **SAS Management Console** (SAS 9.4) | Java Swing desktop admin tool for the metadata server | **Batch tools + metadata calls from SAS code / the metadata API** (no GUI at all) | Only the GUI itself (is the console usable, wizards, plug-in screens): Windows UI Automation through the Java Access Bridge |
| **SAS Enterprise Guide** | .NET (WPF) desktop client | **The Enterprise Guide automation object model (COM)** to open and run projects, or the Integration Technologies client to run code | Only EG's own screens: Windows UI Automation (WPF is automatable) |

Principle: automate through an **API or command line wherever one exists**, and use GUI automation only for the few checks that are about the GUI. APIs are faster, do not break when a screen is redesigned and do not depend on an unlocked desktop.

## 2. SAS Viya

| # | Way | How it works | Needs from the installation | Good | Watch out |
|---|---|---|---|---|---|
| V1 | **REST APIs** | HTTPS + JSON: SAS Logon OAuth token, then service endpoints: Compute (submit code, wait, log, listing), Job Execution, Folders, Files, Reports, Identities, Authorization, CAS Management, `apiMeta` per service | Only the Viya address and a login (or an OAuth client id). No software to install | Official and documented; no UI; fast; covers admin, running programs, health checks, content. Fits our `api` package (retries, masked logs, OAuth) | Does not prove what a user sees. Needs an OAuth client id for a password login (the `sas.cli` public client is the usual one) |
| V2 | **`sas-viya` command line** | A SAS-provided binary that wraps the REST APIs: `auth login`, admin plug-ins, `batch jobs submit-pgm` to run a program, JSON output | The CLI binary and a profile (admin workstation / download from your Viya) | Great for operations; no REST code to write | Another binary to install; login state is a token file; harder to test than a REST call. Useful as an optional driver, not the foundation |
| V3 | **Python packages** | `swat` (CAS actions), `sasctl` (Viya REST wrapper, model management), `saspy` (SAS sessions) | Python and `pip install` (on a restricted network these come from your JFrog mirror) | Convenient for CAS data and model checks | A second language and runtime beside TypeScript; run as child processes. Only worth it for CAS-specific data validation |
| V4 | **Browser UI automation (Playwright)** | Drive SAS Drive, SAS Studio, Environment Manager and Visual Analytics like a user | A browser; the Viya address | Tests what users see: reports render, filters work, Studio runs a program, Environment Manager shows services running. We already have this stack | Locators depend on the Viya release and your customisations; slower than REST. Keep the set small and put each locator in one place |
| V5 | **ODBC / JDBC / OLE DB** | Query data that SAS serves | SAS drivers (SAS/ACCESS) | Direct data validation | Driver and licence dependent; not a UI or admin test |

Typical split: V1 for setup, data preparation, running jobs, health and admin; V4 for the handful of UI journeys; V2 or V3 only if a team already relies on them.

## 3. SAS Management Console (SAS 9.4, metadata server)

| # | Way | How it works | Needs from the installation | Good | Watch out |
|---|---|---|---|---|---|
| M1 | **Batch tools** (`ExportPackage`, `ImportPackage`, and the batch tools to list/delete objects, create folders, and analyse/repair metadata, depending on the maintenance release) | Command-line programs with the same abilities as the console's wizards, run from a script | The SAS Platform Object Framework folder, `SASHome\SASPlatformObjectFramework\9.x` (on any machine where it is installed), and a metadata profile or host/port/user/password | Official; scriptable; no GUI; ideal for backup, promotion, deletion, content set-up and verification | Covers content management more than every console feature. Some options differ from the wizards |
| M2 | **SAS code against the metadata server** | Run a SAS program that reads/changes metadata: metadata DATA step functions, `PROC METADATA`, and the metadata macros for users and groups | A SAS session that can reach the metadata server: Base SAS (`sas.exe -sysin`), Enterprise Guide, or a workspace server through the Integration Technologies client | Reaches users, groups, ACTs, libraries, servers: most of what an administrator does in the console, without the console | Needs a SAS session and the right metadata permissions; the code is SAS, so results are read from the log/listing |
| M3 | **SAS Open Metadata Interface clients** | A program talks to the metadata server directly. The Java client (`com.sas.metadata.remote`, `MdFactoryImpl`, `makeOMRConnection`, port 8561 by default) and XML requests over the Integration Technologies client | SAS's Java jars from the installation (the connection/metadata client libraries) and a Java runtime; or the COM/.NET client | Full parity with what the console edits; fine-grained control | Heavy: Java, SAS jars of the right version, a small helper process (like the Java/JACOB helper in the SAP repo). Worth it only if M1 and M2 do not reach what you need |
| M4 | **GUI automation of the console** | The console is a Java Swing program. Swing's controls are not visible to Windows accessibility tools until the **Java Access Bridge** is enabled (`jabswitch -enable`, then restart the program). After that, Windows UI Automation or a Java-Access-Bridge library can find windows, trees, tables and buttons | The console itself, `jabswitch.exe` from the Java in use, and an interactive Windows desktop. Tools: a PowerShell UI Automation bridge (our design), `pyjab` / `java-access-bridge-wrapper` (Python), or in-process Swing test libraries (AssertJ Swing, Jemmy) attached to the console's JVM | The only way to test the console's own screens and wizards | The most fragile layer: slow, dependent on an unlocked desktop, on the Access Bridge, on the console's version and on Swing component naming. In-JVM libraries are invasive. Keep to a thin set of checks |
| M5 | **Image / coordinate automation** (AutoIt, Sikuli, PyAutoGUI, AutoHotkey) | Click at screen positions or match pictures | Nothing but the screen | Works with any program | Breaks with a resolution, theme or font change; no real waits. A last resort |

## 4. SAS Enterprise Guide

| # | Way | How it works | Needs from the installation | Good | Watch out |
|---|---|---|---|---|---|
| E1 | **Enterprise Guide automation object model (COM)** | A script creates `SASEGObjectModel.Application.<version>`, opens a `.egp` project, runs it or a process flow, saves/exports, quits. SAS uses this itself for scheduling projects | Enterprise Guide installed (the scripting library `SASEGScripting.dll`, registered as a COM object whose ProgID carries the EG version). Older EG versions are 32-bit, so use the 32-bit PowerShell/cscript | Official; runs real projects unattended; no screen scraping | The ProgID/version must match the install; EG runs in the background and needs a profile that connects without a prompt. "Could not locate automation class" means the wrong version string or an unregistered DLL |
| E2 | **Integration Technologies client (IOM)** | Connect to a SAS workspace server and submit code through `SASObjectManager.ObjectFactoryMulti2` (COM) or the .NET/Java client; read the log, listing, files and data | The Integration Technologies client (installed with EG and other SAS clients) and a workspace server to connect to | Runs SAS code and reads results without Enterprise Guide | A workspace server must be reachable and configured; reports exist of the connection failing on machines without Base SAS |
| E3 | **Run SAS in batch** | `sas.exe -sysin program.sas -log file` | Base SAS installed | Simplest for pure code | Needs Base SAS on the machine; no EG, no Viya |
| E4 | **GUI automation of Enterprise Guide** | EG is WPF: Windows UI Automation sees its controls. Drive with FlaUI (.NET), pywinauto (UIA), our PowerShell UI Automation bridge, AutoIt, or Power Automate Desktop | Enterprise Guide and an interactive desktop | Tests EG's own screens and flows | Slow and release-dependent; needs an unlocked desktop |
| E5 | **SAS Add-In for Microsoft Office** (COM/VBA) | Automate SAS from Excel/Word | The add-in | Only if Office integration is in scope | Out of scope unless you need it |

## 5. What on your machine decides it (run `scripts/inventory-sas.ps1`)

| Look for | Enables |
|---|---|
| `SASHome\SASPlatformObjectFramework\9.x\ExportPackage*`, `ImportPackage*` and other batch tools | M1 |
| `sas.exe`, `sasv9.cfg` (Base SAS) | M2, E3 |
| `SASEGScripting*.dll` and COM names `SASEGObjectModel.Application.*` | E1 |
| COM names `SASObjectManager.*`, the Integration Technologies client | E2, M2 |
| SAS jars (`sas.svc.connection*.jar`, `sas.oma*.jar`, `sas.core*.jar`, `sas.security*.jar`) and a Java runtime (SAS ships a private one) | M3 |
| `jabswitch.exe`, `WindowsAccessBridge*.dll`, `.accessibility.properties` | M4 (is the Access Bridge available/enabled) |
| `sas-viya` CLI on PATH, Python packages `swat` / `sasctl` / `saspy` | V2, V3 |
| The Viya address answering `/SASLogon/login` and `/compute/apiMeta`; the metadata server answering on port 8561 | V1, V4, M1-M3 |

## 6. Comparing the ways

| Criterion | REST / CLI / batch tools / COM (the API family) | GUI via UI Automation | Image / coordinates |
|---|---|---|---|
| Stability across releases | High: versioned, documented | Medium-low: screens change | Low |
| Speed | Fast | Slow | Slow |
| Needs an unlocked interactive desktop | No (except EG COM, which starts EG) | **Yes** | **Yes** |
| Tests what the user sees | No | Yes | Yes |
| Effort to build | Low-medium | High | Medium, then constant repair |
| Fits the existing TypeScript/Playwright stack | Yes (HTTP, child processes, a small PowerShell/Java helper) | Needs a bridge process like the SAP one | Poor |
| Fits a personal-login/lockout risk | Controlled: one logon, never retried | Same | Same |

## 7. Recommendation

A **layered** approach, API first:

1. **A `SasCodeRunner` interface** that runs SAS code and returns log + listing + state, with three back ends chosen by configuration: Viya Compute (REST), an IOM workspace server (COM through a small PowerShell helper, or Java), and batch `sas.exe`. Tests do not care which one is installed.
2. **Viya:** REST client (V1) for admin, jobs, health and content; a small Playwright set (V4) for SAS Studio, Environment Manager and Visual Analytics journeys; the CLI (V2) only as an optional driver.
3. **SAS Management Console:** batch tools (M1) and metadata calls from SAS code (M2) for all admin verification and set-up; a **thin** GUI layer (M4: Java Access Bridge + Windows UI Automation) only for tests about the console itself.
4. **Enterprise Guide:** the automation object model (E1) to open and run projects and read their results; a thin GUI layer (E4) for EG-screen checks.
5. **One desktop bridge** (PowerShell + Windows UI Automation, same line protocol as the SAP bridge) shared by M4 and E4, with an `inspect` command that prints every control so locators can be filled in minutes.
6. **Safety:** personal logins go through a logon guard (a rejected password is never retried, and the same credentials are refused for a cooldown), as the SAP framework does.

## 8. Decisions needed from you

1. After running the inventory: which of M1, M2, M3, E1, E2 are actually available on your machines?
2. For SAS Management Console: is automating the **console GUI itself** a requirement, or is verifying what administrators do (users, groups, libraries, servers, folders, permissions) enough? If it is enough, M1 and M2 replace most of the GUI work.
3. For Viya: may we use an OAuth client id for the REST calls (the `sas.cli` public client is the usual default), and is the `sas-viya` CLI installed or allowed?
4. "SAS enterprise application": is this SAS Enterprise Guide? (If it is Enterprise Miner, Data Integration Studio or another product, say which: they are Java programs and fall under M4.)
5. Do UI checks have to run from the AWS WorkSpace, or may some run on another Windows host?

## Sources

- [Using SAS Enterprise Guide to run programs in batch (SAS blog)](https://blogs.sas.com/content/sasdummy/2011/05/03/using-sas-enterprise-guide-to-run-programs-in-batch)
- [Automation in EG using VBScript (SAS Communities)](https://communities.sas.com/t5/SAS-Enterprise-Guide/Automation-in-EG-using-VBScript/m-p/189325)
- [Importing, Exporting, and Promoting Metadata (SAS documentation)](https://support.sas.com/documentation/cdl/en/itrmxag/68812/HTML/default/n1s90hluou65l9n10cvurnllutfd.htm)
- [Instantiating an Object Factory and Connecting to the SAS Metadata Server (SAS documentation)](https://support.sas.com/documentation/cdl/en/omaref/63063/HTML/default/p07pwlg2veeru8n1vcq8oxkzoij2.htm)
- [SAS Integration Technologies Developer's Guide, Windows client](https://support.sas.com/rnd/itech/doc9/dev_guide/dist-obj/winclnt/ominterface.html)
- [Compute API overview (developer.sas.com)](https://developer.sas.com/rest-apis/compute/docs/overview)
- [devsascom REST API samples (GitHub)](https://github.com/sassoftware/devsascom-rest-api-samples)
- [sasctl (PyPI)](https://pypi.org/project/sasctl)
- [pyjab, Java Access Bridge wrapper (PyPI)](https://pypi.org/project/pyjab)
- [java-access-bridge-wrapper (PyPI)](https://pypi.org/project/java-access-bridge-wrapper/)
