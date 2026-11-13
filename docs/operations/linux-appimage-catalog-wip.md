# Linux AppImage catalog verification WIP

Refs #1672. Catalog acceptance remains incomplete; publication remains disabled.

After rebasing the four existing drafts onto main, local `npm run verify:ci`
passed Security Audit on both the glibc and offline branches. The same unchanged
hermetic CPU-budget assertion then failed on both branches:

```text
src/lib/acp/output-redaction.generated.test.ts:139
retains different literal escape depths locally and bounds benign mixed chains
First full-run attempt: expected 4216.064 to be less than 4000
Second full-run attempt: expected 4259.976 to be less than 4000
```

The isolated retry between those full runs passed all 247 tests, including
`ACP_BENIGN_CHAIN_CPU_MS=2430.90`. The assertion was not relaxed and no unrelated
redaction code was changed. Remaining local shards were interrupted after the
failed first shards; neither full local gate is claimed passed.

Lint, classification, changed-file integration, bundle size, Security Audit and
type checking passed on both branches. Governance passed on the glibc branch.
The fresh hosted glibc build had not reached Ubuntu 22.04 window acceptance when
the required two-failure stop boundary was reached. The hosted source CI on the
rebased glibc head passed. No new glibc scan, offline-window or graphics-failure
acceptance receipt is claimed.

Resume by resolving the repeatable full-suite CPU-budget failure through its own
review, then rerun full local verification and Ubuntu 22.04 package acceptance.
The naming and publication drafts still need verification at their rebased heads.
All four pull requests remain drafts. No version, release, asset or merge changed.
