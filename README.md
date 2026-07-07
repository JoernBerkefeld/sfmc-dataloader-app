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

## Is it safe with my credentials?

Yes. Your Marketing Cloud client ID and secret are:

- stored in a local configuration file on **your** computer (never sent anywhere except to Salesforce to log in), and
- **never exposed to other programs** on your machine — the app is built so secrets can't leak onto the system process list, which is a common weakness of command-line tools.

The app window itself is locked down (sandboxed with a strict security policy) and cannot run arbitrary code from the internet.

## Getting started

1. **Download** the installer for your operating system from the [latest release](https://github.com/JoernBerkefeld/sfmc-dataloader-app/releases/latest):
   - **Windows** — `SFMC Data Loader-<version>-win-x64.exe`
   - **macOS** — `SFMC Data Loader-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel)
   - **Linux** — `SFMC Data Loader-<version>-linux-x64.AppImage` or `.deb`
2. **Install and open** the app.
3. Go to **Connections**, enter your Marketing Cloud API credentials, and let the app list your Business Units.
4. Switch to **Export** or **Import** and go.

> **Note on macOS:** until code-signing certificates are configured, macOS builds are **unsigned**. You may need to right-click the app and choose *Open* the first time to get past Gatekeeper.

---

## For developers

Everything below is for people who want to build, modify, or release the app. End users can stop here.

This is an **Electron** app that wraps the [`sfmc-dataloader`](https://www.npmjs.com/package/sfmc-dataloader) library (the same engine behind the `mcdata` CLI). Because the library runs in-process, export and import are fully **streamed** — multi-GB Data Extensions never get loaded into memory whole.

### Architecture

| Layer | Location | Responsibility |
| --- | --- | --- |
| Main process | `src/main/` | Window lifecycle, dialogs, IPC handlers, spawns the job worker |
| Preload bridge | `src/preload/` | Allow-listed `window.mcdata` API (contextIsolation, sandbox) |
| Renderer | `src/renderer/` | UI only; no Node access, talks to the bridge |
| Job worker | `src/worker/` | Isolated Node process; thin `parentPort` wiring around the shared job runner that drives `sfmc-dataloader` for export/import |
| Shared | `src/shared/` | Isomorphic helpers reused by main, worker, renderer and tests: IPC channel + job-kind constants, argv builder, progress parser, file-size helpers, and the injectable job runner (streams logs/progress, reports complete/error) |

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
npm run dist:linux   # AppImage + deb
npm run dist         # all targets for the current OS
```

Output lands in `release/`.

> **Icon:** no custom app icon is configured yet, so builds use the default Electron icon. Add
> `build/icon.ico` (Windows), `build/icon.icns` (macOS), and `build/icon.png` (Linux, 512×512+) —
> electron-builder picks them up automatically from `buildResources: build`.

### Releasing

Publishing is automated by `.github/workflows/build-release.yml`. Creating a **GitHub Release**
triggers a three-OS matrix (`windows-latest`, `macos-latest`, `ubuntu-latest`); each runner lints,
tests, builds its native installers, and uploads them to that release via electron-builder's GitHub
publish provider (`--publish always`).

Each release ends up with **five installers** plus electron-builder's auto-update metadata
(`latest*.yml` and `.blockmap` files):

| Platform | Assets |
| --- | --- |
| Windows | `...-win-x64.exe` |
| macOS | `...-mac-x64.dmg`, `...-mac-arm64.dmg` |
| Linux | `...-linux-x64.AppImage`, `...-linux-x64.deb` |

macOS code signing and notarization are optional and driven by repository secrets — when they are
absent the workflow still succeeds and produces an **unsigned** macOS build:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | base64-encoded `.p12` signing certificate (→ `CSC_LINK`) |
| `MAC_CSC_KEY_PASSWORD` | password for the `.p12` certificate |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

### Relationship to `sfmc-dataloader`

This app depends on the `sfmc-dataloader` npm package as a normal runtime dependency and bundles it
into the installer. The optional `mcdev` integration dependency is intentionally excluded
(`omit=optional` in `.npmrc`) — this app uses the standalone `.mcdatarc.json` / `.mcdata-auth.json`
configuration layout only. When `sfmc-dataloader` ships a new version, bump the dependency here,
retest, and release a new installer.

## License

MIT © Joern Berkefeld
