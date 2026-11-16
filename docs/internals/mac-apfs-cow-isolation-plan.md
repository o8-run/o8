# macOS APFS CoW Isolation Plan

## Status

Backend spike plus first product surface started.

Implemented in the first pass:

- hidden `O8_APFS_COW_WORKSPACES=1` auto-selection
- APFS capability helper and API route
- `apfs-cow-clone` metadata, listing, cleanup, and direct-merge branch import
- APFS hydration for ignored dependency/cache paths

Implemented in the product-surface pass:

- per-repo `Workspace isolation` setting with `Auto`, `Instant macOS`, and
  `Git worktree`
- repo setup migration so existing repos default to `auto`
- manual workspace creation and runtime launch wiring for the saved preference
- workspace creation copy that explains the macOS APFS path and fallback
- visible isolation label on created and listed workspaces
- capability-aware settings copy so non-APFS machines use the Git worktree
  fallback without presenting Instant macOS as available

## Product Decision

Most o8 users will be on macOS. For those users, workspace creation should use
native APFS copy-on-write behavior when it is available, then fall back to the
current Git worktree path everywhere else.

Product copy:

> No conflicts while working: each agent gets its own private workspace. o8
> still warns before changes collide.

This is stronger and more truthful than "no conflicts." Copy-on-write isolation
prevents agents from stepping on the same working directory. It does not remove
Git merge conflicts when two agents change the same code, so o8 should keep
surfacing overlap and merge-order warnings.

## Current Baseline

Today, `WorktreeManager` creates managed Git worktrees under
`<repo>/.cortex-worktrees/<workspace-id>`, rebases each branch before launch,
bootstraps env files, injects safety hooks, and launches the agent with
`cwd=<worktreePath>`.

That model is solid and remains the fallback. The opportunity is to add a faster
macOS provider that gives each agent an independent clone with its own `.git`,
index, locks, and ignored dependency state.

## Key Design Choice

Do not start with a naive full-directory `cp -cR <repo> <workspace>`.

That would clone internal o8 state like `.cortex-worktrees/` and `.o8/` into each
new workspace. It is cheap in data blocks, but still creates metadata, nests old
workspaces, and makes cleanup harder.

Instead, the first shippable provider should be an APFS-hydrated Git clone:

1. Create an independent local clone for the repo's tracked source and Git state.
2. Create the agent branch inside that clone.
3. Rebase onto the latest base branch before launch, preserving the existing
   stale-base safety gate.
4. APFS-clone only expensive ignored assets that make the workspace ready fast,
   such as `node_modules`, `.next/cache`, `.venv`, `vendor`, `target`, `Pods`,
   and other configured hydration paths.
5. Fall back to the current Git worktree provider if any macOS/APFS requirement
   fails.

This gets the user-visible win without taking on a risky whole-repo clone on day
one.

`git clone --local` gives the clone its own refs, index, hooks, and locks. Git
may hardlink immutable object files under `.git/objects`, which is acceptable for
the MVP because it avoids shared index/lock state while keeping clone creation
cheap. The expensive mutable ignored assets are where APFS CoW hydration matters.

## Provider Model

Pull the existing "Designed to generalize to IsolationProvider" comment forward
now.

Add an internal provider vocabulary while keeping API compatibility with the
current `WorktreeInfo` shape:

```ts
export type WorkspaceIsolationKind = 'git-worktree' | 'apfs-cow-clone';

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  agentType: AgentType;
  status: WorktreeStatus;
  dirtyFiles: string[];
  claudeManaged: boolean;
  isolationKind?: WorkspaceIsolationKind;
  hydrationPaths?: string[];
}
```

Keep `WorktreeInfo` for now so the existing UI, review, merge, and cleanup
surfaces do not all need to move at once. Internally, treat these records as
"workspaces" and let `isolationKind` explain whether the backing implementation
is a Git linked worktree or an independent APFS clone.

## Provider Selection

Add a repo/workspace setting:

```ts
type WorkspaceIsolationPreference = 'auto' | 'git-worktree' | 'apfs-cow-clone';
```

Selection rules:

1. If the user explicitly chooses `git-worktree`, keep current behavior.
2. If the user explicitly chooses `apfs-cow-clone`, try APFS and return a clear
   error if unavailable.
3. If set to `auto`, use APFS only when all checks pass:
   - `process.platform === 'darwin'`
   - source repo is on APFS
   - workspace destination is on the same APFS volume when cloning ignored assets
   - repo has a valid remote/base branch or a fresh local base branch
