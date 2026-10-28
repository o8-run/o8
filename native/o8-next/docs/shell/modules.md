# Shell feature modules

A shell feature adds `src/shell_features/<feature>.rs` and one registration line
inside that module: `register_shell_feature!(Feature);`. It implements only the
`ShellFeature` hooks it needs. `src/shell_feature_build.rs` discovers modules at compile time and
emits module declarations and an inventory into the build output directory.
There is no runtime source scan and no shared inventory line for two features to
conflict over. Files ending in `_test.rs` compile only for native tests.

| Registry | Contribution | Existing behavior |
| --- | --- | --- |
| Tick hooks | `TickHook` | Extension/surface ticks, captured view state, content ticks |
| Render slots | `RenderSlot` | Material, header, status, shortcuts, palette, tabs, content, paint receipt |
| Key contexts | `KeyContext` | Extension ownership, existing surface keys, palette and tab keys |
| Palette commands | `PaletteCommands`, `PaletteCommand` | Existing ordered surface/session commands and built-in actions |
| Preference observers | `PreferenceObserver` | Per-window observers, registered surface initialization and window-state persistence |

Each contribution has an explicit numeric order. Equal priorities use the module
name, then the declaration index within the module. Filesystem enumeration and
merge order cannot change dispatch or layout. The compiled inventories are built
once. Key dispatch stops on `Handled` or `Propagate`, preserving focused controls'
key ownership. Slots return optional elements and retain the existing root's
spacing, type, colors, glass and child order.

Every render slot names its `RenderGroup`: `Chrome` or `Content`. Header, status,
shortcuts, palette and tab slots compose inside `Shell::render_chrome`, behind
the existing measured `shell-chrome` region. The root places that retained group
once at the first chrome slot; content slots keep their order around it. The
material veil precedes chrome and the first-paint receipt follows content, both
outside the cache. The content slot retains the surface decorator fold.

Module state changes notify the shell through the existing key, tick or observer
hooks. The region's owner subscription then invalidates both its scene and
measured height. Composer input that only notifies the editor reuses the chrome
scene. A real-input regression changes a registered slot's local state and
checks its updated scene and chrome render count without forcing a refresh.

```rust
use super::*;
struct Example;
register_shell_feature!(Example);
impl ShellFeature for Example {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook { order: 250, run: |s, refresh, window, cx| {
            // Use existing clients/routes and feature-local state here.
            let _ = (s, refresh, window, cx);
        }}]
    }
}
```

Store a module's window-local entities and subscriptions in
`s.features.get::<ModuleState>()`, where `ModuleState` implements `Default`.
Observer installers run once when the real shell window is created. They can
retain GPUI preference subscriptions in that state, without adding a field to
`Shell` or changing an app entry point. This split introduces no preference
fetcher or additional server route. The existing app parent still receives
readiness only from the window's first paint; the Experimental launch gate is
unchanged.

Existing surface modules retain the same `register_surfaces!` inventory and one
registration line per surface. Their extension hooks are adapted through the
shell registries, including the landed sidebar initialization, ticks and content
decorator. The decorator remains inside the content slot. Shared changes require the existing `shell-work` label; the
boundary policy and its surface-isolation tests remain unchanged.

Run the independent-feature experiment from a committed version of this change:

```sh
node scripts/next/shell-feature-order.mjs
```

It creates three independent detached commits from the same base, each adding
only one module and its registration line. Sidebar render/tick, keymap/command,
and preference observer contributions are merged in all six orders. The script
requires clean merges and identical result trees, then opens the merged
production GPUI shell against the existing route fixture and exercises every
contribution. Temporary worktrees are removed; no branches are pushed or merged. The experiment
uses a dedicated build output directory so native tests can safely relaunch their
own executable.
These are independent extension probes. The landed sidebar is preserved and
verified unchanged; full historical keymap/preferences patch replay remains
unverified. Generated includes resolve against the compiling manifest directory;
source-directory inputs invalidate cached discovery after temporary worktree removal.

The test-first failure and pass are in
[red.txt](../../evidence/shell-modules/red.txt) and
[green.txt](../../evidence/shell-modules/green.txt).

Connection recovery is a discovered feature with feature-local state. The optional
`ShellFeature::extension` adapter contributes load, prepare, focus capture and
content overlay policy to the existing surface lifecycle. Feature extensions use
the same deterministic module order; no connection surface registration is needed.
Palette input and rendering dispatch directly from the palette feature, while
existing surface picker helpers remain available to Diff and Terminal.
