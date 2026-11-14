# Verify o8 release downloads

Every public Windows and Linux installer has a SHA-256 checksum and a signed
GitHub build-provenance attestation. Release AppImages also contain an embedded
GPG signature made by the o8 Linux release key.

## Verify build provenance

Download an installer, install the GitHub CLI, and run:

```bash
gh attestation verify ./o8-X.Y.Z-x86_64.AppImage \
  --repo o8-run/o8
```

Replace `X.Y.Z` with the downloaded version and use the actual downloaded basename
for historical releases. Existing assets are not renamed. Use the same command
for the Windows MSI or EXE and the Linux DEB or RPM. A
successful result ties the exact downloaded bytes to the public o8 repository,
workflow, and commit recorded by GitHub's Sigstore-backed attestation service.

## Verify checksums

Download `SHA256SUMS-windows-linux-preview.txt` beside the installers, then run:

```bash
sha256sum --check SHA256SUMS-windows-linux-preview.txt
```

## Verify the AppImage signature

The public key is in
[`docs/user/o8-linux-release-signing.asc`](./o8-linux-release-signing.asc). Its
fingerprint is:

```text
9C8E BBFE EE6C C183 D495 5D52 3787 DCFF EBA0 FC78
```

Import the public key and use the AppImage validation tool described in the
[Tauri Linux signing guide](https://v2.tauri.app/distribute/sign/linux/). The
validator should report this fingerprint and a successful signature check.

Windows installers additionally need an Authenticode publisher signature to
avoid the unsigned-publisher warning in Windows. Build-provenance attestation
proves origin and integrity, but it does not replace Authenticode trust.
