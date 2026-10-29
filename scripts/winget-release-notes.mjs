import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const PACKAGE_ID = 'JoernBerkefeld.SFMCDataLoader';

/**
 * Selects exactly one stable release's notes, never the latest or a previous release.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function releaseNotes(changelog, version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`Invalid stable release version: ${version}`);
    }
    const sections = changelog
        .replaceAll('\r\n', '\n')
        .matchAll(/^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)
        .filter((match) => match[1] === version)
        .toArray();
    const notes = sections[0]?.[2].trim();
    if (!notes || sections.length !== 1 || notes.length > 10_000) {
        throw new Error(
            `Expected one nonempty CHANGELOG section (at most 10000 characters) for ${version}.`,
        );
    }
    return notes;
}

/**
 * Updates the actual locale YAML while preserving unrelated manifest fields.
 *
 * @param {string} source
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function enrichLocale(source, changelog, version) {
    const notes = releaseNotes(changelog, version);
    const document = parseDocument(source);
    if (document.errors.length > 0) {
        throw new Error(`Invalid locale YAML: ${document.errors[0].message}`);
    }
    if (
        document.get('PackageIdentifier') !== PACKAGE_ID ||
        document.get('PackageVersion') !== version ||
        document.get('ManifestType') !== 'defaultLocale' ||
        document.get('PackageLocale') !== 'en-US'
    ) {
        throw new Error(`Expected ${PACKAGE_ID} ${version} en-US defaultLocale manifest.`);
    }
    document.set('ReleaseNotes', notes);
    document.set(
        'ReleaseNotesUrl',
        `https://github.com/JoernBerkefeld/sfmc-dataloader-app/releases/tag/v${version}`,
    );
    return document.toString({ lineWidth: 0 });
}

// The workflow supplies the same generated directory to enrichment and submit.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const [directory, version, changelogFile] = process.argv.slice(2);
    const file = path.join(directory, `${PACKAGE_ID}.locale.en-US.yaml`);
    const changelog = await readFile(
        changelogFile ?? new URL('../CHANGELOG.md', import.meta.url),
        'utf8',
    );
    await writeFile(file, enrichLocale(await readFile(file, 'utf8'), changelog, version));
}
