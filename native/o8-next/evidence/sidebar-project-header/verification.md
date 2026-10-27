# Sidebar project header

This item is stacked on #4642 at `f95c1102a`. The rail remains one registered
surface; its header, requests and tests live under `src/surfaces/sidebar/`.

Reference: `ProjectsSwitcher.tsx` and `ProjectRepositories.tsx`. The native header
uses 13.5px / 300 project text, a 32px switcher, 24px / 10.5px / 300 chips,
7px chip corners, 3px gaps and the 37px repository inset. The selected repository
stays first; text measurement limits the visible chips to three and reserves
space for the overflow. Colors come from the existing native theme.

The header reuses `projects_model::Action` and its production project/registry
routes. There is no second project store or active-repository endpoint. Like the
desktop, opening a repository activates its project and selects its workspace.

`sidebar_project_header_switches_repos_and_projects` opens the real shell with
four registered fixture repositories, drives the overflow and project choices,
and reads the persisted ledger back through `/api/panel/projects`.

Red, before the header implementation:

```text
project name and switcher must be painted above Recents
test result: FAILED. 0 passed; 1 failed; 168 filtered out
```

Green:

```text
test result: ok. 1 passed; 0 failed; 168 filtered out
```

Screenshot acceptance remains open: this Linux GPUI TestAppContext uses a test
text system and its platform window's draw method is a no-op. It establishes
layout, input and route behavior, but cannot produce the requested native pixel
capture. Capture the native header beside the production React layout on a
renderer-capable host before visual parity approval. Full glass, real font
shaping and display latency are not established by these tests.
