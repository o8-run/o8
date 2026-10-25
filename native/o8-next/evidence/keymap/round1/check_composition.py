"""Build the native entry point with another surface and its registration."""
import argparse
import pathlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--surface-ref", required=True)
parser.add_argument("--base", help="Use an earlier shell tree to reproduce the failure")
args = parser.parse_args()
repository = pathlib.Path(__file__).resolve().parents[5]

def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=repository)

with tempfile.TemporaryDirectory(prefix="o8-registry-composition-") as temporary:
    root = pathlib.Path(temporary).resolve()
    destination = root / "native/o8-next"
    prefix = "native/o8-next/"
    if args.base:
        paths = git("ls-tree", "-r", "--name-only", args.base, "native/o8-next").decode().splitlines()
        for path in paths:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git("show", f"{args.base}:{path}"))
    else:
        shutil.copytree(repository / prefix, destination, ignore=shutil.ignore_patterns("target"))
    paths = git("ls-tree", "-r", "--name-only", args.surface_ref, prefix + "src/surfaces/shortcuts.rs", prefix + "src/surfaces/shortcuts").decode().splitlines()
    assert paths, "surface source must exist at the explicit ref"
    for path in paths:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git("show", f"{args.surface_ref}:{path}"))
    # Compile-time theme fixtures use the repository stylesheet on every platform.
    stylesheet = root / "src/app/globals.css"
    stylesheet.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(repository / "src/app/globals.css", stylesheet)
    shell = destination / "src/shell.rs"
    source = shell.read_text()
    source = source.replace("    commands {", '    commands {\n        shortcuts: Shortcuts = "surfaces/shortcuts.rs";', 1)
    shell.write_text(source)
    raise SystemExit(subprocess.run(["cargo", "check", "--locked", "--all-targets", "--manifest-path", str(destination / "Cargo.toml")], cwd=repository).returncode)
