#!/usr/bin/env node
// Apply independently authored shell modules in all orders, then drive the merged app.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const repository = run('git', ['rev-parse', '--show-toplevel'], process.cwd()).trim();
const git = (args, cwd = repository) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], cwd);
const ref = process.argv[2] || 'HEAD';
const base = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
const temporary = mkdtempSync(join(tmpdir(), 'o8-shell-order-'));
const worktree = join(temporary, 'tree');
const featurePath = 'native/o8-next/src/shell_features/';
const modules = {
  sidebar: `use super::*;
struct Sidebar;
register_shell_feature!(Sidebar);
fn active(s: &Shell) -> bool { s.file.ends_with("order-experiment.json") }
impl ShellFeature for Sidebar {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot { group: RenderGroup::Chrome, order: 450, render: |s, _, _, _| active(s).then(|| div().debug_selector(|| "order-sidebar".into()).size(px(1.)).into_any_element()) }]
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook { order: 300, run: |s, _, _, _| if active(s) { s.notice = "order tick".into(); } }]
    }
}
`,
  keymap: `use super::*;
struct Keymap;
register_shell_feature!(Keymap);
fn active(s: &Shell) -> bool { s.file.ends_with("order-experiment.json") }
static COMMAND: PaletteCommand = PaletteCommand {
    id: "order-command", label: "Independent action",
    run: |s, window, cx| { s.palette = false; s.notice = "order command".into(); s.restore_focus(window, cx); cx.notify(); },
};
impl ShellFeature for Keymap {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext { order: -20, dispatch: |s, event, _, _| {
            if active(s) && event.keystroke.modifiers.alt && event.keystroke.key == "u" {
                s.notice = "order key".into(); KeyResult::Handled
            } else { KeyResult::Unhandled }
        }}]
    }
    fn commands(&self) -> &'static [PaletteCommands] {
        &[PaletteCommands { order: 50, collect: |s| if active(s) { vec![Command::Feature(&COMMAND)] } else { vec![] } }]
    }
}
`,
  preferences: `use super::*;
struct Mirror;
register_shell_feature!(Mirror);
struct Preferences;
impl gpui::Global for Preferences {}
impl ShellFeature for Mirror {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot { group: RenderGroup::Chrome, order: 460, render: |s, _, _, _| s.file.ends_with("order-experiment.json").then(|| div().debug_selector(|| "order-preferences".into()).size(px(1.)).into_any_element()) }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext { order: -10, dispatch: |s, event, _, _| {
            if s.file.ends_with("order-experiment.json") && event.keystroke.modifiers.alt && event.keystroke.key == "u" {
                s.notice = "later key context".into(); KeyResult::Handled
            } else { KeyResult::Unhandled }
        }}]
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook { order: 290, run: |s, _, _, _| if s.file.ends_with("order-experiment.json") { s.notice = "earlier tick".into(); } }]
    }
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver { order: 50, install: |s, _, cx| {
            if s.file.ends_with("order-experiment.json") {
                s.subscriptions.push(cx.observe_global::<Preferences>(|s, cx| { s.notice = "order preferences".into(); cx.notify(); }));
            }
        }}]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::test_support::*;
    #[gpui::test]
    fn independent_shell_features_survive_order(cx: &mut TestAppContext) {
        let fixture = Fixture::new();
        let (shell, mut visual) = open(fixture.client.clone(), fixture.root.join("order-experiment.json"), crate::shell_state::State::default(), cx);
        ready(&shell, &mut visual);
        let sidebar = visual.debug_bounds("order-sidebar").unwrap();
        let preferences = visual.debug_bounds("order-preferences").unwrap();
        assert!(sidebar.origin.y < preferences.origin.y, "slot priority overrides module name");
        visual.simulate_keystrokes("alt-u");
        assert_eq!(shell.read_with(&visual, |s, _| s.notice.clone()), "order key");
        visual.simulate_keystrokes("ctrl-shift-p");
        visual.simulate_keystrokes("i n d e p e n d e n t enter");
        assert_eq!(shell.read_with(&visual, |s, _| s.notice.clone()), "order command");
        visual.update(|window, cx| shell.update(cx, |s, cx| s.tick(true, window, cx)));
        assert_eq!(shell.read_with(&visual, |s, _| s.notice.clone()), "order tick");
        visual.update(|_, cx| cx.set_global(Preferences));
        visual.run_until_parked();
        draw(&mut visual);
        assert_eq!(shell.read_with(&visual, |s, _| s.notice.clone()), "order preferences");
    }
}
`,
};
function permutations(values) {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];
}
let attached = false;
try {
  git(['worktree', 'add', '--quiet', '--detach', worktree, base]);
  attached = true;
  const commits = {};
  for (const [name, source] of Object.entries(modules)) {
    git(['checkout', '--quiet', '--detach', base], worktree);
    const path = `${featurePath}order_${name}.rs`;
    writeFileSync(join(worktree, path), source);
    git(['add', '--', path], worktree);
    // Synthetic commits stay detached and local. No additional branches or PRs.
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', `fixture: add independent ${name} module`], worktree);
    commits[name] = git(['rev-parse', 'HEAD'], worktree).trim();
    const paths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], worktree).trim().split('\n');
    if (paths.length !== 1 || paths[0] !== path) throw new Error('feature touched a shared file');
    if ((source.match(/^register_shell_feature!\(.+\);$/gm) || []).length !== 1) throw new Error('feature needs one registration line');
  }
  const trees = new Set();
  for (const order of permutations(Object.keys(modules))) {
    git(['checkout', '--quiet', '--detach', base], worktree);
    for (const name of order) {
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--quiet', '--no-edit', '--no-ff', commits[name]], worktree);
    }
    const tree = git(['rev-parse', 'HEAD^{tree}'], worktree).trim();
    trees.add(tree);
    console.log(`${order.join(' -> ')}: clean merge; tree ${tree}`);
  }
  if (trees.size !== 1) throw new Error('merge order changed the resulting tree');
  console.log('6/6 orders clean; identical trees; each feature adds one module with one registration line.');
  const native = join(worktree, 'native/o8-next/Cargo.toml');
  const env = {
    ...process.env,
    // Keep self-launching native tests and the experiment in separate build outputs.
    CARGO_TARGET_DIR: process.env.O8_NEXT_FEATURE_ORDER_TARGET || join(repository, 'native/o8-next/target/shell-feature-order'),
    NODE_PATH: join(repository, 'node_modules'),
  };
  // Fixture processes resolve their imports from the worktree, including tsx.
  run('ln', ['-s', join(repository, 'node_modules'), join(worktree, 'node_modules')], worktree);
  console.log(run('cargo', ['test', '--locked', '--manifest-path', native, 'independent_shell_features_survive_order', '--', '--nocapture', '--test-threads=1'], worktree, env));
  console.log('Merged production GPUI shell verified render, keys, palette commands, tick and preference observation against the existing route fixture.');
} finally {
  if (attached) git(['worktree', 'remove', '--force', worktree]);
  rmSync(temporary, { recursive: true, force: true });
}
