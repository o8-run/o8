"""Owned raw PTY peer reports only the synthetic bytes sent by this test."""
import os
import sys
import tty

tty.setraw(sys.stdin.fileno())
os.write(sys.stdout.fileno(), b"READY\r\n")
while True:
    data = os.read(sys.stdin.fileno(), 4096)
    if not data:
        break
    os.write(sys.stdout.fileno(), ("BYTES " + data.hex() + "\r\n").encode())
