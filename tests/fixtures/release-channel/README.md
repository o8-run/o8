# Public release-channel fixtures

These are synthetic, precomputed updater archives for the real
`scripts/release.mjs` entry-point tests. They contain handcrafted, non-runnable
Mach-O headers, a minimal `Info.plist`, an `o8/next-build/v1` receipt, and an
`o8/build-channel/v1` identity under `Contents/Resources/server`.

The Stable version is `0.1.741`; Preview is `0.1.741-preview.1`. Each channel has
universal, x86_64, and arm64 archives. Stable also has intentionally invalid
missing-next, thin-main, stale-next-hash, and stale-next-commit variants. Those
negative archives have valid updater signatures so their tests reach the
specific bundle or receipt guard rather than stopping at authentication.

The archives were assembled once outside the test runner with sorted tar
entries, zero UID/GID, and a fixed `2026-09-01T00:00:00Z` timestamp. A disposable,
fixture-only Ed25519 key authenticated their BLAKE2b-512 digests using the
updater's `ED` packet format. Only the public key and signatures are retained;
no private key, production credential, platform code signature, or notarization
ticket is included. The files are test data, not o8 release artifacts.

`manifest.json` uses the `o8/release-channel-fixtures/v1` schema and records each
archive's filename, signature filename, channel, version, purpose, and SHA-256.
`public-key.txt` is the updater's base64-wrapped public-key packet;
`next-build.json` is the expected current-build receipt.

Tests copy and extract these bytes and authenticate them through the production
verifier. Tampering tests keep the original signature. Platform verification,
Publication, announcement, and receipt effects are simulated and recorded. The test
runner never creates signing keys, signs, notarizes, builds an installer, or
contacts a publication service.
