# Changelog

## [0.8.1] — 2026-10-29

### Fixed

- Improve foreground contrast in dialogs and make normal and visited release-note links readable and underlined.
- Keep the update dialog title simply **What's new**. The expandable **Release history** omits every release already shown in the update summary, including skipped updates.
- Render bundled release notes with Markdown headings, lists, emphasis and code. Raw HTML is escaped and images are disabled; only credential-free HTTPS links open in the system browser, with navigation inside the app blocked. Release notes remain available offline from the bundled changelog, without runtime fetching.

The bundled transfer engine is unchanged from app 0.8.0: `sfmc-dataloader` 4.0.0 and parser 5.0.0, running in-process with no external CLI dependency.

## [0.8.0] — 2026-10-29

Adopts [sfmc-dataloader 4.0.0](https://github.com/JoernBerkefeld/sfmc-dataloader/releases/tag/v4.0.0) with [parser 5.0.0](https://github.com/JoernBerkefeld/csv-parser/releases/tag/v5.0.0), replacing loader 3.2.0/parser 4.3.0 shipped in app 0.7.0. There are no intermediate released versions in either dependency interval. The loader runs in-process in the app's worker, not through an external CLI override. Installed apps still need no separate Node.js installation; the development Node.js requirement is unchanged.

### Changed

- CSV/TSV imports select **Skip empty lines** by default, including blank, delimiter-only and quoted-empty records. The old app preference resets to enabled once; uncheck it again to opt out, and subsequent choices survive restarts and upgrades. Explicit opt-outs use `--no-skip-empty-lines`.
- imports automatically remove only the contiguous suffix of exactly empty unnamed headers and final empty records across the logical multipart file set, without changing source files. Named and interior unnamed columns remain. Any nonempty padding cell, including whitespace, is rejected before backup, clear or upload. Unchecking optional skipping retains interior empty records, not trailing file padding. Quoted whitespace and populated multiline fields remain data.
- Physical column widths and strict quote validation remain enforced, including delimiter-only/quoted-empty records at EOF: cleanup does not repair malformed records. With skipping disabled, trailing unquoted blank records can be trimmed, but malformed interior blanks still fail. Inputs with no retained data fail before side effects. Cleanup is reported once per logical source set, separating removed columns/trailing records from optional skips; counts, snapshots and uploads reuse the preflight policy. Keep selected sources unchanged until import finishes: preflight is not a lock, transaction or rollback. JSON imports, API-to-API copies and exports gain no new cleanup behavior.
- Browse imports accept plain CSV filenames such as `Customer.List.csv`, literal `Customers.part1.csv` and uppercase `.CSV`; only the final extension is removed, without URI-decoding the key. Plain TSV/JSON names are not added. Existing `.mcdata` naming takes precedence. Conflicting plain/legacy selections, duplicate unnumbered files or different runs/formats for one DE are rejected before side effects; automatic discovery, export and numbered-part completeness rules remain unchanged. Keys colliding with the reserved `.mcdata` convention must be changed; there is no filename override.

### Added

- Offline release notes appear after an installed update, in an accessible dialog covering 80% of the window in both dimensions. Dismissal is remembered separately from startup telemetry. Skipped release sections are included; fresh installs stay quiet. Full bundled history is available in the dialog.

## [0.7.0] — 2026-10-27

- Baseline desktop release, bundling `sfmc-dataloader` 3.2.0. Streams import/export jobs in-process; no separately installed CLI is used.
