"""
Core PDF manipulation module using pypdf.
Supports reading, splitting, extracting, moving, inserting, deleting, and reordering pages.
"""

from __future__ import annotations

import io
import logging
import math
import os
import shutil
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, overload

from pypdf import PageObject, PdfReader, PdfWriter
from pypdf.generic import (
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
)

logger = logging.getLogger(__name__)


@dataclass
class PageInfo:
    """Metadata and geometry information for a single PDF page."""

    page_number: int  # 1-based
    width: float
    height: float
    rotation: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_number": self.page_number,
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "rotation": self.rotation,
        }


@dataclass
class DocumentInfo:
    """Information summary of the PDF document."""

    file_path: str
    page_count: int
    file_size_bytes: int
    metadata: dict[str, Any] = field(default_factory=dict)
    pages: list[PageInfo] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_path": self.file_path,
            "page_count": self.page_count,
            "file_size_bytes": self.file_size_bytes,
            "metadata": self.metadata,
            "pages": [p.to_dict() for p in self.pages],
        }


def parse_page_selection(spec: str | int | Sequence[int], max_pages: int) -> list[int]:
    """
    Parse a page selection specification into a sorted list of 1-based page numbers.
    Supported formats:
      - int: 3 -> [3]
      - Sequence[int]: [1, 3, 5] -> [1, 3, 5]
      - str: "1, 3, 5-7" -> [1, 3, 5, 6, 7]
    """
    if isinstance(spec, int):
        pages = [spec]
    elif isinstance(spec, (list, tuple)):
        pages = list(spec)
    elif isinstance(spec, str):
        pages = []
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                tokens = part.split("-", 1)
                start_str, end_str = tokens[0].strip(), tokens[1].strip()
                start = int(start_str) if start_str else 1
                end = int(end_str) if end_str else max_pages
                if start > end:
                    raise ValueError(
                        f"Dải trang không hợp lệ: {start}-{end} (bắt đầu lớn hơn kết thúc)"
                    )
                pages.extend(range(start, end + 1))
            else:
                pages.append(int(part))
    else:
        raise TypeError(f"Kiểu đặc tả trang không được hỗ trợ: {type(spec)}")

    # Validate range
    for p in pages:
        if p < 1 or p > max_pages:
            raise IndexError(
                f"Trang {p} nằm ngoài phạm vi tài liệu (1 đến {max_pages})"
            )

    return sorted(dict.fromkeys(pages))


def _build_text_watermark_page(
    width: float,
    height: float,
    text: str,
    font_size: int,
    rotation: float,
    opacity: float,
) -> PageObject:
    """Build a single-page overlay with centered, rotated, translucent text."""
    # Chỉ hỗ trợ Latin-1 với font Helvetica built-in; ký tự ngoài dải -> '?'
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    safe = safe.encode("latin-1", errors="replace").decode("latin-1")

    theta = math.radians(rotation)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    # Tâm trang + bù nửa chiều dài chữ ước lượng để watermark nằm giữa trang
    est_half_len = len(safe) * font_size * 0.30
    cx = width / 2 - est_half_len * cos_t
    cy = height / 2 - est_half_len * sin_t

    content = (
        "q "
        "/GS0 gs "
        "0.65 0.65 0.65 rg "
        f"BT /F1 {font_size} Tf "
        f"{cos_t:.4f} {sin_t:.4f} {-sin_t:.4f} {cos_t:.4f} {cx:.2f} {cy:.2f} Tm "
        f"({safe}) Tj ET "
        "Q"
    ).encode("latin-1")

    writer = PdfWriter()
    page = writer.add_blank_page(width=width, height=height)

    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    ext_gs = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/ExtGState"),
            NameObject("/CA"): FloatObject(opacity),
            NameObject("/ca"): FloatObject(opacity),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): writer._add_object(font)}
            ),
            NameObject("/ExtGState"): DictionaryObject(
                {NameObject("/GS0"): writer._add_object(ext_gs)}
            ),
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(content)
    page[NameObject("/Contents")] = writer._add_object(stream)

    # Đọc lại qua PdfReader để merge_page nhận page "sạch" (tránh dính writer tạm)
    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    return PdfReader(buf).pages[0]


