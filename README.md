# SFMC Data Loader

**A simple desktop app to export and import Salesforce Marketing Cloud Data Extension rows — no command line, no VS Code, no Node.js install required.**

Download it, open it, connect your Marketing Cloud account, and move data in and out of your Data Extensions with a few clicks. Works on **Windows, macOS, and Linux**.

## Who is this for?

This app is for **Marketing Cloud users who just want to get data in and out** without becoming a developer:

- 📋 **Marketing & campaign teams** who need to pull a Data Extension into a spreadsheet, or load a list back in.
- 🧑‍💼 **Admins and consultants** working across multiple Business Units who want a reliable point-and-click tool.
- 🚫 **Anyone who doesn't want the CLI or an IDE.** The same power that the `mcdata` command-line tool and the VS Code extension offer — but in a friendly window with buttons, progress bars, and clear confirmations.

If you've ever been handed instructions to "install Node, open a terminal, and run `mcdata`…" and wished there was just an app — this is that app.

## What can it do?

- **Export** Data Extension rows to CSV, TSV, or JSON — from a single Business Unit or several at once, with optional pretty-printed JSON and output-file splitting.
- **Import** rows from a file into a Data Extension — into one BU, or copy data from one BU to another.
- **Handles very large Data Extensions** (multiple gigabytes) by streaming data straight to and from disk, so your computer doesn't run out of memory.
- **Keeps you safe** with clear confirmations before anything destructive: you must type to confirm a "clear before import", you can automatically back up a Data Extension before overwriting it, and you get a heads-up before importing very large files.
- **Shows live progress** with batch totals when available; streaming uploads without a known total show the current batch and an animated progress bar instead of a percentage.
- **Keeps recent job output** without growing the log indefinitely. Older output can be discarded during bursts, and oversized lines are truncated; the panel shows a notice when this happens. Scroll up to read without being pulled back to the bottom; scroll near the bottom to resume following new output.
- **Remembers your connections** so you don't re-enter credentials every time.
- **Remembers your last project folder** so it's pre-selected the next time you open the app.

## Is it safe with my credentials?

Your Marketing Cloud client ID and secret are stored in local project
configuration/auth files and used to authenticate to Salesforce. The app passes
them to its worker without putting them in command-line arguments or analytics.
These files are **not an encrypted credential vault**: protect the project folder
and its backups from other users/programs. Debug logs may contain sensitive API
data; review them before sharing.

The app window itself is locked down (sandboxed with a strict security policy) and cannot run arbitrary code from the internet.

## Getting started

