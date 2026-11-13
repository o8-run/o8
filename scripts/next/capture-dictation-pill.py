"""Capture the production GPUI pill under an owned isolated Linux Xvfb display."""
from pathlib import Path
import subprocess
import sys
import time

assert sys.platform == "linux"
binary, directory = Path(sys.argv[1]).resolve(strict=True), Path(sys.argv[2]).resolve()
directory.mkdir(parents=True, exist_ok=True)
for state in ("idle", "requesting-mic", "recording", "transcribing", "polishing", "success", "error"):
    process = subprocess.Popen([str(binary), "--pill-fixture", state],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        assert process.poll() is None, f"fixture exited before {state} capture"
        path = directory / f"{state}.png"
        subprocess.run(["import", "-window", "root", str(path)], check=True, timeout=10)
        assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        print(f"captured {state}", flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