class PdfDocument:
    """
    Main class for loading and manipulating PDF documents.
    All user-facing page indexing is 1-based for natural usability.
    """

    def __init__(
        self, file_path: str | Path | None = None, password: str | None = None
    ):
        self.file_path: Path | None = Path(file_path).resolve() if file_path else None
        self._pages: list[PageObject] = []
        self._metadata: dict[str, Any] = {}

        if self.file_path:
            self.load(self.file_path, password=password)

    @classmethod
    def open(cls, file_path: str | Path, password: str | None = None) -> PdfDocument:
        """Convenience factory method to open a PDF file (pass `password` for encrypted files)."""
        return cls(file_path, password=password)

    def load(self, file_path: str | Path, password: str | None = None) -> PdfDocument:
        """Load a PDF file from the specified path."""
        path = Path(file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Không tìm thấy tệp PDF: {path}")

        self.file_path = path
        # Đọc dữ liệu vào bộ nhớ để tránh khóa tệp (file lock) trên Windows
        with open(path, "rb") as f:
            pdf_bytes = io.BytesIO(f.read())
        reader = PdfReader(pdf_bytes)
        if reader.is_encrypted:
            if password is None:
                raise ValueError(
                    "Tệp PDF được mã hóa, cần mật khẩu để mở (truyền password=... hoặc dùng lệnh decrypt)"
                )
            # decrypt() trả về 0 (NOT_DECRYPTED) khi sai mật khẩu
            if not reader.decrypt(password):
                raise ValueError("Mật khẩu không đúng, không thể mở tệp PDF")
        self._pages = list(reader.pages)

        # Extract metadata
        self._metadata = {}
        if reader.metadata:
            for k, v in reader.metadata.items():
                clean_key = str(k).lstrip("/")
                self._metadata[clean_key] = str(v) if v is not None else ""

        return self

    @property
    def page_count(self) -> int:
        """Return the current number of pages in the document."""
        return len(self._pages)

    def get_info(self) -> DocumentInfo:
        """Return full document information including geometry and metadata."""
        if not self.file_path or not self.file_path.exists():
            file_size = 0
            path_str = str(self.file_path) if self.file_path else "<memory>"
        else:
            file_size = self.file_path.stat().st_size
            path_str = str(self.file_path)

        pages_info: list[PageInfo] = []
        for i, p in enumerate(self._pages, start=1):
            box = p.mediabox
            width = float(box.width)
            height = float(box.height)
            rotation = p.rotation if hasattr(p, "rotation") else 0
            pages_info.append(
                PageInfo(page_number=i, width=width, height=height, rotation=rotation)
            )

        return DocumentInfo(
            file_path=path_str,
            page_count=self.page_count,
            file_size_bytes=file_size,
            metadata=self._metadata.copy(),
            pages=pages_info,
        )

    @overload
    def extract_text(self, page_num: int) -> str: ...

    @overload
    def extract_text(self, page_num: None = None) -> dict[int, str]: ...

    def extract_text(self, page_num: int | None = None) -> str | dict[int, str]:
        """
        Extract text content.
        If page_num (1-based) is given, returns the text of that page.
        If page_num is None, returns a dict mapping {page_num: text}.
        """
        if page_num is not None:
            self._validate_page_index(page_num)
            return self._pages[page_num - 1].extract_text() or ""

        return {i: (p.extract_text() or "") for i, p in enumerate(self._pages, start=1)}

    def move_page(self, from_page: int, to_page: int) -> PdfDocument:
        """
        Move a page from position `from_page` to position `to_page` (1-based).
        Example: In [P1, P2, P3, P4], move_page(3, 1) -> [P3, P1, P2, P4].
        """
        self._validate_page_index(from_page)
        self._validate_page_index(to_page)

        if from_page == to_page:
            return self

        # 0-based indices
        from_idx = from_page - 1
        to_idx = to_page - 1

        page = self._pages.pop(from_idx)
        self._pages.insert(to_idx, page)
        return self

    def reorder_pages(self, new_order: Sequence[int]) -> PdfDocument:
        """
        Reorder all pages according to `new_order` (1-based page numbers).
        Example: reorder_pages([3, 1, 2])
        `new_order` must contain each page from 1..page_count exactly once.
        """
        n = self.page_count
        if len(new_order) != n:
            raise ValueError(
                f"Thứ tự mới phải có đúng {n} phần tử (nhận được {len(new_order)})"
            )

        if set(new_order) != set(range(1, n + 1)):
            raise ValueError(
                f"Thứ tự mới phải là một hoán vị hợp lệ của các trang từ 1 đến {n}"
            )

        reordered = [self._pages[p - 1] for p in new_order]
        self._pages = reordered
        return self

    def insert_from_file(
        self,
        source_path: str | Path,
        at_position: int,
        source_pages: str | Sequence[int] | None = None,
    ) -> PdfDocument:
        """
        Insert pages from another PDF file at `at_position` (1-based).
        `at_position` = 1 inserts before the first page.
        `at_position` = page_count + 1 appends after the last page.
        `source_pages`: optional list or string ("1, 2-3") specifying which pages from source to insert.
                        Defaults to all pages of source.
        """
        if at_position < 1 or at_position > self.page_count + 1:
            raise IndexError(
                f"Vị trí chèn {at_position} không hợp lệ (phải từ 1 đến {self.page_count + 1})"
            )

        src_path = Path(source_path).resolve()
        if not src_path.is_file():
            raise FileNotFoundError(f"Không tìm thấy tệp nguồn để chèn: {src_path}")

        with open(src_path, "rb") as f:
            src_bytes = io.BytesIO(f.read())
        src_reader = PdfReader(src_bytes)
        src_total = len(src_reader.pages)
        if src_total == 0:
            raise ValueError(f"Tệp nguồn không có trang nào: {src_path}")

        if source_pages is None:
            pages_to_insert = list(src_reader.pages)
        else:
            selected_indices = parse_page_selection(source_pages, src_total)
            pages_to_insert = [src_reader.pages[i - 1] for i in selected_indices]

        # Insert at 0-based index
        insert_idx = at_position - 1
        for i, page in enumerate(pages_to_insert):
            self._pages.insert(insert_idx + i, page)

        return self

    def rotate_pages(self, pages: int | str | Sequence[int], angle: int) -> PdfDocument:
        """
        Rotate selected pages clockwise by `angle` degrees (1-based page selection).
        `angle` must be a multiple of 90 (e.g. 90, 180, 270 or -90, -180).
        Negative angles rotate counter-clockwise (-90 == 270 clockwise).
        Example: rotate_pages("1, 3-5", 90) rotates pages 1, 3, 4, 5 by 90° clockwise.
        """
        if not isinstance(angle, int):
            raise TypeError(f"Góc xoay phải là số nguyên (nhận được {type(angle)})")
        if angle % 90 != 0:
            raise ValueError(f"Góc xoay phải là bội số của 90 độ (nhận được {angle})")

        normalized = angle % 360
        if normalized == 0:
            return self

        selected = parse_page_selection(pages, self.page_count)
        for p in selected:
            self._pages[p - 1].rotate(normalized)
        return self

    @staticmethod
    def merge(input_paths: Sequence[str | Path], output_path: str | Path) -> Path:
        """
        Merge multiple PDF files into a single PDF, preserving page order.
        `input_paths`: list of at least 1 PDF file (merging 1 file == copy).
        Returns the output Path.
        """
        return merge_pdfs(input_paths, output_path)

    def set_metadata(
        self,
        title: str | None = None,
        author: str | None = None,
        subject: str | None = None,
        keywords: str | None = None,
        creator: str | None = None,
    ) -> PdfDocument:
        """
        Update document metadata (Info dictionary). Only non-None fields are changed.
        Call `save()` afterwards to persist. Example: doc.set_metadata(title="Báo cáo Q3").
        """
        updates = {
            "Title": title,
            "Author": author,
            "Subject": subject,
            "Keywords": keywords,
            "Creator": creator,
        }
        for key, value in updates.items():
            if value is not None:
                self._metadata[key] = value
        return self

    def add_text_watermark(
        self,
        text: str,
        pages: int | str | Sequence[int] | None = None,
        font_size: int = 48,
        rotation: float = 45,
        opacity: float = 0.3,
    ) -> PdfDocument:
        """
        Stamp a semi-transparent text watermark (e.g. "DRAFT", "BẢN NHÁP") onto pages.
        `pages`: page selection (default: all pages). `rotation` in degrees, `opacity` 0..1.
        Note: rendered with the built-in Helvetica font (Latin-1); non-Latin scripts
        (e.g. Vietnamese diacritics) may not render correctly with this backend.
        """
        if not text or not text.strip():
            raise ValueError("Nội dung watermark không được để trống")
        if font_size <= 0:
            raise ValueError(f"Cỡ chữ phải > 0 (nhận được {font_size})")
        if not 0 <= opacity <= 1:
            raise ValueError(f"Độ mờ phải trong khoảng 0..1 (nhận được {opacity})")

        if pages is None:
            selected = list(range(1, self.page_count + 1))
        else:
            selected = parse_page_selection(pages, self.page_count)

        # Gắn trang vào writer tạm trước khi merge để tránh DeprecationWarning
        # replace_contents của pypdf 6.x (sẽ thành lỗi ở pypdf 7.0)
        tmp_writer = PdfWriter()
        for page in self._pages:
            tmp_writer.add_page(page)

        # Dựng 1 trang watermark cho mỗi kích thước trang riêng biệt để tái sử dụng
        overlay_cache: dict[tuple[float, float], PageObject] = {}
        for p in selected:
            target = tmp_writer.pages[p - 1]
            box = target.mediabox
            key = (round(float(box.width), 2), round(float(box.height), 2))
            if key not in overlay_cache:
                overlay_cache[key] = _build_text_watermark_page(
                    width=float(box.width),
                    height=float(box.height),
                    text=text,
                    font_size=font_size,
                    rotation=rotation,
                    opacity=opacity,
                )
            target.merge_page(overlay_cache[key])

        # Vật chất hóa lại danh sách trang từ writer tạm
        buf = io.BytesIO()
        tmp_writer.write(buf)
        buf.seek(0)
        self._pages = list(PdfReader(buf).pages)
        return self

    def delete_pages(self, pages: int | str | Sequence[int]) -> PdfDocument:
        """
        Delete one or more pages (1-based indices or range string e.g. "1, 3-4").
        Raises ValueError if attempting to delete all pages.
        """
        if self.page_count == 0:
            raise ValueError("Tài liệu đang không có trang nào để xóa")

        indices_to_delete = set(parse_page_selection(pages, self.page_count))

        if len(indices_to_delete) >= self.page_count:
            raise ValueError("Không thể xóa toàn bộ các trang trong tài liệu")

        # Keep pages not in the delete set
        new_pages = [
            page
            for i, page in enumerate(self._pages, start=1)
            if i not in indices_to_delete
        ]
        self._pages = new_pages
        return self

    def split_all(
        self,
        output_dir: str | Path,
        pattern: str = "page_{index}.pdf",
    ) -> list[Path]:
        """
        Split all pages into separate single-page PDF files in `output_dir`.
        `pattern`: string with `{index}` placeholder (1-based).
        Returns list of created file paths.
        """
        out_dir = Path(output_dir).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)

        created_files: list[Path] = []
        for i, page in enumerate(self._pages, start=1):
            writer = PdfWriter()
            writer.add_page(page)
            target_name = pattern.format(index=i)
            target_path = out_dir / target_name
            with open(target_path, "wb") as f:
                writer.write(f)
            created_files.append(target_path)

        return created_files

    def extract_pages(
        self,
        pages: int | str | Sequence[int],
        output_path: str | Path,
    ) -> Path:
        """
        Extract specified pages (e.g. "1, 3-5") and save them into a new PDF file.
        Returns the output Path.
        """
        selected_pages = parse_page_selection(pages, self.page_count)
        out_path = Path(output_path).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)

        writer = PdfWriter()
        for p in selected_pages:
            writer.add_page(self._pages[p - 1])

        with open(out_path, "wb") as f:
            writer.write(f)

        return out_path

    def save(
        self,
        output_path: str | Path | None = None,
        user_password: str | None = None,
        owner_password: str | None = None,
        optimize: bool = False,
    ) -> Path:
        """
        Save the current state of pages to `output_path`.
        If `output_path` is None, overwrites the current loaded file safely.
        Metadata đã đọc/sửa được giữ lại trong file kết quả.
        `user_password`/`owner_password`: mã hóa file kết quả (owner mặc định = user).
        `optimize`: nén lossless (nén content stream + khử object trùng lặp).
        """
        if output_path is None:
            if not self.file_path:
                raise ValueError("Chưa có đường dẫn đích để lưu tài liệu")
            target = self.file_path
        else:
            target = Path(output_path).resolve()

        target.parent.mkdir(parents=True, exist_ok=True)

        writer = PdfWriter()
        for page in self._pages:
            writer.add_page(page)

        if self._metadata:
            writer.add_metadata({f"/{k}": v for k, v in self._metadata.items() if v})

        if optimize:
            # Nén trên writer.pages (page đã gắn writer) để tránh DeprecationWarning
            # replace_contents của pypdf 6.x
            for page in writer.pages:
                try:
                    page.compress_content_streams()
                except Exception:
                    logger.debug("compress_content_streams thất bại", exc_info=True)
            try:
                writer.compress_identical_objects()
            except Exception:
                logger.debug("compress_identical_objects thất bại", exc_info=True)

        if user_password:
            writer.encrypt(user_password, owner_password or user_password)

        # Ghi vào tệp tạm trước để tránh làm hỏng tệp gốc và an toàn tuyệt đối khi source == target
        tmp_fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=str(target.parent))
        tmp_path = Path(tmp_name)
        try:
            with open(tmp_fd, "wb") as tmp_file:
                writer.write(tmp_file)
            # Thay thế nguyên tử (atomic replace) trên Windows
            if target.exists():
                try:
                    os.replace(str(tmp_path), str(target))
                except OSError:
                    shutil.copyfile(str(tmp_path), str(target))
                    tmp_path.unlink(missing_ok=True)
            else:
                os.replace(str(tmp_path), str(target))
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass

        self.file_path = target
        return target

    def _validate_page_index(self, page_num: int) -> None:
        if page_num < 1 or page_num > self.page_count:
            raise IndexError(
                f"Chỉ số trang {page_num} không hợp lệ. Tài liệu có {self.page_count} trang (phạm vi từ 1 đến {self.page_count})"
            )

    def __len__(self) -> int:
        return self.page_count

    def __repr__(self) -> str:
        src = f"'{self.file_path.name}'" if self.file_path else "<memory>"
        return f"<PdfDocument {src}, pages={self.page_count}>"


