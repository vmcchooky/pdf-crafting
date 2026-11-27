#!/usr/bin/env python3
"""So sánh hiệu năng CLI pdfcraft: bản base (main) vs head (nhánh).

Chỉ dùng stdlib. Đo xen kẽ base/head trong từng lượt trên cùng máy để giảm
nhiễu phần cứng. Job CI là non-blocking (continue-on-error): exit 0 khi đo
xong; exit 1 nếu chính harness lỗi (thiếu binary, lệnh fail, timeout).
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if callable(_reconfigure):
        _reconfigure(encoding="utf-8")


def _build_pdf(objs: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


def write_text_pdf(path: Path, pages: int = 50) -> None:
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(pages))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode(),
    ]
    for i in range(pages):
        content = f"BT /F1 24 Tf 72 720 Td (Trang {i + 1}) Tj ET".encode("latin-1")
        objs.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                "/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 "
                f"/BaseFont /Helvetica >> >> >> /Contents {4 + i * 2} 0 R >>"
            ).encode()
        )
        objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    path.write_bytes(_build_pdf(objs))


def write_scan_pdf(path: Path, w: int = 620, h: int = 877) -> None:
    rng = random.Random(42)
    raw = rng.randbytes(w * h * 3)
    image = zlib.compress(raw, 6)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
            + f"{w} {h}".encode()
            + b"] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
        ),
    ]
    content = f"q {w} 0 0 {h} 0 0 cm /Im0 Do Q".encode()
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    objs.append(
        (
            f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
            "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
            f"/Length {len(image)} >>\nstream\n"
        ).encode()
        + image
        + b"\nendstream"
    )
    path.write_bytes(_build_pdf(objs))


def run_once(cmd: list[str]) -> float:
    start = time.perf_counter()
    try:
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=180)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"command timed out after 180s: {' '.join(cmd)}") from exc
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"{proc.stderr.decode(errors='replace')}"
        )
    return elapsed


METRICS = ("info50", "extract20", "split50", "compress50", "info_scan", "compress_scan")


def measure_run(exe: Path, work: Path, pdf50: Path, scan: Path) -> dict[str, float]:
    out = Path(tempfile.mkdtemp(dir=work, prefix="out_"))
    return {
        "info50": run_once([str(exe), "info", str(pdf50)]),
        "info_scan": run_once([str(exe), "info", str(scan)]),
        "extract20": run_once(
            [str(exe), "extract", str(pdf50), "-pages", "1-20", "-o", str(out / "extract.pdf")]
        ),
        "split50": run_once([str(exe), "split", str(pdf50), "-d", str(out / "split")]),
        "compress50": run_once(
            [str(exe), "compress", str(pdf50), "-o", str(out / "compress.pdf")]
        ),
        "compress_scan": run_once(
            [str(exe), "compress", str(scan), "-o", str(out / "compress_scan.pdf")]
        ),
    }


def measure_pair(
    base_exe: Path, head_exe: Path, work: Path, runs: int
) -> tuple[dict[str, list[float]], dict[str, list[float]]]:
    pdf50 = work / "bench_50p.pdf"
    scan = work / "bench_scan.pdf"
    base: dict[str, list[float]] = {k: [] for k in METRICS}
    head: dict[str, list[float]] = {k: [] for k in METRICS}
    for run in range(runs):
        order = [(base_exe, base), (head_exe, head)]
        if run % 2 == 1:
            order.reverse()
        for exe, timings in order:
            measured = measure_run(exe, work, pdf50, scan)
            for key in METRICS:
                timings[key].append(measured[key])
    return base, head


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--head", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--threshold", type=float, default=20.0)
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    try:
        with tempfile.TemporaryDirectory(prefix="pdfcraft_bench_") as tmp:
            work = Path(tmp)
            write_text_pdf(work / "bench_50p.pdf")
            write_scan_pdf(work / "bench_scan.pdf")
            base, head = measure_pair(args.base, args.head, work, args.runs)
    except RuntimeError as exc:
        print(f"::error title=Benchmark harness::{exc}")
        return 1

    report = {}
    regressions = 0
    print(f"{'metric':<14} {'base(min)':>10} {'head(min)':>10} {'delta':>9}")
    for name in base:
        b = min(base[name])
        h = min(head[name])
        delta = (h / b - 1.0) * 100.0 if b > 0 else 0.0
        report[name] = {
            "base_min_s": b,
            "head_min_s": h,
            "base_median_s": statistics.median(base[name]),
            "head_median_s": statistics.median(head[name]),
            "delta_pct": delta,
        }
        flag = ""
        if delta > args.threshold:
            regressions += 1
            flag = "  <== WARN"
            print(f"::warning title=Benchmark regression::{name} chậm hơn {delta:.1f}% so với base")
        print(f"{name:<14} {b:>10.4f} {h:>10.4f} {delta:>8.1f}%{flag}")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nNgưỡng: {args.threshold:.0f}% — {regressions} chỉ số vượt ngưỡng (không chặn CI).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
