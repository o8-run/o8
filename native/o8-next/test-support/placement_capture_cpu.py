"""Linux-only measurement of the real CLI on owned, inactive virtual displays.

Pass repository, built binary, extracted X11 tools, output directory and a stage
name. Uses production fixture routes. No global input or desktop capture.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


def run():
    assert sys.platform == "linux", "this /proc measurement requires Linux"
    repository, binary, tools, output = [Path(p).resolve(strict=True) for p in sys.argv[1:5]]
    stage = sys.argv[5]
    assert stage in ("before", "after")
    environment = os.environ.copy()
    environment.update({
        "O8_NEXT_API_TOKEN": "fixture-shell-bearer",
        "LD_LIBRARY_PATH": str(tools / "usr/lib/x86_64-linux-gnu"),
        "VK_DRIVER_FILES": str(tools / "usr/share/vulkan/icd.d/lvp_icd.json"),
        "MESA_SHADER_CACHE_DIR": str(output / "shader-cache"),
        "XDG_CACHE_HOME": str(output / "cache"),
    })
    children = []
    logs = []
    try:
        fixture_log = open(output / f"{stage}-fixture.log", "w")
        logs.append(fixture_log)
        fixture = subprocess.Popen([
            "node", "--import", "./scripts/register-server-only-stub.mjs",
            "--import", "tsx", "scripts/next/dev-server.ts", "--composer",
            "--composer-empty", "--shell",
        ], cwd=repository, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=fixture_log, text=True, start_new_session=True)
        children.append(fixture)
        config = None
        for line in fixture.stdout:
            try:
                receipt = json.loads(line)
            except json.JSONDecodeError:
                continue
            if receipt.get("configDir"):
                config = Path(receipt["configDir"])
            if receipt.get("origin"):
                break
        else:
            raise RuntimeError("fixture did not publish its origin")
        threading.Thread(target=lambda: list(fixture.stdout), daemon=True).start()
        assert config is not None, "fixture must publish its owned configuration"
        repo = str((config.parent / "fixture-repo").resolve(strict=True))
        cases = []
        for appearance in ("plain", "glass"):
            for width, height in ((900, 700), (1680, 1050)):
                name = f"{stage}-{appearance}-{width}"
                env = {**environment, "O8_NEXT_APPEARANCE": appearance}
                display = subprocess.Popen([
                    str(tools / "usr/bin/Xvfb"), "-displayfd", "1", "-screen", "0",
                    "1800x1200x24", "-nolisten", "tcp", "-ac",
                ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                    text=True, start_new_session=True)
                children.append(display)
                env["DISPLAY"] = ":" + display.stdout.readline().strip()
                state = output / f"{name}-state.json"
                state.write_text(json.dumps({
                    "version": 1, "bounds": [0, 0, width, height], "selected": repo,
                    "workspaces": {repo: {"tabs": [{"surface": "Session", "session": "thoughts-composer-first"}], "active": 0, "composer": True}},
                }))
                log = open(output / f"{name}-native.log", "w")
                logs.append(log)
                child = subprocess.Popen([
                    str(binary), "--enable-next", "--app-shell", "--server",
                    receipt["origin"], "--shell-state", str(state),
                ], cwd=repository, env=env, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=log, start_new_session=True)
                children.append(child)
                cases.append((name, child, env, appearance, width, height))
        time.sleep(5)
        # A newly mapped inactive window on bare X11 needs an expose event.
        # Use the same entry as scripts/next/linux-headless.mjs, on owned displays.
        for _, child, env, *_ in cases:
            assert child.poll() is None, "owned native CLI must remain running"
            subprocess.run(["xrefresh", "-none"], env=env, check=True, timeout=3)
        time.sleep(2)
        hz = os.sysconf("SC_CLK_TCK")

        def cpu(child):
            assert child.poll() is None, "owned native CLI must remain running"
            fields = Path(f"/proc/{child.pid}/stat").read_text().split(") ", 1)[1].split()
            return (int(fields[11]) + int(fields[12])) / hz

        starts = {name: (time.monotonic(), cpu(child)) for name, child, *_ in cases}
        # Keep four independent windows idle for the same 60-second interval.
        deadline = time.monotonic() + 60.1
        while time.monotonic() < deadline:
            time.sleep(0.2)
            assert all(child.poll() is None for _, child, *_ in cases)
        measurements = []
        for name, child, env, appearance, width, height in cases:
            end, seconds = time.monotonic(), cpu(child)
            start, first = starts[name]
            elapsed = end - start
            assert elapsed >= 60
            png = output / f"{name}.png"
            capture = subprocess.run([
                "import", "-window", "root", "-crop",
                f"{width}x{height}+0+0", str(png),
            ], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            colors = subprocess.run(["identify", "-format", "%k", str(png)],
                capture_output=True, text=True, timeout=10)
            count = int(colors.stdout) if colors.returncode == 0 else 0
            measurements.append({
                "appearance": appearance, "viewport": [width, height],
                "wallSeconds": elapsed, "processCpuSeconds": seconds - first,
                "oneCoreCpuPercent": 100 * (seconds - first) / elapsed,
                "captureBytes": png.stat().st_size if png.exists() else 0,
                "captureColors": count,
                "captureCandidate": capture.returncode == 0 and count > 20,
            })
        (output / f"{stage}.json").write_text(json.dumps({
            "stage": stage,
            "endpoint": "Linux real CLI; four owned inactive virtual-display windows; process CPU excludes fixture and display server",
            "measurements": measurements,
        }, indent=2) + "\n")
        print(json.dumps(measurements), flush=True)
        assert all(item["captureCandidate"] for item in measurements), "native screenshots must contain rendered content; black captures are not evidence"
    finally:
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        for log in logs:
            log.close()


if __name__ == "__main__":
    run()