def merge_pdfs(input_paths: Sequence[str | Path], output_path: str | Path) -> Path:
    """
    Merge multiple PDF files into a single PDF, preserving input order.
    Each input contributes all of its pages in original order.
    Returns the output Path.
    """
    paths = [Path(p).resolve() for p in input_paths]
    if len(paths) == 0:
        raise ValueError("Cần ít nhất 1 tệp PDF đầu vào để gộp")

    out_path = Path(output_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Ngăn ghi đè nguồn khi output trùng 1 trong các input: dựng writer trước, ghi file tạm rồi replace
    writer = PdfWriter()
    total_pages = 0
    for src in paths:
        if not src.is_file():
            raise FileNotFoundError(f"Không tìm thấy tệp PDF để gộp: {src}")
        with open(src, "rb") as f:
            reader = PdfReader(io.BytesIO(f.read()))
            if len(reader.pages) == 0:
                raise ValueError(f"Tệp nguồn không có trang nào: {src}")
            for page in reader.pages:
                writer.add_page(page)
                total_pages += 1

    if total_pages == 0:
        raise ValueError("Không có trang nào để gộp")

    tmp_fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=str(out_path.parent))
    tmp_path = Path(tmp_name)
    try:
        with open(tmp_fd, "wb") as tmp_file:
            writer.write(tmp_file)
        if out_path.exists():
            try:
                os.replace(str(tmp_path), str(out_path))
            except OSError:
                shutil.copyfile(str(tmp_path), str(out_path))
                tmp_path.unlink(missing_ok=True)
        else:
            os.replace(str(tmp_path), str(out_path))
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass

    return out_path


def encrypt_pdf(
    input_path: str | Path,
    output_path: str | Path,
    user_password: str,
    owner_password: str | None = None,
) -> Path:
    """
    Encrypt a PDF with a user password (required to open) and an optional owner
    password (full rights, defaults to the user password). Returns output Path.
    """
    if not user_password:
        raise ValueError("Mật khẩu người dùng (user password) không được để trống")
    doc = PdfDocument.open(input_path)
    return doc.save(
        output_path, user_password=user_password, owner_password=owner_password
    )


def decrypt_pdf(input_path: str | Path, output_path: str | Path, password: str) -> Path:
    """
    Decrypt a PDF with `password` and save an unencrypted copy. Returns output Path.
    """
    if not password:
        raise ValueError("Mật khẩu giải mã không được để trống")
    doc = PdfDocument.open(input_path, password=password)
    return doc.save(output_path)


def compress_pdf(input_path: str | Path, output_path: str | Path) -> Path:
    """
    Lossless size optimization: compress content streams and remove duplicate
    objects. Returns output Path. (For heavy image downsampling, use the Web UI
    Nén & Xuất file panel instead.)
    """
    doc = PdfDocument.open(input_path)
    return doc.save(output_path, optimize=True)
