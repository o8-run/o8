"""Disposable raw PTY peer: deterministic ANSI output, no shell or accounts."""
import os
import struct
import sys
import termios
import fcntl
import tty
import time

tty.setraw(sys.stdin.fileno())


def emit(text):
    os.write(sys.stdout.fileno(), text.encode())


# The real-path regression can hold the first write until after an empty replay.
# This models a scheduled-out child without relying on machine-specific sleeps.
startup_gate = os.environ.get("O8_NEXT_TERMINAL_START_GATE")
while startup_gate and not os.path.exists(startup_gate):
    time.sleep(0.01)
emit("\x1b[2J\x1b[HREADY\r\n")
pending = b""
while True:
    data = os.read(sys.stdin.fileno(), 4096)
    if not data:
        break
    pending += data
    while b"\r" in pending or b"\n" in pending:
        end = min(i for i, value in enumerate(pending) if value in (10, 13))
        command, pending = pending[:end].decode(errors="replace"), pending[end + 1:]
        if command == "\x0b":
            emit("CTRL-K\r\n")
        elif command == "size":
            rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
            emit(f"SIZE {cols} {rows}\r\n")
        elif command == "alt":
            emit("\x1b[?1049h\x1b[2J\x1b[HALTERNATE")
        elif command == "primary":
            emit("\x1b[?1049l")
        elif command == "scroll":
            for i in range(10200):
                emit(f"LINE {i:05d}\r\n")
            emit("SCROLL-DONE\r\n")
        elif command in ("flood", "burst"):
            # Exactly 50,000,000 bytes. The repeatable continuous workload is
            # 2.5 MB/s (over 30x the existing terminal benchmark's default).
            # `burst` retains the unpaced saturation probe; the wire is lossy.
            block = ("f" * 78 + "\r\n") * 125
            started = time.monotonic()
            for i in range(5000):
                emit(block)
                if command == "flood":
                    time.sleep(max(0, started + (i + 1) * 0.004 - time.monotonic()))
            tail_gate = os.environ.get("O8_NEXT_TERMINAL_FLOOD_TAIL_GATE")
            if tail_gate:
                emit("FLOOD-DONE")
                while not os.path.exists(tail_gate):
                    time.sleep(0.01)
                emit("\r\n")
            else:
                emit("FLOOD-DONE\r\n")
        else:
            emit("\x1b[31mKEY\x1b[0m 界 e\u0301\r\n")
