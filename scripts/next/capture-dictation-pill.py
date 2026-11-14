"""Capture the production GPUI pill under an owned isolated Linux Xvfb display."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import time

assert sys.platform == "linux"
binary, directory = Path(sys.argv[1]).resolve(strict=True), Path(sys.argv[2]).resolve()
directory.mkdir(parents=True, exist_ok=True)
digests = set()
for state in ("idle", "requesting-mic", "recording", "transcribing", "polishing", "success", "error"):
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen([str(binary), "--pill-fixture", state],
                                   stdout=log, stderr=log)
        try:
            path = directory / f"{state}.png"
            painted = False
            for _ in range(75):
                time.sleep(0.2)
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(f"fixture exited before {state} capture: " + log.read().decode(errors="replace")[-500:])
                subprocess.run(["xrefresh", "-none"], check=True, timeout=5)
                subprocess.run(["import", "-window", "root", str(path)], check=True, timeout=10)
                colors = int(subprocess.check_output(["identify", "-format", "%k", str(path)], timeout=5))
                if state == "idle" or colors > 16:
                    painted = True
                    break
            assert painted, f"no painted native content for {state}"
            assert path.read_bytes().startswith(bytes([137, 80, 78, 71, 13, 10, 26, 10]))
            digests.add(hashlib.sha256(path.read_bytes()).hexdigest())
            print(f"captured {state}", flush=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
assert len(digests) == 7, "every state must have a distinct raster"
