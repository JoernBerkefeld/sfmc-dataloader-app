# Privacy Policy — SFMC Data Loader

_Last updated: 2026-10-26_

SFMC Data Loader exports and imports Salesforce Marketing Cloud Data Extension
rows. This policy distinguishes local application data, Salesforce traffic, and
optional product analytics.

## Your choice applies to every analytics event

**No analytics events are sent until affirmative consent has been saved.** This
includes first-consented-run, update, launch, loader-version, and usage events.
You can decline the first-run dialog, dismiss it with Escape, or switch off
**All app telemetry (optional)** in **Settings**. The dialog initially focuses
**No thanks**. Declining does not disable transfers or other app features.

The current consent schema is version **1**. An older saved enabled choice without
that version requires renewed consent; it does not enable analytics automatically.
An existing declined choice remains declined.

Enabling analytics takes effect only after the affirmative choice is successfully
written to the local settings file. A failed opt-in save leaves analytics disabled
and offers a retry. A failed save of other settings does not invalidate an already
saved affirmative choice. Turning analytics off takes effect immediately in the
current session, even if saving fails; if that happens, retry so the next launch
also uses your new choice.

On a consent change, the sender discards queued events and aborts in-flight
requests. Withdrawal cannot recall events already delivered, and an abort cannot
guarantee a request has not reached the provider. Shutdown also discards pending
analytics rather than waiting to send it. Events from before consent, across a
consent change, or dropped because of a failed save are not replayed after opt-in.
There is no persistent analytics queue or delivery retry.

## Provider and pseudonymous installation identifier

Packaged builds send consenting events from the main process to **PostHog's EU
ingestion endpoint**, `https://eu.i.posthog.com/batch/`, using project **254290**,
shared with the VS Code extension. Every app event includes
`app: 'sfmc-dataloader-app'` so the desktop app can be distinguished from the
extension. Google Analytics 4 is no longer used by the app.

A random UUID is generated locally and persisted as `clientId` in `settings.json`
in the app's user-data directory. It is sent as PostHog's `distinct_id`. It is not
derived from your hardware, account, credentials, or project. It persists while
that settings data remains; reinstalling alone need not remove it.

