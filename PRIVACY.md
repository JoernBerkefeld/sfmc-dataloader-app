# Privacy Policy — SFMC Data Loader

_Last updated: 2026-07-08_

SFMC Data Loader is a desktop application that exports and imports Salesforce
Marketing Cloud Data Extensions. This document explains exactly what usage
information the app collects, what it never collects, and how to turn optional
collection on or off.

The guiding principle is simple: **anonymous product statistics only — never any
personal or company data.**

## Summary

| | Collected |
|---|---|
| **Always** (anonymous, no consent needed) | App install, update, and launch events; app version; operating system and version; CPU architecture; how the app was installed. |
| **Only with your opt-in** | That an export or import ran and whether it succeeded; file format (CSV/TSV/JSON); coarse buckets for file size, row count, and number of Data Extensions; your app language (primary subtag only, e.g. `en`). |
| **Never** | File names, folder paths, or file contents; Business Unit names; credential names; any SFMC data or metadata; anything that identifies you or your organisation. |

## Who collects it and where it is stored

Telemetry is sent to **Google Analytics 4** using the Measurement Protocol. Data
is ingested through Google's **EU endpoint** (`region1.google-analytics.com`) so
collected events are processed in the European Union. Google acts as the data
processor; see
[Google's Privacy Policy](https://policies.google.com/privacy) and
[How Google Analytics safeguards data](https://support.google.com/analytics/answer/6004245).

Analytics requests are marked non-personalized (`non_personalized_ads: true`),
so the data is not used for advertising personalisation.

## The anonymous client id

To count installs and distinguish a new install from an update or a relaunch,
the app stores a single random identifier (a UUID) in its settings file:

- It is generated locally the first time the app runs.
- It identifies the **installation**, not you. It is **not** derived from your
  machine, hardware, network, user name, or any account.
- It is never combined with any personal information, because none is collected.

The identifier lives in `settings.json` inside the app's user-data directory and
is regenerated if you reinstall or clear that data.

## What is always collected (mandatory, anonymous)

These events let the project count active installs and understand which app
versions and platforms are in use. They contain **no** personal or company data
and are sent regardless of the opt-in setting:

- **`app_install`** — the first time a new installation runs.
- **`app_update`** — the first run after the app version changes.
- **`app_launch`** — each time the app starts (used for active-install counts).

Parameters attached to these events:

- `app_version` — the app's own version (e.g. `0.2.1`).
- `os` — the platform (`win32`, `darwin`, `linux`).
- `os_version` — the operating-system release string.
- `arch` — CPU architecture (e.g. `x64`, `arm64`).
- `install_channel` — how the app was packaged/installed (e.g. `nsis`, `dmg`,
  `appimage`, `snap`, `flatpak`, `windows_store`, `linux_other`).

### Uninstalls

The app does **not** send an uninstall event. There is no reliable,
privacy-respecting, cross-platform way to do so. Instead, an installation that
stops sending `app_launch` pings is simply treated as inactive over time. No
action is taken on your device during uninstall.

## What is collected only with your opt-in

The following usage events are sent **only if you explicitly enable "Send
anonymous usage statistics"** — in the first-run prompt or later in
**Settings**. They help prioritise which features to improve. They still contain
**no** personal or company data:

- **`export_used`** — an export was started.
  - `format` — `csv`, `tsv`, `json`, or `other`.
  - `de_count_bucket` — how many Data Extensions, as a coarse bucket
    (`1`, `2-5`, `6-20`, `21-50`, `>50`).
  - `multi_bu` — whether it was a multi-Business-Unit export (true/false).
- **`import_used`** — an import was started.
  - `format`, `de_count_bucket`, `file_count_bucket` (same bucketing).
  - `size_bucket` — total file size as a coarse bucket
    (`<1MB`, `1-10MB`, `10-100MB`, `100MB-1GB`, `1-10GB`, `>10GB`).
  - `mode` — `upsert` or `insert`.
  - `cross_bu` — whether it was a cross-Business-Unit import (true/false).
- **`job_outcome`** — how a job finished.
  - `kind` — coarse job type (`export`, `import`, …).
  - `result` — `success`, `error`, or `cancelled`.
  - `row_count_bucket` — coarse row-count bucket
    (`1-100`, `101-1K`, `1K-10K`, `10K-100K`, `100K-1M`, `>1M`).

Opt-in events additionally include:

- `locale` — your app's language as the **primary subtag only** (e.g. `en`,
  `de`, `pt`). Region and variant are dropped so it cannot be used to narrow you
  down.

All numeric values above are converted to **coarse buckets** before they leave
your machine. Exact sizes, exact row counts, and exact Data-Extension counts are
never transmitted.

## What is never collected

Under no circumstances does the app collect or transmit:

- File names, folder names, or file/directory paths.
- The contents of any CSV/TSV/JSON file you export or import.
- Business Unit names, Marketing Cloud instance/tenant names, or MIDs.
- Credential names, client IDs, client secrets, tokens, or auth URLs.
- Your name, email address, IP-derived identity, or any account information.
- Any Data Extension field names or row data.

## Using the app without any telemetry

You have several ways to avoid optional telemetry, and one way to avoid all of
it:

- **Opt out of optional usage statistics** — decline the first-run prompt, or
  turn the toggle off in **Settings** at any time. Only the anonymous lifecycle
  events (`app_install` / `app_update` / `app_launch`) remain.
- **Use the underlying CLI instead** — this app wraps the
  [`sfmc-dataloader`](https://www.npmjs.com/package/sfmc-dataloader) command-line
  tool. The CLI has **no telemetry whatsoever**. If you want zero data collection
  of any kind, use the CLI directly.
- **Build without telemetry** — telemetry only works when Google Analytics
  credentials are injected at build time. Any build made without those
  credentials (for example a local or forked build) has telemetry fully
  disabled.

## Data retention and your rights

Collected events are retained according to the project's Google Analytics
configuration and Google's data-retention controls. Because the data is
anonymous and contains no personal identifiers, it cannot be traced back to an
individual to fulfil an access or deletion request for a specific person.

If you have questions about this policy, contact
**Jörn Berkefeld** at
[joern.berkefeld@gmail.com](mailto:joern.berkefeld@gmail.com) or open an issue at
<https://github.com/JoernBerkefeld/sfmc-dataloader-app/issues>.

## Changes to this policy

If what the app collects changes, this file will be updated and the "Last
updated" date at the top revised. Material changes will be noted in the app's
release notes.
