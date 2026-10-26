#!/usr/bin/env python3
"""Measure the release shell against the disposable production-route host.

Uses proc_pid_rusage(RUSAGE_INFO_V2), the kernel's cumulative interrupt and
package idle wakeups and CPU nanoseconds. No OS input or app discovery.
Run from the repository root with BINARY RECEIPT arguments.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
import subprocess
import sys
import tempfile
import threading
import time


class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            "user", "system", "idle", "interrupt", "pageins", "wired",
            "resident", "footprint", "start", "exit", "child_user",
            "child_system", "child_idle", "child_interrupt", "child_pageins",
            "child_elapsed", "read", "written",
        )
    ]


def main():
    if platform.system() != "Darwin":
        raise RuntimeError("macOS required")
    binary, receipt = map(lambda value: Path(value).resolve(), sys.argv[1:3])
    allow_frozen = sys.argv[3:] == ["--allow-frozen"]
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]

    def usage(pid):
        value = Usage()
        if lib.proc_pid_rusage(pid, 2, ctypes.byref(value)) != 0:
            raise OSError(ctypes.get_errno(), "proc_pid_rusage")
        return {"idle": value.idle, "interrupt": value.interrupt,
                "cpuNs": value.user + value.system}

    with tempfile.TemporaryDirectory(prefix="o8-idle-") as temporary:
        root = Path(temporary)
        with (root / "host.log").open("w+") as host_log, (root / "app.log").open("w+") as app_log:
            host = subprocess.Popen([
                "node", "--import", "./scripts/register-server-only-stub.mjs",
                "--import", "tsx", "scripts/next/dev-server.ts", "--shell",
            ], env={**os.environ, "O8_NEXT_API_TOKEN": "fixture-idle-only",
                    "O8_NEXT_REQUEST_LOG": str(root / "requests.json")},
                stdout=subprocess.PIPE, stderr=host_log, text=True)
            app = None
            try:
                config, origin = None, None
                selector = selectors.DefaultSelector()
                selector.register(host.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 60
                # unbuffered fd reads avoid TextIO read-ahead hiding a receipt.
                pending = b""
                while origin is None and time.monotonic() < deadline:
                    if not selector.select(timeout=1):
                        if host.poll() is not None:
                            raise RuntimeError("Fixture exited before readiness")
                        continue
                    pending += os.read(host.stdout.fileno(), 65536)
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        try:
                            row = json.loads(line)
                        except ValueError:
                            continue
                        config = row.get("configDir", config)
                        origin = row.get("origin", origin)
                selector.close()
                if not config or not origin:
                    raise RuntimeError("Fixture readiness timed out")
                threading.Thread(target=lambda: host.stdout.read(), daemon=True).start()
                saved = json.loads((Path(config) / "chat-history/thoughts-long.json").read_text())
                workspace = saved["repoPath"]
                state = root / "shell.json"
                state.write_text(json.dumps({"version": 1, "bounds": [100, 100, 1200, 816],
                    "selected": workspace, "workspaces": {workspace: {
                        "tabs": [{"surface": "Session", "session": "thoughts-long"}], "active": 0,
                        "composer": False, "selections": {},
                    }}}))
                app = subprocess.Popen([str(binary), "--enable-next", "--app-shell",
                    "--server", origin, "--shell-state", str(state), "--offscreen"],
                    env={**os.environ, "O8_NEXT_API_TOKEN": "fixture-idle-only"},
                    stdout=app_log, stderr=app_log)
                # Let initial route loads, replay and its intentional reconnect settle.
                time.sleep(15)
                if app.poll() is not None:
                    app_log.seek(0)
                    raise RuntimeError("Release shell exited before measurement: " + app_log.read()[-3000:])
                before = usage(app.pid)
                start = time.monotonic()
                time.sleep(60)
                after = usage(app.pid)
                elapsed = time.monotonic() - start
                if app.poll() is not None or host.poll() is not None:
                    raise RuntimeError("Process exited during measurement")
                host.terminate()
                host.wait(timeout=15)
                requests = json.loads((root / "requests.json").read_text())
                frozen = "WS realtime-subscribe" not in requests
                if frozen and not allow_frozen:
                    raise RuntimeError("Shell did not attach its session transport: " + repr(requests))
                if not any(row.startswith("GET /api/panel/") for row in requests):
                    raise RuntimeError("Shell did not reach the production fixture routes")
                result = {"os": platform.mac_ver()[0], "profile": "release", "show": False,
                    "fixture": "production-route host and selected saved session",
                    "frozenBeforeSessionAttach": frozen,
                    "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "method": "proc_pid_rusage RUSAGE_INFO_V2 interrupt and package idle counter deltas",
                    "settleSeconds": 15, "seconds": elapsed, "before": before, "after": after,
                    "wakeupsPerSecond": (after["interrupt"] - before["interrupt"]) / elapsed,
                    "packageIdleWakeupsPerSecond": (after["idle"] - before["idle"]) / elapsed,
                    "cpuPercent": (after["cpuNs"] - before["cpuNs"]) / elapsed / 1e7,
                    "sessionSubscriptions": requests.count("WS realtime-subscribe")}
                receipt.parent.mkdir(parents=True, exist_ok=True)
                receipt.write_text(json.dumps(result, indent=2) + "\n")
                print(json.dumps(result), flush=True)
            finally:
                for child in [app, host]:
                    if child and child.poll() is None:
                        child.terminate()
                        child.wait(timeout=15)


if __name__ == "__main__":
    main()
