#!/usr/bin/env python3
"""Sync Web UI source (web/) into Go embed dir (go/cmd/pdfcraft/web/).

Single source of truth: web/.
The Go server embeds via `//go:embed all:web` (go/cmd/pdfcraft/server.go),
so the exe only picks up what is copied here. Run before `go build`:

    python scripts/sync_web.py
    cd go && go build -ldflags="-s -w" -o ../PDFCraft.exe ./cmd/pdfcraft

CI guard (no writes, exit 1 on drift):

    python scripts/sync_web.py --check
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web"
DST = ROOT / "go" / "cmd" / "pdfcraft" / "web"

# Whitelist: runtime assets only. Dev files (package.json, tests, e2e,
# playwright.config.js, node_modules, ...) must NEVER be embedded.
FILES = [
    "index.html",
    "app.js",
    "utils.js",
    "app.css",
    "favicon.svg",
    "favicon.ico",
    "vendor/pdf-lib.min.js",
    "vendor/pdf.min.js",
    "vendor/pdf.worker.min.js",
    "vendor/fflate.umd.js",
    "vendor/fflate.LICENSE.txt",
]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def check() -> int:
    problems: list[str] = []
    for rel in FILES:
        s, d = SRC / rel, DST / rel
        if not s.is_file():
            problems.append(f"missing source: {rel}")
            continue
        if not d.is_file():
            problems.append(f"missing embedded: {rel} (run sync)")
            continue
        if sha256(s) != sha256(d):
            problems.append(f"drift: {rel} (run sync + rebuild exe)")
    if problems:
        print("Web UI embed check FAILED:")
        for p in problems:
            print(f"  - {p}")
        print("\nFix: python scripts/sync_web.py")
        return 1
    print(f"Web UI embed check OK ({len(FILES)} files in sync).")
    return 0


def sync() -> int:
    copied, unchanged = 0, 0
    for rel in FILES:
        s, d = SRC / rel, DST / rel
        if not s.is_file():
            print(f"ERROR: missing source {s}", file=sys.stderr)
            return 1
        d.parent.mkdir(parents=True, exist_ok=True)
        if d.is_file() and sha256(s) == sha256(d):
            unchanged += 1
        else:
            shutil.copyfile(s, d)
            copied += 1
            print(f"copied: {rel}")
    print(f"Sync done: {copied} copied, {unchanged} unchanged.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Sync web/ into Go embed dir.")
    ap.add_argument("--check", action="store_true", help="verify only, no writes")
    args = ap.parse_args()
    return check() if args.check else sync()


if __name__ == "__main__":
    raise SystemExit(main())
