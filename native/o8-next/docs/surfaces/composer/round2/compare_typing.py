"""Run identical fixed-fixture typing benchmarks before and after this change.

The owned comparison checkout receives only fixture/test code. It never receives
the retained regions or editor implementation. GPUI test support paints the first
CPU scene when the input update flushes; the benchmark requests no extra draw.
"""
import argparse
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--before", required=True)
parser.add_argument("--profile", choices=["debug", "release"], action="append")
args = parser.parse_args()
repository = pathlib.Path(__file__).resolve().parents[6]
prefix = pathlib.Path("native/o8-next")
environment = os.environ.copy()
environment.setdefault("CARGO_TARGET_DIR", str(repository / prefix / "target"))


def run(root, profile):
    # Cargo's shared target can retain a fingerprint for one checkout after
    # another checkout overwrites its identically named executable. Force this
    # package to rebuild on each side; keep the expensive dependency cache.
    clean = ["cargo", "clean", "--manifest-path", str(root / prefix / "Cargo.toml"), "--package", "o8-next"]
    if profile == "release":
        clean.append("--release")
    subprocess.run(clean, cwd=root, env=environment, check=True)
    command = ["cargo", "test", "--locked", "--manifest-path", str(root / prefix / "Cargo.toml")]
    if profile == "release":
        command.append("--release")
    command += ["--bin", "o8-next", "typing_benchmark", "--", "--nocapture", "--test-threads=1"]
    subprocess.run(command, cwd=root, env=environment, check=True)


with tempfile.TemporaryDirectory(prefix="o8-composer-typing-") as temporary:
    root = pathlib.Path(temporary).resolve() / "checkout"
    subprocess.run(["git", "worktree", "add", "--detach", str(root), args.before], cwd=repository, check=True)
    try:
        (root / "node_modules").symlink_to(repository / "node_modules", target_is_directory=True)
        fixture = pathlib.Path("scripts/next/surfaces/70-composer.surface.ts")
        shutil.copyfile(repository / fixture, root / fixture)
        tests = repository / prefix / "src/composer/card_tests.rs"
        source = tests.read_text()
        # Use the same host, pagination helper and benchmark body. Other tests
        # depend on the new region counters, which are absent on the old head.
        common = source[:source.index("#[gpui::test]")]
        loaded = source[source.index("fn loaded<'a>("):source.index("#[gpui::test]\nfn native_composer_loaded_typing_invalidates")]
        benchmark = source[source.index("#[gpui::test]\nfn native_composer_loaded_typing_benchmark"):source.index("#[gpui::test]\nfn native_composer_loaded_wrapping")]
        (root / prefix / "src/composer/card_tests.rs").write_text(common + loaded + benchmark)
        session = root / prefix / "src/surfaces/session.rs"
        source = session.read_text()
        source += '\n#[cfg(test)]\n#[path = "../composer/loaded_shell_tests.rs"]\nmod loaded_shell_tests;\n'
        session.write_text(source)
        probe = (repository / prefix / "src/shell_session.rs").read_text()
        probe = probe[probe.index("    #[cfg(test)]"):probe.index("    pub(crate) fn shell_linked_issue")]
        probe = probe.replace("self.regions.renders(cx)", "Value::Null")
        session = root / prefix / "src/shell_session.rs"
        session.write_text(session.read_text().replace("impl Surface {", "impl Surface {\n" + probe, 1))
        tests = pathlib.Path("src/composer/loaded_shell_tests.rs")
        source = (repository / prefix / tests).read_text()
        # Baseline has no shell scene counter; retain the real shell/session
        # notification observers and editor paint acknowledgement in both runs.
        source = source.replace('    let chrome = shell.read_with(&cx, |s, cx| s.chrome.renders(cx));\n', '')
        source, count = re.subn(r'        assert_eq!\(\n            shell.read_with\(&cx, \|s, cx\| s.chrome.renders\(cx\)\),\n            chrome,\n            "typing must reuse the shell chrome scene"\n        \);\n', '', source)
        assert count == 1, "baseline removes only the unavailable shell counter assertion"
        # The old shell predates the workspace thread rail. Its paint observer
        # belongs only to the current checkout, alongside the new rail itself.
        start = source.index('    let rail_painted =')
        end = source.index('    let mut samples =', start)
        source = source[:start] + source[end:]
        source, count = re.subn(r'        assert_eq!\(\n            rail_painted.get\(\),\n            usize::MAX,\n            "typing must reuse the workspace thread sidebar scene"\n        \);\n', '', source)
        assert count == 1, "baseline removes only the unavailable workspace rail observer"
        (root / prefix / tests).write_text(source)
        for profile in args.profile or ["debug", "release"]:
            print(f"BEFORE ref={args.before} profile={profile}", flush=True)
            run(root, profile)
            print(f"AFTER profile={profile}", flush=True)
            run(repository, profile)
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(root)], cwd=repository, check=True)
