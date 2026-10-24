# Dependency audit remediation

The 2026-10-24 audit of the unchanged lockfile at `cdc3e6ea9` reported one
critical, two high, five moderate and two low package findings. These are
dependency findings, not proof of application exploitability.

The resolution keeps each dependency on its existing major version:

| Dependency | Resolved version | Reason |
| --- | --- | --- |
| Next | 16.4.3 | Patched framework release, with the existing local compatibility patches reapplied |
| Zod | 4.6.7 | Patched collection-validation resource bounds |
| Undici, provider utilities | 6.29.1 | Patched response-stream handling |
| Undici, DOM test environment | 7.30.1 | Patched response-stream handling |
| Undici, Pi worker | 8.12.2 | Patched response-stream handling, through a parent-scoped override |
| Undici, native module build tooling | 8.12.3 | Patched response-stream handling |

Pi pins Undici 8.10.2 exactly. Its override stays within major 8 and applies
only to that parent; consumers of majors 6 and 7 retain their own compatible
versions. Revisit the override when the upstream pin includes the fix.

Advisories: [framework image optimization](https://github.com/advisories/GHSA-2464-fhr4-w9xw),
[framework server actions](https://github.com/advisories/GHSA-p3m5-59mp-jv5r),
[framework response caches](https://github.com/advisories/GHSA-673q-mjm6-r5xr),
[collection validation](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[response encodings](https://github.com/advisories/GHSA-xjj6-f33q-929c),
[EventSource parsing](https://github.com/advisories/GHSA-4qv8-2p9j-2685), and
[integrity tokens](https://github.com/advisories/GHSA-f72v-6w45-q472).

Resolution uses the documented [urgent security exception](dependency-release-age.md#urgent-security-fixes)
with `--min-release-age=0` on that command only. The seven-day project policy
and the audit threshold remain unchanged.

## Verification and residual findings

`tests/dependency-fetch-security-real-path.test.ts` resolves the actual installed
Undici entry point from each of the four consumers. A loopback server sends an
excessive encoding chain and truncates its body. Before the updates, all four
child processes crash despite catching the fetch rejection. After the updates,
each must reject safely, complete a normal compressed response and settle its
connections before exiting successfully.

The corrected lockfile passes `npm audit --audit-level=high`: zero critical,
zero high, four moderate and two low package findings. Remaining findings are:

- Vitest and its mocker: moderate development-tool server advisories. The
  production app does not use this test runner. This update does not claim to
  remediate its server modes; a compatible test-tool update remains available.
- Jayson and stream-json: moderate parser advisories in the Solana peer
  dependency chain. Replacing the pinned parser with a new major is outside
  this compatible update. Presence in the graph does not establish that the
  app executes the affected parser paths.
- Mermaid and KaTeX: low trust-handling advisory. The reported resolution
  requires a new Mermaid major, which needs separate renderer compatibility
  verification. Existing rendering tests do not establish advisory clearance.

Counts are package records and include propagated findings. No audit ignore,
threshold change or new production exposure claim is part of this remediation.
