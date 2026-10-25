"""Compile main plus only this surface's files and its one inventory line."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--base", default="origin/main")
args = parser.parse_args()
repo = Path(__file__).resolve().parents[5]
surface = repo / "native/o8-next/src/surfaces"
with tempfile.TemporaryDirectory(prefix="o8-shortcuts-registration-") as directory:
    root = Path(directory).resolve()
    archive = subprocess.check_output(["git", "archive", args.base, "native/o8-next"], cwd=repo)
    subprocess.run(["tar", "-xf", "-", "-C", str(root)], input=archive, check=True)
    native = root / "native/o8-next"
    shutil.copy2(surface / "shortcuts.rs", native / "src/surfaces/shortcuts.rs")
    shutil.copytree(surface / "shortcuts", native / "src/surfaces/shortcuts", dirs_exist_ok=True)
    shell = native / "src/shell.rs"
    text = shell.read_text()
    line = '        shortcuts: Shortcuts = "surfaces/shortcuts.rs";\n'
    assert text.count(line) <= 1
    if line not in text:
        assert "    commands {\n" in text
        shell.write_text(text.replace("    commands {\n", "    commands {\n" + line, 1))
    for name in ["composer.rs", "terminal.rs", "surface_registry.rs"]:
        expected = subprocess.check_output(["git", "show", f"{args.base}:native/o8-next/src/{name}"], cwd=repo)
        assert (native / "src" / name).read_bytes() == expected
    result = subprocess.run(["cargo", "check", "--locked", "--manifest-path", str(native / "Cargo.toml"), "--bin", "o8-next"], env=os.environ)
    if result.returncode == 0:
        print("Surface files and one inventory line compile; shared registry and editors match the base.")
    raise SystemExit(result.returncode)
