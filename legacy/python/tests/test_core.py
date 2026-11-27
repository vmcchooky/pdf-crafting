"""
Unit tests for PdfDocument core engine.
"""

from pathlib import Path

import pytest
from pdfcraft.core import PdfDocument, merge_pdfs, parse_page_selection
from pypdf import PdfReader, PdfWriter


def test_parse_page_selection():
    assert parse_page_selection(3, 5) == [3]
    assert parse_page_selection([1, 4], 5) == [1, 4]
    assert parse_page_selection("1, 3, 5", 5) == [1, 3, 5]
    assert parse_page_selection("2-4", 5) == [2, 3, 4]
    assert parse_page_selection("1, 3-5", 5) == [1, 3, 4, 5]
    assert parse_page_selection(" 1 , 2 - 3 ", 5) == [1, 2, 3]

    # Duplicate elimination
    assert parse_page_selection("1, 1, 2", 5) == [1, 2]

    # Out of range errors
    with pytest.raises(IndexError):
        parse_page_selection(6, 5)

    with pytest.raises(IndexError):
        parse_page_selection(0, 5)

    with pytest.raises(ValueError):
        parse_page_selection("5-2", 5)


def test_load_and_info(sample_pdf_5p: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    assert doc.page_count == 5

    info = doc.get_info()
    assert info.page_count == 5
    assert len(info.pages) == 5
    assert info.pages[0].page_number == 1
    assert info.pages[0].width > 500
    assert info.pages[0].height > 800
    assert info.pages[0].rotation == 0
    assert info.metadata.get("Title") == "Sample Document"

    # Text extraction
    t1 = doc.extract_text(1)
    assert "Doc1 Page 1" in t1

    all_text = doc.extract_text()
    assert len(all_text) == 5
    assert "Doc1 Page 5" in all_text[5]


def test_split_all(sample_pdf_5p: Path, tmp_path: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    out_dir = tmp_path / "split_output"
    files = doc.split_all(output_dir=out_dir, pattern="single_page_{index}.pdf")

    assert len(files) == 5
    for i, file_path in enumerate(files, start=1):
        assert file_path.exists()
        assert file_path.name == f"single_page_{i}.pdf"
        reader = PdfReader(str(file_path))
        assert len(reader.pages) == 1
        text = reader.pages[0].extract_text()
        assert f"Doc1 Page {i}" in text


def test_extract_pages(sample_pdf_5p: Path, tmp_path: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    out_file = tmp_path / "extracted.pdf"
    res = doc.extract_pages(pages="1, 3, 5", output_path=out_file)

    assert res.exists()
    reader = PdfReader(str(res))
    assert len(reader.pages) == 3
    assert "Doc1 Page 1" in reader.pages[0].extract_text()
    assert "Doc1 Page 3" in reader.pages[1].extract_text()
    assert "Doc1 Page 5" in reader.pages[2].extract_text()


def test_move_page(sample_pdf_5p: Path, tmp_path: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    # Move page 4 to position 1 -> [P4, P1, P2, P3, P5]
    doc.move_page(from_page=4, to_page=1)
    out_file = tmp_path / "moved.pdf"
    doc.save(out_file)

    reader = PdfReader(str(out_file))
    assert len(reader.pages) == 5
    assert "Doc1 Page 4" in reader.pages[0].extract_text()
    assert "Doc1 Page 1" in reader.pages[1].extract_text()
    assert "Doc1 Page 2" in reader.pages[2].extract_text()
    assert "Doc1 Page 3" in reader.pages[3].extract_text()
    assert "Doc1 Page 5" in reader.pages[4].extract_text()

    # Out of bounds
    with pytest.raises(IndexError):
        doc.move_page(from_page=0, to_page=2)
    with pytest.raises(IndexError):
        doc.move_page(from_page=1, to_page=10)


def test_reorder_pages(sample_pdf_5p: Path, tmp_path: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    # Reverse order [5, 4, 3, 2, 1]
    doc.reorder_pages([5, 4, 3, 2, 1])
    out_file = tmp_path / "reordered.pdf"
    doc.save(out_file)

    reader = PdfReader(str(out_file))
    assert len(reader.pages) == 5
    for i in range(5):
        expected_page_num = 5 - i
        assert f"Doc1 Page {expected_page_num}" in reader.pages[i].extract_text()

    # Invalid permutation
    with pytest.raises(ValueError):
        doc.reorder_pages([1, 2, 3])  # Too short

    with pytest.raises(ValueError):
        doc.reorder_pages([1, 1, 2, 3, 4])  # Duplicate


def test_insert_from_file(sample_pdf_5p: Path, sample_pdf_insert: Path, tmp_path: Path):
    # Insert at beginning (at_position=1)
    doc = PdfDocument.open(sample_pdf_5p)
    doc.insert_from_file(source_path=sample_pdf_insert, at_position=1)
    assert doc.page_count == 7
    out_file = tmp_path / "inserted_start.pdf"
    doc.save(out_file)

    reader = PdfReader(str(out_file))
    assert len(reader.pages) == 7
    assert "Inserted Page A" in reader.pages[0].extract_text()
    assert "Inserted Page B" in reader.pages[1].extract_text()
    assert "Doc1 Page 1" in reader.pages[2].extract_text()

    # Insert at middle (position 3) with specific page selection
    doc2 = PdfDocument.open(sample_pdf_5p)
    doc2.insert_from_file(
        source_path=sample_pdf_insert, at_position=3, source_pages=[2]
    )
    assert doc2.page_count == 6
    out_mid = tmp_path / "inserted_mid.pdf"
    doc2.save(out_mid)

    reader2 = PdfReader(str(out_mid))
    assert len(reader2.pages) == 6
    assert "Doc1 Page 1" in reader2.pages[0].extract_text()
    assert "Doc1 Page 2" in reader2.pages[1].extract_text()
    assert "Inserted Page B" in reader2.pages[2].extract_text()
    assert "Doc1 Page 3" in reader2.pages[3].extract_text()

    # Insert at end (position = page_count + 1)
    doc3 = PdfDocument.open(sample_pdf_5p)
    doc3.insert_from_file(source_path=sample_pdf_insert, at_position=6)
    assert doc3.page_count == 7
    assert "Inserted Page B" in doc3.extract_text(7)


def test_rotate_pages(sample_pdf_5p: Path, tmp_path: Path):
    from pdfcraft.core import merge_pdfs

    doc = PdfDocument.open(sample_pdf_5p)
    doc.rotate_pages("1,3", 90)
    out_file = tmp_path / "rotated.pdf"
    doc.save(out_file)

    reader = PdfReader(str(out_file))
    assert len(reader.pages) == 5
    assert int(reader.pages[0].get("/Rotate") or 0) % 360 == 90
    assert int(reader.pages[2].get("/Rotate") or 0) % 360 == 90
    # Trang không xoay giữ nguyên
    assert (reader.pages[1].get("/Rotate") or 0) in (0, None)

    # Góc âm tương đương chiều ngược lại (-90 == 270)
    doc2 = PdfDocument.open(sample_pdf_5p)
    doc2.rotate_pages(2, -90)
    assert int(doc2._pages[1].get("/Rotate") or 0) % 360 == 270

    # Góc không hợp lệ
    with pytest.raises(ValueError):
        doc2.rotate_pages(1, 45)
    with pytest.raises(IndexError):
        doc2.rotate_pages(99, 90)

    # Merge nhiều file giữ đúng thứ tự
    merged = tmp_path / "merged.pdf"
    merge_pdfs([sample_pdf_5p, sample_pdf_5p], merged)
    mreader = PdfReader(str(merged))
    assert len(mreader.pages) == 10
    assert "Doc1 Page 1" in mreader.pages[0].extract_text()
    assert "Doc1 Page 1" in mreader.pages[5].extract_text()

    with pytest.raises(ValueError):
        merge_pdfs([], tmp_path / "empty.pdf")


def test_encrypt_decrypt_roundtrip(sample_pdf_5p: Path, tmp_path: Path):
    from pdfcraft.core import decrypt_pdf, encrypt_pdf

    enc = tmp_path / "enc.pdf"
    encrypt_pdf(sample_pdf_5p, enc, "pw123", "owner456")

    # Không mở được nếu thiếu/sai mật khẩu
    with pytest.raises(ValueError):
        PdfDocument.open(enc)
    with pytest.raises(ValueError):
        PdfDocument.open(enc, password="sai-mat-khau")

    doc = PdfDocument.open(enc, password="pw123")
    assert doc.page_count == 5

    dec = tmp_path / "dec.pdf"
    decrypt_pdf(enc, dec, "pw123")
    reader = PdfReader(str(dec))
    assert len(reader.pages) == 5
    assert "Doc1 Page 1" in reader.pages[0].extract_text()

    with pytest.raises(ValueError):
        encrypt_pdf(sample_pdf_5p, tmp_path / "x.pdf", "")


def test_set_metadata_and_preserve(sample_pdf_5p: Path, tmp_path: Path):
    # Metadata gốc được giữ lại khi save thường
    doc = PdfDocument.open(sample_pdf_5p)
    out = tmp_path / "kept.pdf"
    doc.save(out)
    kept = PdfReader(str(out)).metadata
    assert kept is not None
    assert kept.title == "Sample Document"

    # Sửa metadata
    doc.set_metadata(title="Tieu de moi", author="Toi")
    out2 = tmp_path / "meta.pdf"
    doc.save(out2)
    meta = PdfReader(str(out2)).metadata
    assert meta is not None
    assert meta.title == "Tieu de moi"
    assert meta.author == "Toi"


def test_text_watermark(sample_pdf_5p: Path, tmp_path: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    doc.add_text_watermark("DRAFT", pages="1-2")
    out = tmp_path / "wm.pdf"
    doc.save(out)

    reader = PdfReader(str(out))
    assert len(reader.pages) == 5
    assert "DRAFT" in (reader.pages[0].extract_text() or "")
    assert "DRAFT" not in (reader.pages[2].extract_text() or "")

    with pytest.raises(ValueError):
        doc.add_text_watermark("   ")
    with pytest.raises(ValueError):
        doc.add_text_watermark("X", opacity=1.5)


def test_compress_pdf(sample_pdf_5p: Path, tmp_path: Path):
    from pdfcraft.core import compress_pdf

    out = tmp_path / "opt.pdf"
    compress_pdf(sample_pdf_5p, out)
    reader = PdfReader(str(out))
    assert len(reader.pages) == 5
    assert "Doc1 Page 1" in reader.pages[0].extract_text()


def test_delete_pages(sample_pdf_5p: Path, tmp_path: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    # Delete pages 2 and 4 -> Remaining: 1, 3, 5
    doc.delete_pages([2, 4])
    assert doc.page_count == 3
    out_file = tmp_path / "deleted.pdf"
    doc.save(out_file)

    reader = PdfReader(str(out_file))
    assert len(reader.pages) == 3
    assert "Doc1 Page 1" in reader.pages[0].extract_text()
    assert "Doc1 Page 3" in reader.pages[1].extract_text()
    assert "Doc1 Page 5" in reader.pages[2].extract_text()

    # Deleting all pages must raise ValueError
    with pytest.raises(ValueError):
        doc.delete_pages("1-3")


def test_save_in_place(sample_pdf_5p: Path):
    doc = PdfDocument.open(sample_pdf_5p)
    doc.delete_pages(1)
    # Save in-place without passing output_path
    saved = doc.save()
    assert saved == sample_pdf_5p

    reader = PdfReader(str(sample_pdf_5p))
    assert len(reader.pages) == 4
    assert "Doc1 Page 2" in reader.pages[0].extract_text()


def test_consecutive_in_place_saves(sample_pdf_5p: Path):
    """Test that multiple consecutive in-place saves do not encounter file lock issues."""
    doc = PdfDocument.open(sample_pdf_5p)
    for i in range(3):
        doc.move_page(from_page=doc.page_count, to_page=1)
        res = doc.save()
        assert res.exists()
        reloaded = PdfDocument.open(res)
        assert reloaded.page_count == 5


def _make_bookmarked_pdf(path: Path, pages: int, marks: list) -> Path:
    def add(writer, items, parent=None):
        for title, page, kids in items:
            ref = writer.add_outline_item(title, page - 1, parent)
            add(writer, kids, ref)

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=595, height=842)
    add(writer, marks)
    with open(path, "wb") as f:
        writer.write(f)
    return path


def test_bookmarks_roundtrip(tmp_path: Path):
    src = _make_bookmarked_pdf(
        tmp_path / "bm.pdf",
        4,
        [("Chuong 1", 1, [("Muc 1.1", 2, [])]), ("Chuong 2", 4, [])],
    )
    doc = PdfDocument.open(src)
    assert doc.get_bookmarks() == [
        {
            "title": "Chuong 1",
            "page": 1,
            "kids": [{"title": "Muc 1.1", "page": 2, "kids": []}],
        },
        {"title": "Chuong 2", "page": 4, "kids": []},
    ]

    out = tmp_path / "bm_out.pdf"
    doc.set_bookmarks([{"title": "Moi", "page": 3, "kids": []}])
    doc.save(out)
    assert PdfDocument.open(out).get_bookmarks() == [
        {"title": "Moi", "page": 3, "kids": []}
    ]


def test_bookmarks_add_clear(tmp_path: Path):
    src = _make_bookmarked_pdf(tmp_path / "bm.pdf", 3, [])
    doc = PdfDocument.open(src)
    assert doc.get_bookmarks() == []

    out = tmp_path / "bm_add.pdf"
    doc.add_bookmark("Phu luc", 2).save(out)
    assert PdfDocument.open(out).get_bookmarks() == [
        {"title": "Phu luc", "page": 2, "kids": []}
    ]

    out2 = tmp_path / "bm_clear.pdf"
    PdfDocument.open(out).clear_bookmarks().save(out2)
    assert PdfDocument.open(out2).get_bookmarks() == []


def test_bookmarks_invalid_page(tmp_path: Path):
    src = _make_bookmarked_pdf(tmp_path / "bm.pdf", 3, [])
    doc = PdfDocument.open(src)
    with pytest.raises(ValueError):
        doc.set_bookmarks([{"title": "Sai", "page": 99, "kids": []}])
    with pytest.raises(ValueError):
        doc.set_bookmarks([{"title": "", "page": 1, "kids": []}])


def test_merge_preserves_bookmarks(tmp_path: Path):
    a = _make_bookmarked_pdf(tmp_path / "a.pdf", 3, [("Chuong 1", 1, [])])
    b = _make_bookmarked_pdf(tmp_path / "b.pdf", 2, [("Phu luc", 2, [])])
    out = merge_pdfs([a, b], tmp_path / "merged.pdf")
    assert PdfDocument.open(out).get_bookmarks() == [
        {"title": "Chuong 1", "page": 1, "kids": []},
        {"title": "Phu luc", "page": 5, "kids": []},
    ]
