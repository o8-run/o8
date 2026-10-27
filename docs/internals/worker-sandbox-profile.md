# Worker sandbox compatibility profile

o8 does not sandbox dispatched workers by default, and that is a stated posture rather than an omission — see [SECURITY.md](../../SECURITY.md), "How dispatched workers run". `O8_WORKER_SANDBOX` opts in, and an enabled sandbox is fail-closed.

This document is the map for anyone who wants to make that sandbox good enough to be a default: what a real worker actually touches, and why a naive profile breaks it. Contributions welcome — see [issue #1657](https://github.com/o8-run/o8/issues/1657).

## Headline findings

A useful worker sandbox needs more than write access to the checked-out files:

- A Git worktree's `.git` file points outside the worktree to the backing repository's mutable index, refs, and lock files. Allowing only the packet directory breaks `git status`, `git add`, and `o8 packet commit`.
- The runtime launches one model CLI, but the worker then runs `node`, package managers, compilers, tests, `o8`, and sometimes another model CLI. Those binaries commonly live in user prefixes such as `~/.npm-global`, `~/.local`, `~/Library/pnpm`, `~/.cargo/bin`, and arbitrary absolute PATH entries.
- Package managers and model CLIs write outside the worktree. npm, pnpm, Cargo, Codex, Claude Code, and Gemini need cache or session-state writes under selected home-directory roots.
- A dispatched worker does not need direct access to the o8 database, port files, or bearer-token files. `run-controller.ts` injects `O8_API_PORT`, `O8_WS_PORT`, `O8_WORKER_TOKEN`, and `O8_WORKER_PACKET_ID`, and `cli/src/config.ts` prefers those values. Keeping `~/.o8` denied protects the operator credential and database without breaking packet CLI verbs.

## Access evidence

| Access | Required mode | Why it is needed | Production evidence and policy |
| --- | --- | --- | --- |
| Packet worktree | Read/write | The worker edits files, creates build outputs, installs local dependencies, and writes commits. | `src/lib/worktree/launch.ts` passes the managed worktree as the runtime cwd. `src/lib/runtimes/shared/owned-session/run-controller.ts` launches the model CLI from `session.repoPath`. The profile admits the canonical cwd. |
| Backing Git repository metadata | Read/write | A linked worktree stores its index and administrative files under `<repo>/.git/worktrees/<name>` and shares refs and object storage under `<repo>/.git`. Git also creates lock files there during add/commit. | `src/lib/worktree/manager.ts` creates real `git worktree` checkouts. `src/lib/runtimes/shared/owned-session/sandbox.ts` resolves `--git-dir` and `--git-common-dir` before launch and admits their canonical paths. |
| Original repository files | Usually none after dispatch; Git metadata as above | The worktree is the worker's code boundary. The original checkout is not a second writable workspace. | `src/lib/worktree/launch.ts` returns the managed worktree cwd. The profile does not add the original checkout merely because it owns the worktree. |
| Owned-session packet directory under `~/.o8/owned-*` | Parent read/write, worker path access not required | o8 writes `session.json`, JSONL, stderr, and the generated `.sb` profile. The worker receives already-open stdout/stderr descriptors, so it does not need to open these paths. | `src/lib/runtimes/shared/owned-session/store.ts`, `session-io.ts`, and `run-controller.ts` create and maintain the session directory outside the sandboxed child. |
| o8 database, token, and port files under `~/.o8` | Denied to worker | The CLI needs a port and packet-bound bearer, but direct file access would also expose the operator token and governance database. | `run-controller.ts` injects `O8_API_PORT`, `O8_WS_PORT`, `O8_WORKER_TOKEN`, and `O8_WORKER_PACKET_ID`; `cli/src/config.ts` consumes them before file fallback. `sandbox.ts` keeps the whole o8 data directory denied. |
| `o8` packet verbs | Execute plus loopback network | `packet info`, `scope`, `diff`, `heartbeat`, `report`, `commit`, and `approve-merge` are the worker's control-plane surface. Commit also executes Git in the worktree. | `cli/src/commands/packet/` calls the local API or Git. `run-controller.ts` exports the local ports and worker bearer. The profile permits process execution, Git metadata, and network access. |
| Node/npm/npx | Read binaries and global prefix; write packet `node_modules` and npm cache | Typecheck/tests execute Node. Local installs write the packet; npm downloads and metadata write `~/.npm`. User-installed shims often live under `~/.npm-global/bin`. | `src/lib/util/node-on-path.ts` builds the worker PATH. The profile reads PATH entries and `~/.npm-global`, writes the worktree and `~/.npm`, but does not permit writes to the global prefix. |
| pnpm/yarn/bun/deno | Read binaries/global prefixes; write selected caches and packet | Repositories choose their own package manager. pnpm commonly uses `~/.pnpm-store` and `~/Library/pnpm`; yarn, bun, and deno use home caches. | The profile reads PATH entries and `~/Library/pnpm`, and writes `~/.pnpm-store`, `~/.yarn`, `~/.bun/install/cache`, `~/.deno`, and the packet. Global installs remain denied. |
| Rust/Cargo | Read `~/.rustup` and `~/.cargo/bin`; write registry/git caches and packet `target` | `cargo test` loads the active toolchain, downloads registry or Git dependencies, and writes build output in the repository. | The profile reads `~/.rustup` and `~/.cargo`, writes only `~/.cargo/registry` and `~/.cargo/git`, and writes the packet. `cargo install` into the global bin directory is intentionally outside the normal packet profile. |
| Codex, Claude Code, and Gemini state | Read/write selected model-CLI homes; immutable credentials/config/hooks | The launched CLI reads subscription authentication and config, then writes sessions, logs, caches, and resumable state. A read-only model home makes otherwise valid turns fail after startup. | Runtime adapters in `src/lib/codex/owned.ts`, `src/lib/claude-code/owned.ts`, and `src/lib/gemini/owned.ts` launch these CLIs. The profile admits `~/.codex`, `~/.claude`, `~/.claude.json`, `~/.gemini`, and `~/.config/gemini` as mutable tool state, then denies writes to known credential, configuration, hook, plugin, policy, and skill paths inside those homes. |
| Temporary files and Unix scratch devices | Read/write | Compilers, package managers, Git, and model CLIs create temporary files and use `/dev/null` or a tty. | `sandbox.ts` admits the canonical `TMPDIR` plus narrow scratch devices. It still denies the o8 webview and existing tmux control sockets. |
| Local o8 API | Loopback network | Worker reporting, scope reads, artifacts, and merge cards use the dynamically selected local API port. | `run-controller.ts` calls `resolvePortInfo()` and exports the ports. `cli/src/api.ts` sends the packet-bound bearer. The profile allows network access. |
| Package registries and source hosts | Outbound network | Dependency installation and repository tasks need npm, crates.io, Git remotes, GitHub, and their CDN/DNS dependencies. | The seatbelt profile permits `network*`; package and Git commands run inside the worker. |
| Authenticated GitHub CLI | Network plus `~/.config/gh` credential read | Some packet briefs ask the worker to read an issue or PR. Public reads work without credentials, but private repositories and higher rate limits need the operator's gh token. | The profile deliberately denies `~/.config/gh`. `sandbox-exec` cannot grant that token only to read-only `gh issue view` while preventing pushes, comments, or releases. Authenticated `gh` is therefore a known dogfood gap until o8 exposes a narrower brokered read capability. |

## What sandbox-exec cannot express honestly

Seatbelt applies one policy to the model CLI and every process it spawns. It cannot distinguish Codex reading `~/.codex/auth.json` for its subscription from a prompt-injected shell command reading the same file. Claude, Gemini, and private package-registry credentials have the same problem. The compatibility profile allows the model homes and `.npmrc` because the corresponding tools need them; the profile must not be described as credential isolation for those tools.

The profile also allows broad process execution and network access. A normal packet can choose any repository tool, run tests that spawn helpers, reach a dynamic local o8 port, and download through changing DNS/CDN endpoints. Restricting those operations to a static executable or host list would make the profile brittle without creating a trustworthy intent boundary. The profile still protects o8's operator credential/database, the gh credential store, webview control sockets, existing tmux servers, and files outside the admitted packet/toolchain roots.

## Linux backend (bubblewrap)

On Linux, `O8_WORKER_SANDBOX` renders the same policy with `bwrap` (`src/lib/runtimes/shared/owned-session/sandbox-linux.ts`). The root filesystem is mounted read-only; HOME, `/tmp`, and the session runtime directory (`/run/user/<uid>`, which holds the D-Bus and keyring sockets) are replaced by empty tmpfs mounts; toolchain read roots are bound back read-only; and the worktree, Git metadata, TMPDIR, and the cache/state roots above are bound read-write. Secret roots are hidden, including the desktop app's WebKitGTK profile (`~/.config`, `~/.cache` and `~/.local/share` `ai.o8.desktop`, which hold its cookies and local storage), and immutable credential files and read-only packet paths are bound read-only last. The worker shares the host network, gets its own PID namespace (so `/proc` does not expose other processes' environments) and its own session (so it cannot inject keystrokes into the launching terminal).