4. Otherwise, use `git-worktree`.

Rollout default:

1. Dogfood: hidden env flag, `O8_APFS_COW_WORKSPACES=1`.
2. Beta: visible Settings toggle defaulting to `auto` on macOS only.
3. Stable: `auto` becomes default for macOS after benchmark and merge tests pass.

## Implementation Phases

### Phase 1 - Metadata and Provider Seam

Files:

- `src/lib/worktree/types.ts`
- `src/lib/worktree/manager.ts`
- `src/lib/worktree/launch.ts`
- `src/app/api/worktrees/route.ts`
- `src/components/desktop/repo-registry/shared.tsx`

Work:

- Add `WorkspaceIsolationKind`.
- Add `isolationKind` to metadata with default `git-worktree`.
- Rename UI copy from "worktree" toward "workspace" where user-facing text is
  already generic, without breaking code names.
- Keep all current behavior unchanged when `isolationKind === 'git-worktree'`.

Acceptance:

- Existing worktree creation, listing, conflict detection, cleanup, diff, and
  merge behavior is unchanged.
- Old `.cortex-worktrees/.meta.json` files still load.

### Phase 2 - macOS Capability Probe

Files:

- `src/lib/worktree/apfs.ts`

Work:

- Detect macOS.
- Detect APFS with `diskutil info <mount>` or `diskutil info -plist <mount>`.
- Detect same-volume source/destination with `df` device identifiers.
- Treat `cp -c` as best-effort unless the probe confirms APFS. macOS `cp -c`
  falls back to regular copy when clonefile is unsupported.
- Provide a small capability response:

```ts
{
  macos: true,
  apfs: true,
  sameVolume: true,
  canCowClone: true,
  reason?: string
}
```

Acceptance:

- Non-macOS returns `canCowClone: false` with a reason.
- macOS non-APFS volumes fall back cleanly.
- No workspace is created during probing.

### Phase 3 - APFS-Hydrated Clone Provider

Files:

- `src/lib/worktree/apfs-clone-provider.ts`
- `src/lib/worktree/manager.ts`
- `src/lib/worktree/launch.ts`

Create flow:

1. Reserve metadata with `status: 'creating'` and
   `isolationKind: 'apfs-cow-clone'`.
2. Create workspace under the existing ignored repo-local root:
   `<repo>/.cortex-worktrees/<workspace-id>`.
3. Run a local independent clone:

```sh
git clone --local --no-checkout <repo> <workspace>
git -C <workspace> checkout -B <branch> <baseBranch>
```

4. Fetch and rebase onto `origin/<baseBranch>` using the same stale-base rules
   as the Git worktree path.
5. Hydrate ignored assets with APFS CoW:

```sh
cp -cR <repo>/node_modules <workspace>/node_modules
cp -cR <repo>/.next/cache <workspace>/.next/cache
```

6. Copy or symlink env files using the current repo setup setting.
7. Inject safety hooks.
8. Run dependency setup only when hydration is missing or package locks differ.
9. Mark ready and launch the runtime with `cwd=<workspace>`.

Hydration path rules:

- Default candidates: `node_modules`, `.next/cache`, `.turbo`, `.venv`,
  `vendor`, `target`, `Pods`, `DerivedData`.
- Skip paths that do not exist.
- Skip `.git`, `.cortex-worktrees`, `.claude/worktrees`, `.o8`, `.next/server`,
  `dist`, `build`, and generated output unless explicitly configured.
- Before hydrating `node_modules`, compare package lock hashes. If lock files
  differ, skip hydration and run install.

Acceptance:

- A Codex and Claude Code launch on macOS can run from APFS clone workspaces.
- Workspace creation is measurably faster than a cold Git worktree plus install.
- No internal o8 workspace state is copied into the new workspace.

### Phase 4 - Diff, Conflict, Merge, Cleanup Parity

Files:

- `src/app/api/worktrees/diff/route.ts`
- `src/app/api/worktrees/diff-summary/route.ts`
- `src/app/api/worktrees/conflicts/route.ts`
- `src/app/api/worktrees/merge/route.ts`
- `src/lib/worktree/conflicts.ts`
- `src/lib/worktree/manager.ts`

Work:

- Diff and conflict scans should operate against `WorktreeInfo.path`, so they
  should mostly work unchanged.
- Listing must read metadata-first for APFS clone records because `git worktree
  list` will not include independent clones.
- Cleanup for APFS clone records uses patch preservation plus directory removal,
  not `git worktree remove`.