1. **Download** the installer for your operating system from the [latest release](https://github.com/JoernBerkefeld/sfmc-dataloader-app/releases/latest):
   - **Windows** — `sfmc-dataloader-app-<version>-win-x64.exe`
   - **macOS** — `sfmc-dataloader-app-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel)
   - **Linux** — `sfmc-dataloader-app-<version>-linux-x64.AppImage`, `.deb`, `.rpm`, or `.snap`
2. **Install and open** the app.
3. Go to **Connections**, enter your Marketing Cloud API credentials, and let the app list your Business Units.
4. Switch to **Export** or **Import** and go.

Before clearing rows, the confirmation dialog lists the target Business Units and
DE keys or files. Type the displayed DE keys exactly (including separators), or
`CLEAR` for file imports. Cancel or Escape leaves the import unstarted; changes
to the selection do not change the job already shown in the dialog.

Only one transfer or connection-save job can run at a time. Switching screens
keeps the active transfer visible; it does not start another job. **Cancel**
requests that the worker stop, and the app waits for its actual exit before
allowing another job. If stopping fails, you can retry Cancel. Cancellation does
not undo rows already written or restore rows cleared before an import.

Closing the window, quitting, cancelling, or installing an update during a
starting/running/stopping job requires a main-process confirmation. **Stay open**
is the safe default. The app waits for local worker exit before proceeding; a
failed stop leaves it open. Remote work already accepted by Salesforce may
continue after local cancellation, close, or quit.

### Selecting projects, BUs, DEs, and files

The header shows the selected project folder globally; choose it in **Connections**.
If the project-folder save fails, it remains selected for this session; use **Use
this folder** again to retry persistence for the next launch.
Export also shows the project used for its output. Multi-BU export and cross-BU
import offer searchable saved-BU checkboxes across credentials, with manual
`credential/BU` tokens as an advanced fallback. Filtering preserves checked BUs;
manual entries follow the checked selections and duplicates are removed.

DE lists can be searched by name or key. **Select visible** adds the filtered
rows; **Clear selection** clears even hidden selections, and the count includes
hidden checked rows. Changing project, source BU, or transfer mode invalidates
loaded DE selections; refresh for the new context. Manual keys are explicitly
unverified. A multi-BU export's DE list comes from the **first selected source BU**
only: it does not validate the keys against every other source BU. Cross-BU API
imports use the source BU list; single-BU key imports use the target BU list and
require matching local export files.

File imports show every selected file with **Remove** and **Clear files** controls.
Browsing replaces the selection; cancelling the picker preserves it. A file of
**1 GiB or larger** triggers a separate informational notice: **Large imports can
take a long time.** It has only **OK**; dismissing it continues without cancelling
the import. Any subsequent destructive confirmation remains independently
cancellable. The threshold applies per file, not to their combined size.
Removing a file from the selection does not delete it from disk.

Export's **Max rows per file** accepts a positive safe whole number, or blank for
unsplit output. Invalid input is labelled inline and prevents submission.
**Pretty-print JSON** affects JSON exports only.

### Defaults and active jobs

**Settings → Transfer defaults** saves export format (CSV initially), stable
filenames (off), import mode (upsert), backup before import (on), skip empty lines
(off), and debug logging (off). Transfer screens allow per-run overrides. Clear
before import is never saved as a default. If saving fails, the app reports that
defaults apply only to the current session and offers **Retry saving transfer
defaults**; do not assume they will survive a restart. Debug logging can capture
sensitive API data.

The persistent active-job banner remains visible across screens and returns you
to the owning job, including connection setup. Conflicting transfer/connection
starts stay disabled until the worker exits. Progress and status are announced
through labelled live regions; the return button moves focus to the job, and job
output is keyboard-focusable. Destructive dialogs support keyboard confirmation,
Escape cancellation, and focus restoration.

On the **Import** screen, **Skip empty lines (CSV/TSV)** is unchecked by default.
Enable it to ignore unquoted blank or whitespace-only records in CSV/TSV files,
including Data Extension export files and cross-BU file imports. It leaves values
unchanged: quoted empty cells, delimiter-only rows, and blank lines inside quoted
fields remain data. JSON imports, API copies, and exports are unaffected.

> **Note on macOS:** until code-signing certificates are configured, macOS builds are **unsigned**. You may need to right-click the app and choose _Open_ the first time to get past Gatekeeper.

### Or install with a package manager

If you'd rather use a package manager, these all install the same app:

| Platform             | Command                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Windows** (winget) | `winget install JoernBerkefeld.SFMCDataLoader`                                                                   |
| **Windows** (Scoop)  | `scoop bucket add joern https://github.com/JoernBerkefeld/scoop-bucket` then `scoop install sfmc-dataloader-app` |
| **Linux** (Flatpak)  | `flatpak install flathub com.joernberkefeld.SfmcDataLoader`                                                      |
| **Arch Linux** (AUR) | `yay -S sfmc-dataloader-app-bin`                                                                                 |

> Package-manager availability rolls out per release; if a channel isn't published yet, use the direct download above. See [`packaging/README.md`](packaging/README.md) for the current status and maintenance details.

### Staying up to date

On **Windows**, **macOS**, and the Linux **AppImage**, the app updates itself: a
few seconds after launch it checks for a newer release, downloads it in the
background, and shows a banner offering to **restart & install**. Installing during
an active job requires confirmation and waits for the local worker to exit. Installs via **deb/rpm/snap**, **Flatpak**,
or your package manager are updated the usual way (`apt`, `dnf`, `snap`,
`flatpak update`, `winget upgrade`, `scoop update`, …).

## Telemetry & privacy

**All analytics is optional, including lifecycle events. Nothing is sent before
an affirmative consent choice is saved.** Decline the first-run prompt, dismiss
it with Escape, or turn off **All app telemetry (optional)** in **Settings** to
use the app without analytics. **No thanks** receives initial focus.

Saved consent uses schema version **1**. Legacy enabled choices require renewed
consent. Failed opt-in saves keep analytics disabled and offer a retry. Opt-out
immediately discards queued events and aborts in-flight requests, even if saving
fails; retry saving to persist it for the next launch. Already delivered requests
cannot be recalled. There is no pre-consent buffering or later replay.

Consenting packaged runs send events to **PostHog's EU ingestion endpoint**, in
project **254290**, with `app: 'sfmc-dataloader-app'`; GA4 has been replaced.
The persisted random installation ID is **pseudonymous, not guaranteed anonymous**.
PostHog receives ordinary connection metadata, including IP. Provider retention
and IP/geolocation/processing settings have not been verified here.

The catalogue covers first-consented runs (not installs), consenting launches and
updates, resolved loader version, export/import usage, job outcomes, and
configuration/DE-discovery action outcomes. It contains versions, platform fields,
coarse counts/sizes/durations, closed error categories, project-type presence
booleans, and primary-language locale where applicable. Job timing excludes user
prompts; action timing covers the main-process request. Exact p50 latency cannot
be derived from duration buckets.

Analytics excludes paths, DE keys and data, BU identities, credentials, raw error
messages/stacks, logs, and editor inventory. Update checks and Salesforce traffic
are separate from analytics. See **[PRIVACY.md](PRIVACY.md)** for the event fields,
timing boundaries, save-failure behavior, and provider caveats.

---

## For developers

Everything below is for people who want to build, modify, or release the app. End users can stop here.

This is an **Electron** app that wraps the [`sfmc-dataloader`](https://www.npmjs.com/package/sfmc-dataloader) library (the same engine behind the `mcdata` CLI). Because the library runs in-process, export and import are fully **streamed** — multi-GB Data Extensions never get loaded into memory whole.

### Architecture

| Layer          | Location        | Responsibility                                                                                                                                                                                                                                                |
| -------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main process   | `src/main/`     | Window lifecycle, dialogs, IPC handlers, spawns the job worker, drives auto-update (`updater.js`)                                                                                                                                                             |
| Preload bridge | `src/preload/`  | Allow-listed `window.mcdata` API (contextIsolation, sandbox)                                                                                                                                                                                                  |
| Renderer       | `src/renderer/` | UI only; no Node access, talks to the bridge                                                                                                                                                                                                                  |
| Job worker     | `src/worker/`   | Isolated Node process; thin `parentPort` wiring around the shared job runner that drives `sfmc-dataloader` for export/import                                                                                                                                  |
| Shared         | `src/shared/`   | Isomorphic helpers reused by main, worker, renderer and tests: IPC channel + job-kind constants, argv builder, progress parser, file-size helpers, update-status state machine, and the injectable job runner (streams logs/progress, reports complete/error) |

The renderer is fully sandboxed (`contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`) with a strict Content-Security-Policy. All privileged work happens in the main
process and the job worker. Credentials are written to the standalone `.mcdatarc.json` /
`.mcdata-auth.json` files and passed to `sfmc-dataloader` without ever appearing in a process's
argv.

### Development

Use Node.js `^22.22.2 || >=24.15.0` for development. The app bundles
`sfmc-dataloader` `^3.2.0` (lockfile baseline 3.2.0); installed desktop apps need no separate Node.js install.
The loader preserves unsuccessful/unverified import outcomes and rejects
ambiguous explicit file selections rather than retrying or dropping files.

Connection listing uses the loader's released
`loadPublicProjectConfig(projectRoot, { stderr })` API, which checks auth-file
existence without reading its contents. It never falls back to the auth-reading
`loadProjectConfig`. Integration tests exercise the actual installed registry
dependency by default, including malformed-auth and secret-redaction regressions.
For isolated packed-loader development, tests also accept
`SFMC_DATALOADER_FIXTURE`; this does not change production module resolution.

```bash
npm ci --no-workspaces
npm start        # launch the app
npm run lint     # eslint
npm test         # node --test
```

### Packaging

Installers are produced with `electron-builder` (config in `electron-builder.yml`). Local builds
never upload anything (`--publish never`):

```bash
npm run dist:win     # NSIS installer (Windows)
npm run dist:mac     # DMG + updater ZIP, x64 + arm64 (macOS)
npm run dist:linux   # AppImage + deb + rpm + snap
npm run dist         # all targets for the current OS
```

Output lands in `release/`. Package-manager manifests (Scoop, winget, Flatpak,
AUR) live under [`packaging/`](packaging/README.md) — all fed from the same
GitHub Release artifacts.

> **Auto-update:** in-app updates are handled by `electron-updater` and only work
> in a packaged, released build (self-updating for Windows NSIS, macOS dmg, and
> Linux AppImage). In development (`npm start`) the update check is skipped.

> **Icon:** no custom app icon is configured yet, so builds use the default Electron icon. Add
> `build/icon.ico` (Windows), `build/icon.icns` (macOS), and `build/icon.png` (Linux, 512×512+) —
> electron-builder picks them up automatically from `buildResources: build`.

### Releasing

Publishing is automated by `.github/workflows/build-release.yml`. Creating a **GitHub Release**
triggers a three-OS matrix (`windows-latest`, `macos-latest`, `ubuntu-latest`); each runner lints,
tests, builds its native installers, and uploads them to that release via electron-builder's GitHub
publish provider (`--publish always`).

The workflow targets **seven installers** plus macOS x64/arm64 updater ZIP archives and
electron-builder's auto-update metadata (`latest*.yml` and `.blockmap` files). The Linux
`rpm` build installs `rpm`/rpmbuild on the runner; the `snap` build runs in a separate,
non-fatal step, so a snap failure may leave that asset absent without failing the workflow:

| Platform | Assets                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| Windows  | `...-win-x64.exe`                                                                        |
| macOS    | `...-mac-x64.dmg`, `...-mac-arm64.dmg`, `...-mac-x64.zip`, `...-mac-arm64.zip`           |
| Linux    | `...-linux-x64.AppImage`, `...-linux-x64.deb`, `...-linux-x64.rpm`, `...-linux-x64.snap` |

For stable releases only, after the full installer build/upload matrix succeeds,
`build-release.yml` calls the reusable `winget-publish.yml` workflow. A missing
`WINGET_TOKEN` causes a successful skip; with the token configured, `wingetcreate`
submits to `microsoft/winget-pkgs`, and an actual submission error fails the workflow.
Snap tooling/build/upload steps remain non-fatal; the snap step also receives
`SNAPCRAFT_STORE_CREDENTIALS` when configured. These outcomes are distinct: a failing
post-build winget or manifest-refresh job does not undo assets already uploaded to
the GitHub Release.

macOS code signing and notarization are optional and driven by repository secrets — when they are
absent the workflow still succeeds and produces an **unsigned** macOS build:

| Secret                        | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `MAC_CSC_LINK`                | base64-encoded `.p12` signing certificate (→ `CSC_LINK`) |
| `MAC_CSC_KEY_PASSWORD`        | password for the `.p12` certificate                      |
| `APPLE_ID`                    | Apple ID used for notarization                           |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID                  |
| `APPLE_TEAM_ID`               | Apple Developer Team ID                                  |

### Telemetry configuration

Development/unpackaged builds disable analytics. Packaged builds use the public
PostHog ingestion configuration in `src/main/analytics-config.js` (EU batch
endpoint, project 254290), not GA4 build secrets or generated credentials. A
packaged fork using that configuration still requires saved affirmative consent;
being a fork alone does not disable analytics.

The main-process sender defers requests, applies a five-second abort timeout,
drops failures without retry/replay, and discards queued events at shutdown.
Consent is checked before queuing and again before dispatch; operations spanning
a consent change are excluded. The payload boundary lives in
`src/shared/telemetry-events.js`; [PRIVACY.md](PRIVACY.md) documents the catalogue
and actual call sites. Keep these and the Settings/first-run explanation aligned.

### Relationship to `sfmc-dataloader`

This app depends on the `sfmc-dataloader` npm package as a normal runtime dependency and bundles it
into the installer. The optional `mcdev` integration dependency is intentionally excluded
(`omit=optional` in `.npmrc`) — this app uses the standalone `.mcdatarc.json` / `.mcdata-auth.json`
configuration layout only. When `sfmc-dataloader` ships a new version, bump the dependency here,
retest, and release a new installer.

## License

MIT © Joern Berkefeld
