# Project header review round 2

The two new tests run through the real shell, header, chooser and desktop routes.
Both first failed on `2cf080787`; the final test setup was also rerun against an
isolated copy of that unchanged head. No sidebar state is assigned by the tests.

`sidebar_chooser_never_clears_workspace_for_a_phantom_project` creates two named
projects with registered repositories, places saved fixture chats in both through
the desktop PATCH route, opens the chooser and clicks the legacy choice if it is
offered. It checks the native workspace, header and server's canonical active ID,
then switches between the real projects through the rendered chooser.

Red:

```text
assertion `left == right` failed: a chooser choice must not clear the workspace while the server keeps the named project
  left: None
test ...sidebar_chooser_never_clears_workspace_for_a_phantom_project ... FAILED
```

`sidebar_header_matches_desktop_identity_count_and_add_at_1440` opens a 1440×900
window, chooses a named project through the header and checks the painted bounds
and content: 17px identity at x=8, name at x=37, repository count, 13px chevron,
28px add control with a 5px trailing inset, then 24px repository chips at x=37
with 14px identities. It checks the server-supplied project color and the same
embedded o8 identity asset used by the desktop. The identical PNG is kept beside
the native component so source-only registration builds remain self-contained.

Red:

```text
project identity must match the desktop monogram and server color
test ...sidebar_header_matches_desktop_identity_count_and_add_at_1440 ... FAILED
test result: FAILED. 0 passed; 2 failed; 228 filtered out
```

Green:

```text
sidebar_chooser_never_clears_workspace_for_a_phantom_project ... ok
sidebar_header_matches_desktop_identity_count_and_add_at_1440 ... ok
test result: ok. 2 passed; 0 failed; 228 filtered out
```

The reference is `ProjectsSwitcher`, `ProjectRepositories` and `ProjectIdentity`
under `src/components/desktop/agent-panel`. Names, colors and active identity come
directly from the desktop's `/api/panel/projects` read model; repository data comes
from `/api/panel/repos`. Mutations still use the existing Projects actions.
The chooser hides the legacy default when another project exists. After selection,
the workspace follows the returned canonical active project's membership rather
than the requested legacy ID. The earlier keyboard-ownership fix is retained.

The add control opens the native local-folder picker and uses `Action::Register`.
The test platform's open-path prompt is unimplemented, so picker completion needs
a platform run. Geometry and content are verified here; a compositor/font screenshot
comparison and speed parity still need a renderer-capable run.
