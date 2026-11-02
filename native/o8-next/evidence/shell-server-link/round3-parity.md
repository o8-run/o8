# Connection inventory mapping

Base: `c1e85449a1d95bed428bc7f0ccbb9cb9e2eea16f`.

The real inventory CLI failed before the mapping was added:

```text
node scripts/parity/next.mjs --check-surfaces
Unmapped registered surfaces: connection. Update scripts/parity/surfaces.json.
exit: 1
```

After adding the connection row using the existing manifest shape:

```text
node scripts/parity/next.mjs --check-surfaces
exit: 0; 18 registered surfaces mapped
```

The entry names its remaining disconnected-state fixture work. It does not
invent a selectable tab, command, fixture flag or measured connection selector.
The inventory guard is unchanged and still rejects removed registered mappings.

Verification:

- The four parity test files ran: 26 passed, one fixture-startup timeout while
  other completion workloads were active. The harness file then passed all five
  tests alone after those workloads stopped. Every parity case has a passing
  receipt on the final source; the original combined run was not green.
- `npm run typecheck:fast` and `npm run typecheck` passed.
- `npm test -- --experimental.fsModuleCache=false`: 9,457 passed, five skipped.
- The manifest parses as JSON; diff whitespace checks passed.

The full paired-capture job was not rerun. Its separately tracked HTTP 421
failures and disconnected-state capture fixtures remain outside this change.
