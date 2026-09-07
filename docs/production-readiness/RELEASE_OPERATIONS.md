# ZAIPOS release operations

Production Windows releases are built only by `.github/workflows/release.yml` after the same migration, transaction, localization, lint, test, and build gates used for `main` have passed.

## Stable channel

1. Set `package.json` to the intended stable semantic version, for example `1.1.0`.
2. Merge that version through the normal protected-branch review path.
3. Create an annotated, cryptographically signed tag with the exact version, for example `v1.1.0`.
4. Push the tag. The workflow verifies both the version match and GitHub's tag-signature status before packaging.
5. The signed NSIS installer, block map, and `latest.yml` are published to the GitHub Release. Installed stable terminals are notified but must approve download and installation.

The workflow preserves its signed artifacts for 90 days, and GitHub Releases retain prior installers. Never delete the current known-good release when publishing its successor.

## Beta channel

Beta versions use a SemVer prerelease in `package.json`, for example `1.2.0-beta.1`, and an identically named signed tag such as `v1.2.0-beta.1`. The workflow publishes the release as a prerelease and produces beta updater metadata. A terminal receives beta releases only after a manager changes Settings → Devices → Update channel to Beta and restarts ZAIPOS.

Beta terminals may receive stable releases when Electron's channel rules consider the stable version newer. Stable terminals never opt into prereleases automatically.

## Signing

The repository must define these GitHub Actions secrets:

- `WINDOWS_CSC_LINK`: base64-encoded PFX certificate data or a secure certificate URL supported by electron-builder; mapped to `CSC_LINK` only inside the Windows release job.
- `WINDOWS_CSC_KEY_PASSWORD`: certificate password; mapped to `CSC_KEY_PASSWORD` only inside the Windows release job.

The certificate must be issued by a trusted Windows code-signing certificate authority and must not be committed to the repository. The workflow fails with `Unsigned production releases are forbidden` when either credential is absent. Unsigned local development builds remain available through `npm run build:electron:dir`; they are not production releases.

After downloading a release artifact, verify its Authenticode signature and SHA-256 digest before rollout. Do not distribute an artifact if the signer or digest differs from the GitHub Actions output.

## Rollback

1. In Settings → Devices, identify affected versions and branches from the terminal heartbeat list.
2. Pause the affected rollout. Do not delete its release evidence.
3. Download the previous known-good signed installer from its retained GitHub Release.
4. Close ZAIPOS after confirming offline operations are synchronized or explicitly retained for review.
5. Uninstall the affected desktop version only if the installer cannot perform the controlled downgrade. Do not delete the Electron user-data directory or IndexedDB queue.
6. Reinstall the previous signed installer, select Stable unless the terminal is an approved beta device, then start ZAIPOS.
7. Verify login, branch assignment, terminal heartbeat/version, pending queue state, product lookup, printer connectivity, and a non-financial hardware test.
8. Record the affected device IDs, versions, reason, time, and operator in the incident record.

Electron auto-downgrade is intentionally disabled. Rollback is a controlled reinstall so a remote metadata error cannot silently downgrade every terminal.

## Release health and updater behavior

The updater checks GitHub Releases after startup. It reports the available version and release notes, but `autoDownload` and install-on-quit are disabled. The operator explicitly approves download and then explicitly approves installation/restart. Settings → Devices reports device ID, branch, app version, OS, update channel, update state, and last-seen time; versions differing from the viewing manager's packaged version are highlighted for investigation.

Updater, packaging, signature, and migration failures are release-blocking. Secrets, certificate bytes, passwords, and payment data must never be written to logs.
