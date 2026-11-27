"""
Pytest configuration and fixtures for pdfcraft tests.
"""

from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def generate_pdf_with_text(
    path: Path,
    pages_text: list[str],
    metadata: dict[str, str] | None = None,
) -> Path:
    """Generate a valid PDF file with visible text on each page for test verification."""
    writer = PdfWriter()
    for text in pages_text:
        page = writer.add_blank_page(width=595.27, height=841.89)  # A4 size
        content = f"BT /F1 20 Tf 50 750 Td ({text}) Tj ET".encode("latin-1")
        stream = DecodedStreamObject()
        stream.set_data(content)
        page[NameObject("/Contents")] = writer._add_object(stream)

        fonts = DictionaryObject()
        f1 = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        fonts[NameObject("/F1")] = writer._add_object(f1)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): fonts})

    if metadata:
        meta_dict = {f"/{k}": v for k, v in metadata.items()}
        writer.add_metadata(meta_dict)

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        writer.write(f)

    return path


@pytest.fixture
def sample_pdf_5p(tmp_path: Path) -> Path:
    """A 5-page test PDF with distinct text on each page."""
    pdf_path = tmp_path / "sample_5p.pdf"
    texts = [f"Doc1 Page {i}" for i in range(1, 6)]
    return generate_pdf_with_text(
        pdf_path,
        texts,
        metadata={"Title": "Sample Document", "Author": "Antigravity"},
    )


@pytest.fixture
def sample_pdf_insert(tmp_path: Path) -> Path:
    """A 2-page test PDF to be inserted into another document."""
    pdf_path = tmp_path / "sample_insert.pdf"
    texts = ["Inserted Page A", "Inserted Page B"]
    return generate_pdf_with_text(
        pdf_path,
        texts,
        metadata={"Title": "Insert Source"},
    )
