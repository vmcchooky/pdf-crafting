"""
Batch conversion of Office documents (Word/Excel/...) to PDF.

Engine: LibreOffice headless (`soffice --convert-to pdf`) when available.
An explicit engine binary can be passed via `engine=` (useful for tests).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path

logger = logging.getLogger(__name__)

#: Office extensions handled by the converter (via LibreOffice).
SUPPORTED_EXTENSIONS = frozenset(
    {
        # Word
        ".docx",
        ".doc",
        ".odt",
        ".rtf",
        # Excel
        ".xlsx",
        ".xls",
        ".ods",
        ".csv",
        # Presentation (bonus, same engine)
        ".pptx",
        ".ppt",
        ".odp",
    }
)

#: Well-known LibreOffice locations when it is not on PATH (Windows-first).
_KNOWN_SOFFICE_PATHS = (
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)


def find_office_engine() -> str | None:
    """Return a usable `soffice`/`libreoffice` binary path, or None if missing."""
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in _KNOWN_SOFFICE_PATHS:
        if Path(candidate).is_file():
            return candidate
    return None


def run_converter(
    engine: str, args: Sequence[str], timeout: int
) -> subprocess.CompletedProcess[str]:
    """Run the converter binary (separated for easy mocking in tests)."""
    return subprocess.run(
        [engine, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _unique_output_path(
    out_dir: Path, stem: str, reserved: set[Path] | None = None
) -> Path:
    """foo.pdf, foo_2.pdf, foo_3.pdf, ... (tránh đè file có sẵn và file cùng batch)."""
    taken = reserved if reserved is not None else set()
    candidate = out_dir / f"{stem}.pdf"
    counter = 2
    while candidate.exists() or candidate in taken:
        candidate = out_dir / f"{stem}_{counter}.pdf"
        counter += 1
    taken.add(candidate)
    return candidate


def convert_office_to_pdf(
    input_paths: Sequence[str | Path],
    output_dir: str | Path | None = None,
    engine: str | None = None,
    timeout: int = 180,
    runner: Callable[[str, Sequence[str], int], subprocess.CompletedProcess[str]]
    | None = None,
) -> list[Path]:
    """
    Convert a batch of Office files to PDF, preserving input order.
    Files sharing one output directory and stem get auto-suffixed (_2, _3, ...).
    Returns the list of created PDF paths.
    Raises FileNotFoundError (missing input), ValueError (bad extension / no file),
    RuntimeError (no engine / converter failure).
    """
    paths = [Path(p) for p in input_paths]
    if not paths:
        raise ValueError("Cần ít nhất 1 file Office đầu vào để chuyển đổi")

    valid: list[Path] = []
    for p in paths:
        resolved = p.resolve() if p.exists() else p
        if not p.is_file():
            raise FileNotFoundError(f"Không tìm thấy file đầu vào: {p}")
        if resolved.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(
                f"Định dạng chưa hỗ trợ: {p.name} "
                f"(hỗ trợ: {', '.join(sorted(SUPPORTED_EXTENSIONS))})"
            )
        valid.append(resolved)

    resolved_engine = engine or find_office_engine()
    if not resolved_engine:
        raise RuntimeError(
            "Không tìm thấy LibreOffice để chuyển đổi. "
            "Hãy cài LibreOffice (https://libreoffice.org) rồi thử lại, "
            "hoặc truyền --engine <đường_dẫn_soffice>."
        )

    run = runner or run_converter

    # Gom theo thư mục đích để gọi 1 lần soffice cho mỗi thư mục (nhanh hơn nhiều
    # so với khởi động LibreOffice từng file).
    by_dir: dict[Path, list[Path]] = {}
    for src in valid:
        target_dir = Path(output_dir).resolve() if output_dir else src.parent
        target_dir.mkdir(parents=True, exist_ok=True)
        by_dir.setdefault(target_dir, []).append(src)

    produced_by_src: dict[Path, Path] = {}
    for target_dir, sources in by_dir.items():
        # Đặt chỗ output trước để tránh đè lẫn nhau trong batch
        reserved: set[Path] = set()
        wanted_by_src = {
            src: _unique_output_path(target_dir, src.stem, reserved) for src in sources
        }

        # Chia lượt con nếu trùng stem (converter luôn ghi <stem>.pdf nên mỗi
        # lượt chỉ chứa các stem duy nhất). Convert trong thư mục tạm rồi dời
        # về tên đã đặt để không bao giờ đè file đích.
        remaining = list(sources)
        while remaining:
            batch: list[Path] = []
            seen_stems: set[str] = set()
            rest: list[Path] = []
            for src in remaining:
                if src.stem.lower() in seen_stems:
                    rest.append(src)
                else:
                    seen_stems.add(src.stem.lower())
                    batch.append(src)
            remaining = rest

            with tempfile.TemporaryDirectory(prefix="pdfcraft_convert_") as tmp:
                args = ["--headless", "--convert-to", "pdf", "--outdir", tmp]
                args.extend(str(s) for s in batch)
                logger.debug(
                    "Chạy converter: %s (%d file)", resolved_engine, len(batch)
                )
                try:
                    proc = run(resolved_engine, args, timeout)
                except subprocess.TimeoutExpired as e:
                    raise RuntimeError(
                        f"Chuyển đổi quá thời gian ({timeout}s), đã hủy"
                    ) from e
                if proc.returncode != 0:
                    detail = (proc.stderr or proc.stdout or "").strip()
                    raise RuntimeError(
                        f"Converter báo lỗi (mã {proc.returncode}): {detail}"
                    )

                for src in batch:
                    produced = Path(tmp) / f"{src.stem}.pdf"
                    if not produced.is_file():
                        raise RuntimeError(
                            f"Converter không tạo ra file: {src.stem}.pdf"
                        )
                    produced.rename(wanted_by_src[src])
                    produced_by_src[src] = wanted_by_src[src]

    # Giữ đúng thứ tự đầu vào
    return [produced_by_src[src] for src in valid]
