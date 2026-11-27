"""
Unit tests for batch Office -> PDF conversion (engine is mocked).
"""

import subprocess
from pathlib import Path

import pytest
from pdfcraft import office as office_module
from pdfcraft.office import convert_office_to_pdf
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def generate_pdf_with_text(path: Path, text: str) -> Path:
    """Minimal 1-page PDF (self-contained helper, engine output is mocked)."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=595.27, height=841.89)
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 20 Tf 50 750 Td ({text}) Tj ET".encode("latin-1"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    fonts = DictionaryObject()
    fonts[NameObject("/F1")] = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): fonts})
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        writer.write(f)
    return path


def make_fake_office(path: Path, text: str = "fake office content") -> Path:
    """Create a placeholder Office file (content irrelevant, engine is mocked)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))
    return path


def fake_runner_create_pdfs(engine, args, timeout):
    """Mock converter: writes a 1-page PDF for each input like soffice would."""
    assert "--headless" in args
    outdir = Path(args[args.index("--outdir") + 1])
    for src in args[args.index("--outdir") + 2 :]:
        stem = Path(src).stem
        generate_pdf_with_text(outdir / f"{stem}.pdf", f"Converted {stem}")
    return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")


def test_convert_batch(tmp_path: Path):
    a = make_fake_office(tmp_path / "docs" / "bao_cao.docx")
    b = make_fake_office(tmp_path / "docs" / "so_lieu.xlsx")
    out_dir = tmp_path / "pdf_out"

    created = convert_office_to_pdf(
        [a, b],
        output_dir=out_dir,
        engine="fake-soffice",
        runner=fake_runner_create_pdfs,
    )

    assert [p.name for p in created] == ["bao_cao.pdf", "so_lieu.pdf"]
    for p in created:
        assert p.exists()
        assert len(PdfReader(str(p)).pages) == 1


def test_convert_same_name_collision(tmp_path: Path):
    # a/x.docx và b/x.docx cùng vào 1 thư mục đích -> x.pdf, x_2.pdf
    a = make_fake_office(tmp_path / "a" / "x.docx")
    b = make_fake_office(tmp_path / "b" / "x.docx")
    out_dir = tmp_path / "out"

    created = convert_office_to_pdf(
        [a, b],
        output_dir=out_dir,
        engine="fake-soffice",
        runner=fake_runner_create_pdfs,
    )

    assert [p.name for p in created] == ["x.pdf", "x_2.pdf"]
    assert all(p.exists() for p in created)


def test_convert_default_output_dir(tmp_path: Path):
    a = make_fake_office(tmp_path / "docs" / "cv.docx")

    (created,) = convert_office_to_pdf(
        [a], engine="fake-soffice", runner=fake_runner_create_pdfs
    )

    assert created.parent == (tmp_path / "docs").resolve()
    assert created.name == "cv.pdf"


def test_convert_errors(tmp_path: Path):
    a = make_fake_office(tmp_path / "ok.docx")

    with pytest.raises(ValueError):
        convert_office_to_pdf([], engine="fake-soffice", runner=fake_runner_create_pdfs)

    with pytest.raises(FileNotFoundError):
        convert_office_to_pdf(
            [tmp_path / "khong_co.docx"],
            engine="fake-soffice",
            runner=fake_runner_create_pdfs,
        )

    not_pdf = tmp_path / "anh.png"
    not_pdf.write_bytes(b"PNG")
    with pytest.raises(ValueError):
        convert_office_to_pdf(
            [not_pdf], engine="fake-soffice", runner=fake_runner_create_pdfs
        )

    # Không có engine nào
    with pytest.raises(RuntimeError, match="LibreOffice"):
        convert_office_to_pdf([a], engine=None, runner=fake_runner_create_pdfs)

    # Converter báo lỗi
    def failing_runner(engine, args, timeout):
        return subprocess.CompletedProcess(
            args=args, returncode=1, stdout="", stderr="boom"
        )

    with pytest.raises(RuntimeError, match="boom"):
        convert_office_to_pdf([a], engine="fake-soffice", runner=failing_runner)

    # Converter treo quá timeout
    def hanging_runner(engine, args, timeout):
        raise subprocess.TimeoutExpired(cmd=args, timeout=timeout)

    with pytest.raises(RuntimeError, match="quá thời gian"):
        convert_office_to_pdf([a], engine="fake-soffice", runner=hanging_runner)


def test_cli_convert_no_engine(tmp_path: Path, capsys):
    from pdfcraft.cli import main

    a = make_fake_office(tmp_path / "f.docx")
    ret = main(["convert", str(a), "-d", str(tmp_path / "o")])
    # Môi trường test không có LibreOffice -> lỗi thân thiện, exit 1
    if office_module.find_office_engine() is None:
        assert ret == 1
        assert "LibreOffice" in capsys.readouterr().err
    else:
        assert ret == 0
