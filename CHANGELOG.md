# Changelog

## [0.9.0] — 2026-11-05

Adopts [sfmc-dataloader 4.1.0](https://github.com/JoernBerkefeld/sfmc-dataloader/releases/tag/v4.1.0), replacing loader 4.0.0 resolved by app 0.8.1's tagged lockfile. Parser 5.0.0 is unchanged. There are no intermediate loader releases in this interval. The loader runs in-process in the app worker; no external CLI is used.
### Added

- Browse imports now accept plain `.tsv` and `.json` filenames as well as `.csv`, including uppercase extensions. Only the final extension is removed: dots, percent escapes and `partN` remain literal DE-key text. Existing `.mcdata` filenames retain legacy decoding and multipart/timestamp precedence; keys colliding with that reserved convention must be changed. Directory discovery still requires exported `.mcdata` names, and export naming is unchanged.

### Fixed

- Invalid filename and ambiguous-selection errors identify unsupported names, duplicate unnumbered files and mixed runs/formats for one DE; these selections fail before side effects.
- JSON imports accept a row array or an `items` array, but every row must be a non-null object, not an array or primitive. Invalid later rows fail before backup, CLEAR or upload.
- File-import validation rejects a row whose single-row JSON `items` request envelope exceeds 5,500,000 UTF-8 bytes, including CSV/TSV rows after parsing. Cross-BU API imports also validate downloaded source snapshots before target effects. Existing row-count batching and CSV/TSV cleanup defaults remain unchanged; no opt-out bypasses row validation. JSON files are still parsed in full, so memory use depends on the largest part. Keep sources unchanged through import: preflight is not a file lock, transaction or rollback.

See the [complete loader 4.0.0–4.1.0 changes](https://github.com/JoernBerkefeld/sfmc-dataloader/compare/v4.0.0...v4.1.0) for optional upstream detail.

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
