# Packaging & distribution

All install channels are fed from the **same GitHub Release** artifacts produced
by `.github/workflows/build-release.yml`. GitHub Releases stay the single source
of truth; every package manager below just points at those assets.

Per release, the workflow builds and uploads:

| Platform | Artifacts | Auto-updates? |
| --- | --- | --- |
| Windows | `sfmc-dataloader-app-<version>-win-x64.exe` (NSIS) | Yes — in-app (electron-updater) |
| macOS | `sfmc-dataloader-app-<version>-mac-x64.dmg`, `-mac-arm64.dmg` | Yes — in-app (electron-updater, needs signing) |
| Linux | `-linux-x64.AppImage`, `-linux-x64.deb`, `-linux-x64.rpm`, `-linux-x64.snap` | AppImage: in-app; deb/rpm/snap: package manager |

## In-app auto-update (electron-updater)

- Windows (NSIS), macOS (dmg) and Linux (AppImage) self-update: the app checks
  GitHub Releases a few seconds after launch, downloads in the background, and
  shows a banner offering **Restart & install**. Installs are never forced — a
  running export/import is never interrupted.
- deb/rpm/snap report the updater as inactive, so the app stays silent and lets
  the OS package manager handle updates.
- macOS auto-update only works with a **signed + notarized** build. Provide the
  `MAC_CSC_LINK` / `APPLE_*` repository secrets to enable signing.

## Channels

### Scoop (Windows, developers) — `scoop/sfmc-dataloader-app.json`

Publish to a bucket (e.g. a `scoop-bucket` repo) so users can:

```powershell
scoop bucket add joern https://github.com/JoernBerkefeld/scoop-bucket
scoop install sfmc-dataloader-app
```

`checkver` + `autoupdate` let `scoop update` track new releases automatically.
Refresh the `hash` when seeding the first version (`scoop` computes later ones
via `autoupdate`).

### winget (Windows, built-in) — `winget/`

Three-file manifest for `JoernBerkefeld.SFMCDataLoader`. First submission is a
one-time PR to [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs).
After that, `.github/workflows/winget-publish.yml` auto-submits each release when
a `WINGET_TOKEN` secret (a PAT that can fork winget-pkgs) is present. Then:

```powershell
winget install JoernBerkefeld.SFMCDataLoader
```

### Flatpak / Flathub (Linux) — `flatpak/`

`com.joernberkefeld.SfmcDataLoader.yml` repackages the release `.deb` inside the
Electron BaseApp sandbox. Build/test locally:

```bash
flatpak install flathub org.freedesktop.Sdk//24.08 org.freedesktop.Platform//24.08 org.electronjs.Electron2.BaseApp//24.08
flatpak-builder --user --install --force-clean build-dir \
    packaging/flatpak/com.joernberkefeld.SfmcDataLoader.yml
```

For Flathub submission, open a PR to
[`flathub/flathub`](https://github.com/flathub/flathub) with this manifest. The
`x-checker-data` block lets Flathub's external-data-checker bot bump the `.deb`
url + sha256 automatically on new releases.

### AUR (Arch Linux) — `aur/PKGBUILD`

Binary package `sfmc-dataloader-app-bin` that repackages the AppImage:

```bash
git clone ssh://aur@aur.archlinux.org/sfmc-dataloader-app-bin.git
cp packaging/aur/PKGBUILD sfmc-dataloader-app-bin/
cd sfmc-dataloader-app-bin
updpkgsums                                   # fills in sha256sums
makepkg --printsrcinfo > .SRCINFO
git commit -am "upgpkg: <version>" && git push
```

## Per-release maintenance checklist

After a new `vX.Y.Z` release is published:

1. **Scoop** — bump `version` + `hash` (or rely on `scoop update` autoupdate).
2. **winget** — automatic via `winget-publish.yml` (or run `wingetcreate update`
   locally); otherwise bump `PackageVersion` + `InstallerSha256` in all three
   YAML files.
3. **Flatpak** — bump the `.deb` `url` + `sha256` (or let the Flathub bot do it).
4. **AUR** — bump `pkgver`, run `updpkgsums`, regenerate `.SRCINFO`, push.

Nothing here blocks the core release: the GitHub Release + in-app auto-update
work on their own, and each package-manager channel is best-effort on top.