- Merge/PR flow must import the branch from the clone before using existing main
  repo merge logic for direct merges:

```sh
git -C <repo> fetch <workspacePath> <branch>:refs/heads/<branch>
```

After that fetch, existing merge code can operate on the branch from the main
repo. PR creation can either push from the clone workspace directly, which the
current route already does, or import first and push from the main repo. Pick one
path and keep it consistent.

Acceptance:

- Create PR works from an APFS clone workspace.
- Merge works from an APFS clone workspace.
- Discard/cleanup preserves uncommitted work or refuses to destroy it.
- Conflict count still catches two agents editing the same file.

### Phase 5 - Product Surface

Files:

- `src/components/desktop/repo-registry/*`
- `src/components/desktop/settings/ProjectsPanel.tsx`
- `src/components/desktop/settings/projects/*`
- `docs/user/o8-product-brief.md`

Work:

- Add Settings label:
  - `Workspace isolation`
  - `Auto`
  - `Instant macOS workspace`
  - `Git worktree`
- Add hover/help copy:
  - `Every agent gets its own instant workspace. o8 warns you before changes collide.`
- Show an `APFS CoW` badge for macOS clone-backed workspaces.
- Keep fallback wording explicit:
  - `Using Git worktree fallback because this repo is not on APFS.`

Current implementation:

- The repo card setup panel stores `workspaceIsolationPreference`.
- `Auto` is now the saved default for old and newly detected repos.
- Manual workspace creation passes the saved preference to `/api/worktrees`.
- Runtime launches pass the saved preference through `prepareLaunchWorktree`.
- Listed workspaces show `Instant macOS` or `Git worktree` based on metadata.
- The settings panel calls the APFS capability route and hides the explicit
  `Instant macOS` choice when it is unavailable, unless the repo was already
  saved that way and needs correction.

Acceptance:

- Operators can tell which isolation path a workspace used.
- macOS users see the faster path as a product feature, not an implementation
  detail.
- Non-macOS users do not see broken or irrelevant controls.

### Phase 6 - Benchmarks and Release Gate

Benchmark matrix:

1. Current Git worktree with setup.
2. Git worktree with `node_modules` symlink.
3. APFS-hydrated clone.
4. APFS-hydrated clone with three parallel agents.

Measure:

- workspace creation time
- first `npm run typecheck` or equivalent readiness time
- apparent disk usage
- real APFS allocated blocks where available
- conflict detection latency
- cleanup time

Release gates:

- `npm run lint`
- `npm run typecheck`
- create APFS workspace from UI
- launch Codex in APFS workspace
- launch Claude Code in APFS workspace
- create two APFS workspaces that edit the same file and confirm conflict radar
- create PR from APFS workspace
- merge or discard APFS workspace
- confirm Git worktree fallback on non-APFS or forced fallback mode

## Risks

### Risk: APFS clone availability varies

Mitigation: capability probe plus Git worktree fallback. Do not make APFS a hard
requirement.

### Risk: copy-on-write still needs free space later

APFS clones reserve little space up front, but later writes allocate real blocks.
Mitigation: show available disk in the workspace health banner and fail creation
early if the APFS container is critically low.

### Risk: cloned dependency folders go stale

Mitigation: compare package lock hashes before hydrating dependency folders.
When in doubt, skip hydration and run install.

### Risk: independent clone branch is invisible to current merge code

Mitigation: fetch the clone branch back into the main repo before existing merge
or PR logic runs.

### Risk: cleanup deletes useful uncommitted work

Mitigation: preserve patch/commit first. Refuse cleanup when preservation fails.

### Risk: language-specific build outputs are unsafe to hydrate

Mitigation: start with dependency/cache paths only. Let repo setup eventually
define extra hydration paths.

## Follow-Up Optimization

If benchmarks show source checkout itself is the bottleneck, build a filtered
native directory clone helper that uses macOS `clonefile`/`copyfile` per file and
explicitly skips `.cortex-worktrees`, `.o8`, generated outputs, and configured
exclusions.

That is a second step, not the MVP.

## Implementation Order

1. Add metadata/provider seam with no behavior change.
2. Add macOS/APFS capability probe.
3. Add APFS-hydrated clone create path behind `O8_APFS_COW_WORKSPACES=1`.
4. Make listing and cleanup provider-aware.
5. Make merge/PR provider-aware by importing clone branches.
6. Add UI setting and product copy.
7. Benchmark, dogfood, then promote `auto` for macOS.
