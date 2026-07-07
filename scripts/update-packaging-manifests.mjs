#!/usr/bin/env node
/**
 * Refreshes every package-manager manifest under `packaging/` for a given
 * release version. It downloads the matching GitHub Release assets, computes
 * their SHA256, and rewrites the version + url + hash fields in:
 *
 *   - packaging/scoop/sfmc-dataloader-app.json          (Windows .exe)
 *   - packaging/flatpak/com.joernberkefeld.SfmcDataLoader.yml  (Linux .deb)
 *   - packaging/aur/PKGBUILD                            (Linux .AppImage)
 *   - packaging/winget/*.yaml                           (Windows .exe)
 *
 * winget is *also* published by wingetcreate in winget-publish.yml (it opens the
 * PR against microsoft/winget-pkgs); updating the local manifests here just
 * keeps the in-repo seed coherent with the release.
 *
 * Usage:
 *   node scripts/update-packaging-manifests.mjs --version 1.2.3
 *   VERSION=1.2.3 node scripts/update-packaging-manifests.mjs
 *   # in CI the release tag is picked up from GITHUB_REF_NAME (e.g. "v1.2.3")
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'JoernBerkefeld/sfmc-dataloader-app';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'packaging');

/**
 * Resolves the release version from CLI args or environment, stripping any
 * leading "v" so "v1.2.3" and "1.2.3" both work.
 *
 * @returns {string} the semver string without a leading "v"
 */
function resolveVersion() {
    const argumentIndex = process.argv.indexOf('--version');
    const raw =
        (argumentIndex !== -1 && process.argv[argumentIndex + 1]) ||
        process.env.VERSION ||
        process.env.GITHUB_REF_NAME ||
        '';
    const version = raw.trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(version)) {
        throw new Error(
            `Could not resolve a release version. Pass --version X.Y.Z or set VERSION / GITHUB_REF_NAME (got "${raw}").`,
        );
    }
    return version;
}

/**
 * Streams a release asset and returns its SHA256 as a lowercase hex string.
 *
 * @param {string} url the browser_download_url of the asset
 * @returns {Promise.<string>} lowercase hex SHA256 digest
 */
async function sha256OfUrl(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Failed to download ${url} — HTTP ${response.status}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

/**
 * Reads a file, applies a replacer, and writes it back only when the content
 * actually changed (keeps the diff and mtime clean on no-op runs).
 *
 * @param {string} filePath absolute path to the file
 * @param {(content: string) => string} replacer transforms the file content
 * @returns {Promise.<boolean>} whether the file was rewritten
 */
async function editFile(filePath, replacer) {
    const before = await readFile(filePath, 'utf8');
    const after = replacer(before);
    if (before === after) {
        return false;
    }
    await writeFile(filePath, after);
    return true;
}

/**
 * Builds the release download URL for a given asset filename.
 *
 * @param {string} version release version without a leading "v"
 * @param {string} filename asset filename
 * @returns {string} the full browser_download_url
 */
function assetUrl(version, filename) {
    return `https://github.com/${REPO}/releases/download/v${version}/${filename}`;
}

async function main() {
    const version = resolveVersion();

    const assets = {
        win: `sfmc-dataloader-app-${version}-win-x64.exe`,
        deb: `sfmc-dataloader-app-${version}-linux-amd64.deb`,
        appImage: `sfmc-dataloader-app-${version}-linux-x86_64.AppImage`,
    };

    console.log(`Updating packaging manifests for v${version}…`);

    const [winHash, debHash, appImageHash] = await Promise.all([
        sha256OfUrl(assetUrl(version, assets.win)),
        sha256OfUrl(assetUrl(version, assets.deb)),
        sha256OfUrl(assetUrl(version, assets.appImage)),
    ]);

    const changed = [];

    const winExe = `sfmc-dataloader-app/releases/download/v${version}/sfmc-dataloader-app-${version}-win-x64.exe`;
    const linuxDeb = `sfmc-dataloader-app/releases/download/v${version}/sfmc-dataloader-app-${version}-linux-amd64.deb`;

    // --- Scoop (Windows .exe) ---
    if (
        await editFile(path.join(PKG, 'scoop', 'sfmc-dataloader-app.json'), (c) =>
            c
                .replace(/("version":\s*")[^"]*(")/, (_m, p1, p2) => `${p1}${version}${p2}`)
                .replaceAll(
                    /sfmc-dataloader-app\/releases\/download\/v[\d.]+\/sfmc-dataloader-app-[\d.]+-win-x64\.exe/g,
                    () => winExe,
                )
                .replace(/("hash":\s*")[0-9a-fA-F]*(")/, (_m, p1, p2) => `${p1}${winHash}${p2}`),
        )
    ) {
        changed.push('packaging/scoop/sfmc-dataloader-app.json');
    }

    // --- Flatpak (Linux .deb) ---
    if (
        await editFile(path.join(PKG, 'flatpak', 'com.joernberkefeld.SfmcDataLoader.yml'), (c) =>
            c
                .replaceAll(
                    /sfmc-dataloader-app\/releases\/download\/v[\d.]+\/sfmc-dataloader-app-[\d.]+-linux-amd64\.deb/g,
                    () => linuxDeb,
                )
                .replace(/(sha256:\s*')[0-9a-fA-F]*(')/, (_m, p1, p2) => `${p1}${debHash}${p2}`),
        )
    ) {
        changed.push('packaging/flatpak/com.joernberkefeld.SfmcDataLoader.yml');
    }

    // --- AUR (Linux .AppImage) ---
    if (
        await editFile(path.join(PKG, 'aur', 'PKGBUILD'), (c) =>
            c
                .replace(/(pkgver=)[\d.]+/, (_m, p1) => `${p1}${version}`)
                .replace(
                    /(sha256sums=\(')[0-9a-fA-F]*('\))/,
                    (_m, p1, p2) => `${p1}${appImageHash}${p2}`,
                ),
        )
    ) {
        changed.push('packaging/aur/PKGBUILD');
    }

    // --- winget (Windows .exe) — seed only; wingetcreate publishes the PR ---
    const wingetUpper = winHash.toUpperCase();
    const wingetFiles = [
        'JoernBerkefeld.SFMCDataLoader.yaml',
        'JoernBerkefeld.SFMCDataLoader.locale.en-US.yaml',
        'JoernBerkefeld.SFMCDataLoader.installer.yaml',
    ];
    for (const file of wingetFiles) {
        if (
            await editFile(path.join(PKG, 'winget', file), (c) =>
                c
                    .replace(/(PackageVersion:\s*)[\d.]+/, (_m, p1) => `${p1}${version}`)
                    .replaceAll(
                        /sfmc-dataloader-app\/releases\/download\/v[\d.]+\/sfmc-dataloader-app-[\d.]+-win-x64\.exe/g,
                        () => winExe,
                    )
                    .replace(
                        /(InstallerSha256:\s*)[0-9a-fA-F]*/,
                        (_m, p1) => `${p1}${wingetUpper}`,
                    ),
            )
        ) {
            changed.push(`packaging/winget/${file}`);
        }
    }

    if (changed.length === 0) {
        console.log('All packaging manifests already up to date.');
    } else {
        console.log(`Updated:\n${changed.map((f) => `  - ${f}`).join('\n')}`);
    }
}

try {
    await main();
} catch (ex) {
    console.error(ex.message);
    process.exit(1);
}