**This identifier is pseudonymous, not guaranteed anonymous.** It links consenting
events from the same installation. The app requests no person-profile processing
(`$process_person_profile: false`), but the provider also receives ordinary
connection metadata, including the source IP address. An EU ingestion URL is not
a guarantee about all subsequent processing locations. Project retention,
IP/geolocation processing, and other provider-side settings have not been
verified by this code/documentation review. See [PostHog's privacy
policy](https://posthog.com/privacy) for provider information.

## Event catalogue

The payload boundary is `src/shared/telemetry-events.js`; actual collection is
controlled by `src/main/analytics.js`, `src/main/main.js`, and the job manager.
All events below require saved affirmative consent. Each includes `app_version`,
the pseudonymous identifier, the app discriminator, and a send timestamp.

### Consenting lifecycle and runtime

- **`app_first_consented_run`** — emitted after the first successfully saved
  affirmative choice under the current consent schema, together with a launch
  event. It is **not an install count**, including after migration/reconsent.
- **`app_update`** — a consenting startup where the stored app version differs
  from the current version.
- **`app_launch`** — a consenting startup or first successful opt-in. These are
  consenting runs, not all users or all active installations.
- Lifecycle fields: `os`, `os_version`, `arch`, and `install_channel` (`nsis`,
  `dmg`, `appimage`, `snap`, `flatpak`, `windows_store`, `linux_other`, or
  `unknown`). Lifecycle events do not include locale.
- **`loader_version`** — the resolved installed loader package's numeric release
  version, or `unknown`, at consenting startup or first opt-in. It is not a
  dependency range, executable path, or CLI-source inventory.

There is no install or uninstall event. A first-consented-run event is best-effort,
not a guarantee of exactly-once network delivery. Absence of launches does not
prove uninstallation.

### Transfer usage

- **`export_used`** — an accepted export start: `format` (`csv`, `tsv`, `json`, or
  `other`), `de_count_bucket` for selected keys, and `multi_bu` (boolean).
- **`import_used`** — an accepted import start: `format`, `de_count_bucket`,
  `file_count_bucket`, `size_bucket`, `mode` (`upsert` or `insert`), and `cross_bu`
  (boolean). Explicit-file format is inferred from the first file's extension;
  unavailable formats become `other`. File sizes are summed locally; an
  unreadable size contributes zero. For key-based imports the DE count is keys
  multiplied by targets; for file imports it is target count, not a discovered
  count of file contents. API copies have no selected-file size.
- **`job_outcome`** — `kind` (`export`, `export_multi_bu`, `import`,
  `import_cross_bu`, `init`, or `unknown`), `result` (`success`, `error`,
  `cancelled`, or `unknown`), `row_count_bucket`, and `duration_bucket`.
  Connection setup uses `init`. Rows describe the highest row count seen in
  progress, not necessarily an aggregate of every DE or final committed rows.

Job duration starts after the worker is created and runs until its actual exit,
including worker startup and shutdown, but excluding renderer selection and
confirmation time. A rejected/failed start is reported with a zero duration.
Cancellation describes the local worker outcome, not a rollback or proof that
Salesforce stopped processing.

### Configuration and discovery actions

**`action_outcome`** covers `config_load` and `de_discovery`, with `result`,
`duration_bucket`, `bu_count_bucket`, and two project-presence booleans:
`is_mcdev_project` and `is_mcdata_project`. The booleans come from existence checks
of the corresponding public configuration filenames, not their contents.
Configuration reads bucket the number of returned BUs; a single-BU discovery
request reports one BU. This does not reveal which BU was queried or how many DEs
it contains.

Action timing covers the main-process configuration/discovery request, excluding
renderer prompts and the later filename-presence checks. It is not an end-to-end
UI or network-only latency measurement.

Transfer usage, job outcomes, and action outcomes also include `locale`, reduced
to a two- or three-letter primary language subtag (for example `en`), or `unknown`.

### Buckets and closed error metadata

- DE/file/BU counts: `0`, `1`, `2-5`, `6-20`, `21-50`, `>50`.
- File sizes (binary thresholds): `0`, `<1MB`, `1-10MB`, `10-100MB`,
  `100MB-1GB`, `1-10GB`, `>10GB`.
- Rows: `0`, `1-100`, `101-1K`, `1K-10K`, `10K-100K`, `100K-1M`, `>1M`.
- Duration: `unknown`, `<1s`, `1-10s`, `10-60s`, `1-10m`, `>=10m`.
  Exact duration, size, row count, and selection counts are not sent.
  **Exact p50/p95 latency cannot be calculated from these duration buckets.**

Error outcomes may include only a closed vocabulary:

- `error_category`: `start_failed`, `job_failed`, `worker_error`, `worker_exit`,
  `config_unavailable`, `discovery_failed`, or `unknown`.
- `error_name`: `Error`, `TypeError`, `RangeError`, `SyntaxError`, `AbortError`,
  or `other`.
- `error_code`: `ENOENT`, `EACCES`, `EPERM`, `ENOTDIR`, `ETIMEDOUT`, `ECONNRESET`,
  `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, or `other`.

Unrecognised errors become these fallback values, not arbitrary text. Current
action call sites supply a category but no raw error name/code; those fields
therefore use the safe fallback values on action errors.

## Data excluded from analytics

The app's analytics payload does not include:

- File names, folder paths, file contents, or project paths.
- DE customer keys, DE/field names, or row values.
- BU names or MIDs, tenant identities, or credential labels.
- Client IDs, client secrets, auth URLs, or access tokens.
- Raw error messages, stacks, log contents, or editor/extension inventory.
- Names or email addresses supplied by the user.

These exclusions concern analytics, not normal transfers to Salesforce or local
files. Credentials remain in local project configuration/auth files; those files
are not an encrypted credential vault. Debug logs can contain sensitive API data
and should be reviewed before sharing. Local app settings also hold the selected
project path and transfer defaults; those values are not analytics payloads.

## Builds, retention, and questions

Development/unpackaged builds disable analytics. Packaged builds use public
PostHog ingestion configuration, not generated GA4 build secrets, and still
require saved consent. Analytics is best-effort, deferred, and request-timeout
bounded; offline or failed requests are dropped without replay. Update checks
and Salesforce operations are separate network activity, not enabled/disabled by
the analytics choice.

This policy does not promise a particular provider retention period, geographic
processing configuration, or automatic deletion when consent is withdrawn.
For questions about access or deletion, or this policy, contact **Jörn Berkefeld**
at [joern.berkefeld@gmail.com](mailto:joern.berkefeld@gmail.com) or open an issue at
<https://github.com/JoernBerkefeld/sfmc-dataloader-app/issues>. Do not post credentials
or sensitive logs in public issues.

Changes to collection will be reflected here and in release notes where relevant.