The launch probes bwrap first and refuses with a clear error when bwrap is missing or the kernel denies unprivileged user namespaces (for example Ubuntu's AppArmor userns restriction).

Known differences from the macOS profile:

- Reads outside HOME, `/tmp`, and `/run/user/<uid>` are allowed (the macOS profile only admits listed system roots).
- `/tmp` is private to the worker; a TMPDIR outside `/tmp` is shared read-write.
- HOME is read-only outside the granted roots, so the worker cannot create a missing cache or CLI state directory itself. The launch creates the missing ones (`~/.npm`, `~/.cache`, `~/.codex`, `~/.claude`, …) as empty `0700` directories on the host first, which matches what the macOS profile lets the worker do.
- Executable denials, executable-name denials, basename read denials, and the credential lock policy have no mount-namespace equivalent. Launches that need them (controlled-provider tasks, the single-orchestrator Codex policy) are refused on Linux.
- Denials surface as `EROFS`/`ENOENT` rather than seatbelt reports, so they do not produce `sandbox_denied` lane events yet.

## Dogfood exit criteria

Run a full dispatch cycle with `O8_WORKER_SANDBOX=1` on both Apple Silicon and Intel macOS. Include Node with npm and pnpm, a Cargo packet, Codex and Claude Code workers, a packet that invokes `o8 packet scope/report/commit/approve-merge`, dependency installation, a worktree commit, and a deliberate denied read outside the packet.

Watch for persisted `sandbox_denied` lane events. Each event must name the blocked operation and resource, and the owned-session summary must carry the same operator-facing explanation. Treat repeated denials for global installs or authenticated `gh` as expected policy decisions; treat denials for worktree Git metadata, local package caches, test toolchains, model session state, or the local o8 API as profile bugs to resolve before considering a default flip.
