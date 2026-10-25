# Final repository identity matrix

Written before the identity fix. Each case opens Activity through the real shell
palette and production repository/commit routes, then tests click selection,
independent expansion, Tab traversal, Enter/Space, and stable IDs after refresh.
Git repositories and the registry are disposable; no OS input or visible app.

| Same-SHA case | Expected commit rows | Identity policy |
| --- | --- | --- |
| Forks with different remotes | 2 | Distinct remote repository slugs |
| Two local-only clones | 2 | Distinct canonical registered roots |
| Linked local-only worktrees of one repository | 2 | Each registered worktree root retains its own row |
| Same repository opened twice via a filesystem alias | 1 | Canonical root and registry ID deduplicate the opens |

The topology receipt checks equal real Git HEADs, distinct registry IDs for distinct
roots, and a shared Git common directory only for worktrees/repeated opens.
The matrix checks every painted commit control and a complete Tab cycle, including
the wrap after the last row. Red and green output is retained alongside this file.

Before the fix: remote forks and repeated opens pass; local clones and linked
worktrees fail (2 passed, 2 failed). After the fix: all four cases pass (4 passed,
0 failed). See [red](final-red.txt) and [green](final-green.txt).
