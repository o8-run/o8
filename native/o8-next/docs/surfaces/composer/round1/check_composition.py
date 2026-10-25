"""Exercise the real composer with the explicit focused-keymap revision."""
import argparse
import pathlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--peer-ref", required=True)
parser.add_argument("--unported", action="store_true")
parser.add_argument("--test", default="composer")
args = parser.parse_args()
repository = pathlib.Path(__file__).resolve().parents[6]


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=repository)


with tempfile.TemporaryDirectory(prefix="o8-composer-composition-") as temporary:
    root = pathlib.Path(temporary).resolve() / "checkout"
    subprocess.run(["git", "worktree", "add", "--detach", str(root), args.peer_ref], cwd=repository, check=True)
    try:
        (root / "node_modules").symlink_to(repository / "node_modules", target_is_directory=True)
        prefix = pathlib.Path("native/o8-next")
        for relative in ["src/composer.rs", "src/conversation.rs", "src/surfaces/session.rs", "src/worker_tests.rs"]:
            shutil.copyfile(repository / prefix / relative, root / prefix / relative)
        shutil.copytree(repository / prefix / "src/composer", root / prefix / "src/composer", dirs_exist_ok=True)
        fixture = pathlib.Path("scripts/next/surfaces/70-composer.surface.ts")
        shutil.copyfile(repository / fixture, root / fixture)
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
