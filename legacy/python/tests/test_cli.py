"""
Integration tests for pdfcraft CLI.
"""

from pathlib import Path

from pdfcraft.cli import main
from pypdf import PdfReader


def test_cli_info(sample_pdf_5p: Path, capsys):
    ret = main(["info", str(sample_pdf_5p)])
    assert ret == 0
    captured = capsys.readouterr()
    assert "THÔNG TIN TÀI LIỆU PDF" in captured.out
    assert "Tổng số trang:    5" in captured.out
    assert "Sample Document" in captured.out


def test_cli_split(sample_pdf_5p: Path, tmp_path: Path):
    split_dir = tmp_path / "cli_split"
    ret = main(["split", str(sample_pdf_5p), "-d", str(split_dir)])
    assert ret == 0
    assert len(list(split_dir.glob("*.pdf"))) == 5


def test_cli_extract(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_extracted.pdf"
    ret = main(["extract", str(sample_pdf_5p), "--pages", "2,4", "-o", str(out)])
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert len(reader.pages) == 2
    assert "Doc1 Page 2" in reader.pages[0].extract_text()
    assert "Doc1 Page 4" in reader.pages[1].extract_text()


def test_cli_move(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_moved.pdf"
    ret = main(
        [
            "move",
            str(sample_pdf_5p),
            "--from-page",
            "5",
            "--to-page",
            "1",
            "-o",
            str(out),
        ]
    )
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert len(reader.pages) == 5
    assert "Doc1 Page 5" in reader.pages[0].extract_text()


def test_cli_reorder(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_reordered.pdf"
    ret = main(["reorder", str(sample_pdf_5p), "--order", "3,1,2,4,5", "-o", str(out)])
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert "Doc1 Page 3" in reader.pages[0].extract_text()
    assert "Doc1 Page 1" in reader.pages[1].extract_text()


def test_cli_insert(sample_pdf_5p: Path, sample_pdf_insert: Path, tmp_path: Path):
    out = tmp_path / "cli_inserted.pdf"
    ret = main(
        [
            "insert",
            str(sample_pdf_5p),
            "-s",
            str(sample_pdf_insert),
            "--at",
            "2",
            "-o",
            str(out),
        ]
    )
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert len(reader.pages) == 7
    assert "Doc1 Page 1" in reader.pages[0].extract_text()
    assert "Inserted Page A" in reader.pages[1].extract_text()


def test_cli_delete(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_deleted.pdf"
    ret = main(["delete", str(sample_pdf_5p), "--pages", "1,5", "-o", str(out)])
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert len(reader.pages) == 3
    assert "Doc1 Page 2" in reader.pages[0].extract_text()
    assert "Doc1 Page 4" in reader.pages[2].extract_text()


def test_cli_rotate(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_rotated.pdf"
    ret = main(
        [
            "rotate",
            str(sample_pdf_5p),
            "--pages",
            "1,3",
            "--angle",
            "90",
            "-o",
            str(out),
        ]
    )
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert len(reader.pages) == 5
    assert int(reader.pages[0].get("/Rotate") or 0) % 360 == 90


def test_cli_merge(sample_pdf_5p: Path, sample_pdf_insert: Path, tmp_path: Path):
    out = tmp_path / "cli_merged.pdf"
    ret = main(["merge", str(sample_pdf_5p), str(sample_pdf_insert), "-o", str(out)])
    assert ret == 0
    assert out.exists()
    reader = PdfReader(str(out))
    assert len(reader.pages) == 7
    assert "Doc1 Page 1" in reader.pages[0].extract_text()
    assert "Inserted Page A" in reader.pages[5].extract_text()


def test_cli_encrypt_decrypt(sample_pdf_5p: Path, tmp_path: Path):
    enc = tmp_path / "cli_enc.pdf"
    assert (
        main(["encrypt", str(sample_pdf_5p), "--user-pw", "pw123", "-o", str(enc)]) == 0
    )
    assert enc.exists()

    dec = tmp_path / "cli_dec.pdf"
    assert main(["decrypt", str(enc), "--password", "pw123", "-o", str(dec)]) == 0
    reader = PdfReader(str(dec))
    assert len(reader.pages) == 5


def test_cli_meta(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_meta.pdf"
    assert (
        main(["meta", str(sample_pdf_5p), "--title", "Tieu de CLI", "-o", str(out)])
        == 0
    )
    cli_meta = PdfReader(str(out)).metadata
    assert cli_meta is not None
    assert cli_meta.title == "Tieu de CLI"


def test_cli_watermark(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_wm.pdf"
    assert (
        main(
            [
                "watermark",
                str(sample_pdf_5p),
                "--text",
                "DRAFT",
                "--pages",
                "1",
                "-o",
                str(out),
            ]
        )
        == 0
    )
    reader = PdfReader(str(out))
    assert "DRAFT" in (reader.pages[0].extract_text() or "")


def test_cli_compress(sample_pdf_5p: Path, tmp_path: Path):
    out = tmp_path / "cli_opt.pdf"
    assert main(["compress", str(sample_pdf_5p), "-o", str(out)]) == 0
    assert len(PdfReader(str(out)).pages) == 5


def test_cli_text(sample_pdf_5p: Path, capsys):
    ret = main(["text", str(sample_pdf_5p), "--page", "3"])
    assert ret == 0
    captured = capsys.readouterr()
    assert "Doc1 Page 3" in captured.out


def test_cli_bookmark(sample_pdf_5p: Path, tmp_path: Path, capsys):
    out = tmp_path / "cli_bm.pdf"
    assert (
        main(
            [
                "bookmark",
                str(sample_pdf_5p),
                "--add",
                "Ket luan",
                "--page",
                "5",
                "-o",
                str(out),
            ]
        )
        == 0
    )
    assert out.exists()

    assert main(["bookmark", str(out)]) == 0
    assert "Ket luan (trang 5)" in capsys.readouterr().out

    exp = tmp_path / "bm.json"
    assert main(["bookmark", str(out), "--export", str(exp)]) == 0
    assert "Ket luan" in exp.read_text(encoding="utf-8")

    out2 = tmp_path / "cli_bm2.pdf"
    assert main(["bookmark", str(out), "--import-json", str(exp), "-o", str(out2)]) == 0
    assert main(["bookmark", str(out2)]) == 0
    assert "Ket luan (trang 5)" in capsys.readouterr().out

    out3 = tmp_path / "cli_bm3.pdf"
    assert main(["bookmark", str(out2), "--clear", "-o", str(out3)]) == 0
    assert main(["bookmark", str(out3)]) == 0
    assert "không có bookmark" in capsys.readouterr().out
