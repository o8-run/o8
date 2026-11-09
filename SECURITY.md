# Security

## Pre-launch security review

o8's surface was adversarially reviewed before the repository was made public. Twenty findings were identified and fixed; the public summary — classes, severities, and how each was resolved — is [issue #1643](https://github.com/o8-run/o8/issues/1643).

Root-cause write-ups for those findings are retained privately rather than published. Every one is fixed in current releases, but signed builds of earlier versions remain downloadable, and a published exploit chain would apply to anyone still running one. The redaction protects those users; it does not indicate an unresolved issue. Accepted residual risks are tracked as open issues rather than carried silently.

## Supported platform and secret storage

o8's supported production platform is macOS. Provider voice secrets saved through the app are stored in the macOS Keychain. The current Windows and Linux paths fall back to a plaintext `dictation.json` file; the writer enforces mode `0600` on Unix platforms, but this is not equivalent to a platform credential store. Windows and Linux builds are unsupported today for storing provider voice secrets.

The at-rest encryption master key also uses the macOS Keychain when it is available. If Keychain storage is unavailable, o8 persists a randomly generated key in a plaintext `master-key` file with mode `0600`. This preserves a stable encryption key across restarts, but it provides weaker protection than Keychain-backed storage, so production support assumes that the macOS Keychain path is available.

## How dispatched workers run

A worker that o8 dispatches on your machine runs under your user account — the same posture as running `claude` or `codex` yourself in a terminal, which is what o8 is orchestrating on your behalf. o8 governs what an agent may do to your repository: what it can reach, what it may merge, and what requires your approval. That governance holds regardless of this setting, and it is enforced in o8's own principal and approval layers rather than by the operating system.

Operating-system confinement is a separate layer. On macOS it is on by default: locally dispatched workers run inside a seatbelt sandbox, which is fail-closed — if the sandbox cannot be established, the worker does not run. `O8_WORKER_SANDBOX=off` turns it off. On Linux it is off by default, and `O8_WORKER_SANDBOX=on` runs workers under bubblewrap with the same fail-closed rule. The profile, what it admits and its known limits are described in [the worker sandbox profile](docs/internals/worker-sandbox-profile.md). Making it the default everywhere is tracked in [issue #1657](https://github.com/o8-run/o8/issues/1657).

The practical read: o8's default does not expand the trust you already extend to the coding CLIs it drives, and it adds a governance layer those CLIs do not have on their own. If your threat model includes a fully malicious worker rather than a prompt-injected one, keep the sandbox on (on Linux, turn it on) and read its known limits.

## Known dependency risk

The current `next` dependency inherits known high-severity `sharp` and libvips advisories. The automated npm remediation would move the application across a breaking Next.js major version, so that change is deferred until it can be migrated and tested safely. This remains a tracked residual risk and is surfaced by the scheduled dependency-audit job.

CodeQL is managed through GitHub's default setup in repository settings rather than a checked-in workflow. This repository intentionally does not include a separate CodeQL workflow file.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting form for `o8-run/o8`. Include the affected version, impact, reproduction steps, and any suggested remediation. Do not publish exploit details in a public issue. If the private form is unavailable, open a public issue containing only a request for a private reporting channel.
