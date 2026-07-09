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

- **Export** Data Extension rows to CSV or TSV — from a single Business Unit or several at once.
- **Import** rows from a file into a Data Extension — into one BU, or copy data from one BU to another.
- **Handles very large Data Extensions** (multiple gigabytes) by streaming data straight to and from disk, so your computer doesn't run out of memory.
- **Keeps you safe** with clear confirmations before anything destructive: you must type to confirm a "clear before import", you can automatically back up a Data Extension before overwriting it, and you get a heads-up before importing very large files.
- **Remembers your connections** so you don't re-enter credentials every time.
- **Remembers your last project folder** so it's pre-selected the next time you open the app.

## Is it safe with my credentials?

Yes. Your Marketing Cloud client ID and secret are:

- stored in a local configuration file on **your** computer (never sent anywhere except to Salesforce to log in), and
- **never exposed to other programs** on your machine — the app is built so secrets can't leak onto the system process list, which is a common weakness of command-line tools.

The app window itself is locked down (sandboxed with a strict security policy) and cannot run arbitrary code from the internet.

## Getting started

1. **Download** the installer for your operating system from the [latest release](https://github.com/JoernBerkefeld/sfmc-dataloader-app/releases/latest):
   - **Windows** — `sfmc-dataloader-app-<version>-win-x64.exe`
   - **macOS** — `sfmc-dataloader-app-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel)
   - **Linux** — `sfmc-dataloader-app-<version>-linux-x64.AppImage`, `.deb`, `.rpm`, or `.snap`
2. **Install and open** the app.
3. Go to **Connections**, enter your Marketing Cloud API credentials, and let the app list your Business Units.
4. Switch to **Export** or **Import** and go.

> **Note on macOS:** until code-signing certificates are configured, macOS builds are **unsigned**. You may need to right-click the app and choose *Open* the first time to get past Gatekeeper.

### Or install with a package manager

If you'd rather use a package manager, these all install the same app:

| Platform | Command |
| --- | --- |
| **Windows** (winget) | `winget install JoernBerkefeld.SFMCDataLoader` |
| **Windows** (Scoop) | `scoop bucket add joern https://github.com/JoernBerkefeld/scoop-bucket` then `scoop install sfmc-dataloader-app` |
| **Linux** (Flatpak) | `flatpak install flathub com.joernberkefeld.SfmcDataLoader` |
| **Arch Linux** (AUR) | `yay -S sfmc-dataloader-app-bin` |

> Package-manager availability rolls out per release; if a channel isn't published yet, use the direct download above. See [`packaging/README.md`](packaging/README.md) for the current status and maintenance details.

### Staying up to date

On **Windows**, **macOS**, and the Linux **AppImage**, the app updates itself: a
few seconds after launch it checks for a newer release, downloads it in the
background, and shows a banner offering to **restart & install**. Updates never
interrupt a running export or import. Installs via **deb/rpm/snap**, **Flatpak**,
or your package manager are updated the usual way (`apt`, `dnf`, `snap`,
`flatpak update`, `winget upgrade`, `scoop update`, …).

## Telemetry & privacy

The app collects **anonymous product statistics only — never any personal or
company data.** Full details are in **[PRIVACY.md](PRIVACY.md)**.

**Always collected** (anonymous, no consent needed):

- App install, update, and launch events — to count active installs.
- App version, operating system + version, CPU architecture, and how the app was
  installed (e.g. NSIS, dmg, AppImage, snap, Flatpak).

**Only if you opt in** (first-run prompt, or the **Settings** tab):

- That an export or import ran, and whether it succeeded.
- File format (CSV/TSV/JSON) and **coarse buckets** for file size, row count, and
  number of Data Extensions.
- Your app language (primary subtag only, e.g. `en`).

**Never collected:** file names, folder paths, file contents, Business Unit
names, credential names, any SFMC data, or anything that identifies you or your
organisation.

**Using the app without telemetry:**

- Decline the first-run prompt (or toggle it off in **Settings**) to disable all
  optional usage events — only the anonymous lifecycle pings remain.
- Prefer **zero** telemetry of any kind? Use the underlying
  [`sfmc-dataloader`](https://www.npmjs.com/package/sfmc-dataloader) CLI directly
  — it has **no telemetry whatsoever**.

Data is ingested through Google Analytics 4's **EU endpoint**. There is no
uninstall event; inactive installs are simply inferred from the absence of launch
pings. See [PRIVACY.md](PRIVACY.md) for the complete policy.

---

## For developers

Everything below is for people who want to build, modify, or release the app. End users can stop here.

This is an **Electron** app that wraps the [`sfmc-dataloader`](https://www.npmjs.com/package/sfmc-dataloader) library (the same engine behind the `mcdata` CLI). Because the library runs in-process, export and import are fully **streamed** — multi-GB Data Extensions never get loaded into memory whole.

### Architecture

| Layer | Location | Responsibility |
| --- | --- | --- |
| Main process | `src/main/` | Window lifecycle, dialogs, IPC handlers, spawns the job worker, drives auto-update (`updater.js`) |
| Preload bridge | `src/preload/` | Allow-listed `window.mcdata` API (contextIsolation, sandbox) |
| Renderer | `src/renderer/` | UI only; no Node access, talks to the bridge |
| Job worker | `src/worker/` | Isolated Node process; thin `parentPort` wiring around the shared job runner that drives `sfmc-dataloader` for export/import |
| Shared | `src/shared/` | Isomorphic helpers reused by main, worker, renderer and tests: IPC channel + job-kind constants, argv builder, progress parser, file-size helpers, update-status state machine, and the injectable job runner (streams logs/progress, reports complete/error) |

The renderer is fully sandboxed (`contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`) with a strict Content-Security-Policy. All privileged work happens in the main
process and the job worker. Credentials are written to the standalone `.mcdatarc.json` /
`.mcdata-auth.json` files and passed to `sfmc-dataloader` without ever appearing in a process's
argv.

### Development

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
npm run dist:mac     # dmg, x64 + arm64 (macOS)
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

Each release ends up with **seven installers** plus electron-builder's auto-update metadata
(`latest*.yml` and `.blockmap` files). The Linux `rpm` build installs `rpm`/rpmbuild on the
runner; the `snap` build runs in a separate, non-fatal step (a snap failure never blocks the
release):

| Platform | Assets |
| --- | --- |
| Windows | `...-win-x64.exe` |
| macOS | `...-mac-x64.dmg`, `...-mac-arm64.dmg` |
| Linux | `...-linux-x64.AppImage`, `...-linux-x64.deb`, `...-linux-x64.rpm`, `...-linux-x64.snap` |

Two optional, credential-gated add-ons run alongside the release and never block it:

| Workflow / secret | Effect when configured |
| --- | --- |
| `winget-publish.yml` + `WINGET_TOKEN` | Auto-submits each release to `microsoft/winget-pkgs` via `wingetcreate` |
| `SNAPCRAFT_STORE_CREDENTIALS` secret | `snap` build also pushes to the Snap Store (otherwise the `.snap` is only attached to the release) |

macOS code signing and notarization are optional and driven by repository secrets — when they are
absent the workflow still succeeds and produces an **unsigned** macOS build:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | base64-encoded `.p12` signing certificate (→ `CSC_LINK`) |
| `MAC_CSC_KEY_PASSWORD` | password for the `.p12` certificate |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

### Telemetry configuration

Telemetry is **off unless Google Analytics credentials are injected at build
time**, so local and forked builds never send anything. The release workflow runs
`scripts/write-analytics-config.mjs`, which reads two GitHub Actions secrets and
writes the git-ignored `src/main/analytics-config.generated.json`:

| Secret | Purpose |
| --- | --- |
| `GA4_MEASUREMENT_ID` | GA4 Measurement ID for the app's data stream |
| `GA4_API_SECRET` | Measurement Protocol API secret for that stream |

If either secret is missing the script skips file creation and the build ships
with telemetry fully disabled. Events are sent from the **main process** only,
non-blocking (deferred, fire-and-forget, timed-out), via GA4's EU endpoint
(`region1.google-analytics.com`). The PII firewall lives in
`src/shared/telemetry-events.js`; user-facing wording and the collected-data
tables are in [PRIVACY.md](PRIVACY.md) — keep all three in sync when telemetry
changes.

### Relationship to `sfmc-dataloader`

This app depends on the `sfmc-dataloader` npm package as a normal runtime dependency and bundles it
into the installer. The optional `mcdev` integration dependency is intentionally excluded
(`omit=optional` in `.npmrc`) — this app uses the standalone `.mcdatarc.json` / `.mcdata-auth.json`
configuration layout only. When `sfmc-dataloader` ships a new version, bump the dependency here,
retest, and release a new installer.

## License

MIT © Joern Berkefeld
