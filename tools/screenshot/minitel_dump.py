#!/usr/bin/env python3
"""minitel_dump.py - fetch a `screen` dump from the 3615 MESHCORE companion (XIAO nRF52840).

    python3 -I minitel_dump.py                     # from the XIAO -> screen-YYYYmmdd-HHMMSS.dump
    python3 -I minitel_dump.py -o home.dump        # explicit output file
    python3 -I minitel_dump.py --port /dev/ttyACM0
    python3 -I minitel_dump.py --from-file x.txt   # normalise an existing capture / log
    some_cmd | python3 -I minitel_dump.py -        # read a dump from stdin
    python3 -I minitel_dump.py --render            # fetch, then run minitel_render.py on it

The XIAO is found by its USB serial number under /dev/serial/by-id/ (never a /dev/ttyUSB*
device: a repeater on ttyUSB0 resets when its tty is opened). Commands are CR-terminated at
115200 baud; the reply is read until a line that is exactly `OK` (or `ERR...`).

Serial access uses pyserial when available, else plain termios (Linux), so no install is
needed. Under `python3 -I` the user site-packages (where pyserial often lives) are hidden; the
termios path then takes over.
"""
import argparse
import glob
import os
import re
import select
import sys
import time

SERIAL_GLOB = "/dev/serial/by-id/*3C0B547619DCA64A*"
BAUD = 115200
KEYWORDS = re.compile(r"\b(SCREEN|ROW|CURSOR)\b")


def find_port(pattern=SERIAL_GLOB):
    hits = sorted(glob.glob(pattern))
    if not hits:
        raise SystemExit(f"no device matches {pattern} (is the XIAO plugged in?)")
    real = os.path.realpath(hits[0])
    if os.path.basename(real).startswith("ttyUSB"):
        raise SystemExit(f"{hits[0]} -> {real}: refusing to open a ttyUSB device")
    return hits[0]


class _TermiosPort:
    """Minimal raw serial port on Linux (no pyserial needed)."""

    def __init__(self, path, baud):
        import termios
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self.fd)
        speed = getattr(termios, f"B{baud}")
        attrs[0] = 0                                        # iflag
        attrs[1] = 0                                        # oflag
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[3] = 0                                        # lflag: raw
        attrs[4] = attrs[5] = speed
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        termios.tcflush(self.fd, termios.TCIOFLUSH)

    def write(self, data):
        os.write(self.fd, data)

    def read(self, timeout):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return b""
        try:
            return os.read(self.fd, 4096)
        except BlockingIOError:
            return b""

    def close(self):
        os.close(self.fd)


class _PySerialPort:
    def __init__(self, path, baud):
        import serial  # noqa: F401
        self.s = serial.Serial(path, baud, timeout=0)
        self.s.reset_input_buffer()

    def write(self, data):
        self.s.write(data)
        self.s.flush()

    def read(self, timeout):
        end = time.time() + timeout
        while time.time() < end:
            n = self.s.in_waiting
            if n:
                return self.s.read(n)
            time.sleep(0.01)
        return b""

    def close(self):
        self.s.close()


def open_port(path, baud):
    try:
        return _PySerialPort(path, baud)
    except ImportError:
        return _TermiosPort(path, baud)


def fetch(port_path, baud=BAUD, timeout=8.0, command="screen"):
    """Send `screen` and return the reply text up to and including the OK line."""
    port = open_port(port_path, baud)
    try:
        # drain whatever the CLI printed before (boot banner, log lines)
        t_end = time.time() + 0.3
        while time.time() < t_end and port.read(0.05):
            pass
        port.write(command.encode() + b"\r")
        buf = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = port.read(0.2)
            if chunk:
                buf += chunk
                deadline = max(deadline, time.time() + 1.0)  # keep going while data flows
                lines = buf.replace(b"\r", b"\n").split(b"\n")
                if any(l.strip() == b"OK" or l.strip().startswith(b"ERR") for l in lines):
                    break
        else:
            raise SystemExit(f"timeout: no OK after {timeout}s ({len(buf)} bytes received)")
        return buf.decode("utf-8", errors="replace")
    finally:
        port.close()


def normalise(text):
    """Keep only the SCREEN/ROW/CURSOR/OK lines (CLI echo and logs dropped), two-space indented."""
    out = []
    for raw in text.replace("\r", "\n").split("\n"):
        m = KEYWORDS.search(raw)
        if m:
            out.append("  " + raw[m.start():].strip())
        elif raw.strip() == "OK":
            out.append("  OK")
    if not any(l.lstrip().startswith("SCREEN") for l in out):
        raise SystemExit("no SCREEN header in the reply - is the firmware recent enough?")
    if not out or out[-1].strip() != "OK":
        out.append("  OK")
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fetch a 3615 MESHCORE `screen` dump over USB serial.")
    ap.add_argument("source", nargs="?", help="'-' to read a dump from stdin (default: the device)")
    ap.add_argument("--from-file", help="read a dump (or a terminal log containing one) from a file")
    ap.add_argument("-o", "--out", help="output .dump file (default: screen-<timestamp>.dump)")
    ap.add_argument("--port", help=f"serial device (default: {SERIAL_GLOB})")
    ap.add_argument("--baud", type=int, default=BAUD)
    ap.add_argument("--timeout", type=float, default=8.0)
    ap.add_argument("--raw", action="store_true", help="save the reply unfiltered")
    ap.add_argument("--render", action="store_true",
                    help="render the dump with minitel_render.py (its options go after '--')")
    argv = list(sys.argv[1:] if argv is None else argv)
    render_args = []
    if "--" in argv:
        k = argv.index("--")
        argv, render_args = argv[:k], argv[k + 1:]
    a = ap.parse_args(argv)

    if a.source == "-":
        text = sys.stdin.read()
    elif a.from_file or (a.source and a.source != "-"):
        with open(a.from_file or a.source, encoding="utf-8", errors="replace") as f:
            text = f.read()
    else:
        text = fetch(a.port or find_port(), a.baud, a.timeout)

    data = text if a.raw else normalise(text)
    out = a.out or time.strftime("screen-%Y%m%d-%H%M%S.dump")
    with open(out, "w", encoding="utf-8") as f:
        f.write(data)
    hdr = next((l.strip() for l in data.splitlines() if "SCREEN" in l), "?")
    nrows = sum(1 for l in data.splitlines() if l.strip().startswith("ROW"))
    print(f"{out}: {hdr} ({nrows} rows)")

    if a.render:
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)
        import minitel_render
        minitel_render.main([out] + render_args)


if __name__ == "__main__":
    main()
