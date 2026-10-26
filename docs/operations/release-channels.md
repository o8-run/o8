# Release channels

`main` is the integration branch. Use a short-lived branch and reviewed pull
request for each change. Required checks, resolved conversations and an up-to-date
branch remain mandatory. Publication requires a separate operator decision.

## Installed channels

Settings > General > Updates offers Stable (default) and Beta. Both use the same
application identity and existing data. The channel chooses the update manifest;
it does not create a second installation or isolate daily application data.
Returning to Stable waits for a newer stable version and never downgrades.

See [Beta and stable update feeds](beta-updates.md) for publication details.
Stable remains the default release workflow, including report reconciliation,
`fixed.json`, update warmup, the changelog and announcements. An explicitly
selected `O8_RELEASE_CHANNEL=beta` creates a prerelease and advances only
`beta.json`, without writing stable assets or feeds. A later stable release
includes report fixes from intervening betas. Promotion is tracked separately
in [#4857](https://github.com/o8-run/o8/issues/4857).

## Explicit previews

The separate preview path requires a unique `X.Y.Z-preview.N` version and
`O8_RELEASE_CHANNEL=preview`. Its dry run prints the publication policy.
A separately approved ship creates immutable prereleases with `preview.json`
and signed installers. It advances neither installed channel and skips stable
feeds, report receipts and announcements. Preview candidates cannot be clobbered.

The manual hosted fallback remains preview-only and stages a draft prerelease.
Neither scheduled verification nor a branch push publishes an installer.

## Source verification

Nightly source verification is separate from installed acceptance. It does not
create installers, tags, releases, manifests or announcements. Development
servers that change state must use disposable `O8_DATA_DIR` and
`CORTEX_IDE_DATA_DIR` locations and separate API and socket ports.

Version changes and release-note archives retain their existing review gates.
Publication never commits archives to protected main or changes its permissions.
