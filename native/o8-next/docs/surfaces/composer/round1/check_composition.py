"""Replay the reviewed composer/keymap composition at explicit source revisions."""
import argparse
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--peer-ref", required=True)
parser.add_argument("--source-ref", default="6811d3f442e6348b46758871e6be0b13aa48b63f",
                    help="composer snapshot to replay; defaults to the reviewed round 2 head")
parser.add_argument("--unported", action="store_true")
parser.add_argument("--test", default="composer")
args = parser.parse_args()
repository = pathlib.Path(__file__).resolve().parents[6]


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=repository)


def source_file(relative):
    return git("show", f"{args.source_ref}:{relative}")


with tempfile.TemporaryDirectory(prefix="o8-composer-composition-") as temporary:
    root = pathlib.Path(temporary).resolve() / "checkout"
    subprocess.run(["git", "worktree", "add", "--detach", str(root), args.peer_ref], cwd=repository, check=True)
    try:
        (root / "node_modules").symlink_to(repository / "node_modules", target_is_directory=True)
        prefix = pathlib.Path("native/o8-next")
        print(f"Composer source={args.source_ref}; focused keymap={args.peer_ref}", flush=True)
        peer_ui = git("show", f"{args.peer_ref}:{prefix}/src/ui.rs").decode()
        peer_shell = git("show", f"{args.peer_ref}:{prefix}/src/shell_view.rs").decode()
        for relative in ["src/composer.rs", "src/conversation.rs", "src/surfaces/session.rs", "src/worker_tests.rs",
                         "src/ui.rs", "src/shell_session.rs", "src/render_region.rs", "src/speed_receipt.rs"]:
            (root / prefix / relative).write_bytes(source_file(prefix / relative))
        # Retain the peer's actual focused session and shell listeners while
        # porting these retained sibling boundaries. Do not replace its actions
        # with the raw-key hooks from this branch.
        ui = root / prefix / "src/ui.rs"
        source = ui.read_text()
        begin = peer_ui.index('            .key_context("Session List")')
        end = peer_ui.index('\n            .child(', begin)
        start_own = source.index('            .capture_key_down(cx.listener(Self::brain_key))')
        stop_own = source.index('\n            .child(header)', start_own)
        ui.write_text(source[:start_own] + peer_ui[begin:end] + source[stop_own:])
        shell = root / prefix / "src/shell.rs"
        source = shell.read_text().replace('pub struct Shell {', 'pub struct Shell {\n    chrome: crate::render_region::Regions<Shell>,', 1)
        source = source.replace('let mut shell = Self {', 'let mut shell = Self {\n            chrome: crate::render_region::Regions::default(),', 1)
        shell.write_text(source)
        # Move the peer's unchanged chrome into a retained sibling, leaving its
        # real Global actions, palette editor and modal ownership in place.
        shell = root / prefix / "src/shell_view.rs"
        source = peer_shell
        begin = source.index('        let before_workspaces =')
        end = source.index('\n        div()\n            .size_full()', begin)
        preparation = source[begin:end]
        start_chrome = source.index('            .child(\n                div()\n                    .flex()\n                    .flex_wrap()', end)
        stop_chrome = source.index('            .child(\n                div()\n                    .debug_selector(|| "shell-content"', start_chrome)
        chrome = source[start_chrome:stop_chrome]
        source = source[:start_chrome] + '            .child(chrome)\n' + source[stop_chrome:]
        source = source[:begin] + '''        let mut style = gpui::StyleRefinement::default();
        style.size.width = Some(gpui::relative(1.).into());
        style.flex_shrink = Some(0.);
        let chrome = self.chrome.measured_view("shell-chrome", style, Self::render_chrome, window.viewport_size().width, cx);''' + source[end:]
        source += '\nimpl Shell {\n    fn render_chrome(&mut self, _: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {\n        let active = self.active();\n' + preparation + '\n        div().w_full().flex().flex_col()\n' + chrome + '.into_any_element()\n    }\n}\n'
        shell.write_text(source)
        main = root / prefix / "src/main.rs"
        main.write_text('mod render_region;\n' + main.read_text())
        # The peer caches each entire surface. A descendant input makes that
        # outer cache dirty; GPUI then refreshes *all* nested caches while it
        # rebuilds the surface. Session owns finer sibling boundaries instead.
        registry = root / prefix / "src/surface_registry.rs"
        source = registry.read_text()
        cached = 'gpui::AnyView::from(view.clone()).cached(gpui::StyleRefinement::default().size_full()).into_any_element()'
        assert cached in source
        source = source.replace(cached, '<$module::View as ShellView>::element(view)', 1)
        source = source.replace('pub(super) trait ShellView: Render {',
            'pub(super) trait ShellView: Render {\n    fn element(view: &Entity<Self>) -> gpui::AnyElement {\n        ' + cached + '\n    }', 1)
        registry.write_text(source)
        session = root / prefix / "src/surfaces/session.rs"
        source = session.read_text().replace('impl ShellView for Surface {',
            'impl ShellView for Surface {\n    fn element(view: &Entity<Self>) -> gpui::AnyElement { view.clone().into_any_element() }', 1)
        session.write_text(source)
        for relative in git("ls-tree", "-r", "--name-only", args.source_ref, "--", str(prefix / "src/composer")).decode().splitlines():
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source_file(relative))
        fixture = pathlib.Path("scripts/next/surfaces/70-composer.surface.ts")
        (root / fixture).write_bytes(source_file(fixture))
        composer = root / prefix / "src/composer.rs"
        source = composer.read_text()
        source = source.replace("pub focus: FocusHandle,", "pub focus: FocusHandle,\n    pub context: &'static str,", 1) if "pub context:" not in source else source
        source = source.replace("pub fn new(cx: &mut Context<Self>) -> Self {", "pub fn new(cx: &mut Context<Self>) -> Self {\n        crate::keymap::install(cx);", 1)
        source = source.replace("focus: cx.focus_handle(),", 'focus: cx.focus_handle(),\n            context: "TextInput",', 1) if 'context: "TextInput"' not in source else source
        source = source.replace(".track_focus(&self.focus)", ".track_focus(&self.focus)\n            .key_context(self.context)", 1) if ".key_context(self.context)" not in source else source
        source = source.replace(".on_key_down(cx.listener(Self::key))", ".on_action(cx.listener(Self::action))", 1)
        if args.unported:
            peer = git("show", f"{args.peer_ref}:{prefix}/src/composer.rs").decode()
            start = peer.index("    pub(crate) fn action(")
            stop = peer.index("\n}\nimpl EntityInputHandler", start)
            start_own = source.index("    fn key(")
            stop_own = source.index("\n}\nimpl EntityInputHandler", start_own)
            source = source[:start_own] + peer[start:stop] + source[stop_own:]
        else:
            source += '\n#[path = "composer/keymap.rs"]\nmod focused_keymap;\n'
            keymap = root / prefix / "src/keymap.rs"
            bindings = keymap.read_text().replace("    Left,\n", "    WordLeft,\n    WordRight,\n    WordBackspace,\n    WordDelete,\n    Left,\n", 1)
            bindings = bindings.replace('(\"shift-z\", EditorOp::Redo),', '(\"shift-z\", EditorOp::Redo),\n            (\"y\", EditorOp::Redo),', 1)
            bindings = bindings.replace('[\"\", \"shift-\", \"ctrl-\", \"ctrl-shift-\", \"cmd-\", \"cmd-shift-\"]', '[\"\", \"shift-\", \"ctrl-\", \"ctrl-shift-\", \"cmd-\", \"cmd-shift-\", \"alt-\", \"alt-shift-\"]', 1)
            marker = '            bind(\n                &format!("{prefix}{key}"),\n                if matches!(operation, EditorOp::Backspace)'
            assert marker in bindings, "the actual focused-keymap binding loop must exist"
            port = '''            let word = if cfg!(target_os = "macos") { prefix.contains("alt") } else { prefix.contains("ctrl") };
            let operation = if word { match operation {
                EditorOp::Left => EditorOp::WordLeft,
                EditorOp::Right => EditorOp::WordRight,
                EditorOp::Backspace => EditorOp::WordBackspace,
                EditorOp::Delete => EditorOp::WordDelete,
                other => other,
            }} else { operation };
'''
            bindings = bindings.replace(marker, port + marker, 1)
            keymap.write_text(bindings)
        composer.write_text(source)
        result = subprocess.run(["cargo", "test", "--locked", "--manifest-path", str(root / prefix / "Cargo.toml"), args.test, "--", "--nocapture", "--test-threads=1"], cwd=root)
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(root)], cwd=repository, check=True)
    raise SystemExit(result.returncode)
