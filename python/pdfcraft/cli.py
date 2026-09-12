"""
Command-line interface (CLI) for pdfcraft.
Supports info, split, extract, move, insert, delete, reorder, and text extraction.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if callable(_reconfigure):
        _reconfigure(encoding="utf-8")

from .core import (
    DocumentInfo,
    PdfDocument,
    compress_pdf,
    decrypt_pdf,
    encrypt_pdf,
    merge_pdfs,
)
from .office import convert_office_to_pdf


def format_bytes(size: int) -> str:
    """Format file size in human-readable units."""
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.2f} KB"
    else:
        return f"{size / (1024 * 1024):.2f} MB"


def handle_info(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input, password=args.password)
        info: DocumentInfo = doc.get_info()

        print("=" * 60)
        print(f" THÔNG TIN TÀI LIỆU PDF: {Path(info.file_path).name}")
        print("=" * 60)
        print(f"  - Đường dẫn đầy đủ: {info.file_path}")
        print(f"  - Kích thước tệp:   {format_bytes(info.file_size_bytes)}")
        print(f"  - Tổng số trang:    {info.page_count}")

        if info.metadata:
            print("\n  [Metadata]")
            for k, v in info.metadata.items():
                if v:
                    print(f"    • {k}: {v}")

        print("\n  [Danh sách các trang]")
        print(f"  {'Trang':<8} {'Kích thước (pt)':<24} {'Góc xoay':<10}")
        print("  " + "-" * 44)
        for p in info.pages:
            dim_str = f"{p.width} x {p.height}"
            rot_str = f"{p.rotation}°"
            print(f"  {p.page_number:<8} {dim_str:<24} {rot_str:<10}")

        print("=" * 60)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_split(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_dir = (
            Path(args.output_dir)
            if args.output_dir
            else Path(args.input).parent / f"{Path(args.input).stem}_split"
        )
        pattern = args.pattern or "page_{index}.pdf"

        print(
            f"[*] Đang tách {doc.page_count} trang từ '{Path(args.input).name}' vào thư mục '{out_dir}'..."
        )
        created = doc.split_all(output_dir=out_dir, pattern=pattern)

        print(f"[+] Thành công! Đã tạo {len(created)} tệp PDF:")
        for f in created:
            print(f"    • {f.name}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_extract(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_path = args.output
        if not out_path:
            out_path = f"{Path(args.input).stem}_extracted.pdf"

        print(
            f"[*] Đang trích xuất các trang [{args.pages}] từ '{Path(args.input).name}'..."
        )
        saved = doc.extract_pages(pages=args.pages, output_path=out_path)
        print(f"[+] Thành công! Đã lưu tệp trích xuất tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_move(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_path = args.output or args.input

        print(f"[*] Đang di chuyển trang {args.from_page} tới vị trí {args.to_page}...")
        doc.move_page(from_page=args.from_page, to_page=args.to_page)
        saved = doc.save(out_path)
        print(f"[+] Thành công! Đã lưu tệp tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_reorder(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_path = args.output or args.input
        order_list = [int(x.strip()) for x in args.order.split(",") if x.strip()]

        print(f"[*] Đang sắp xếp lại thứ tự trang theo: {order_list}...")
        doc.reorder_pages(order_list)
        saved = doc.save(out_path)
        print(f"[+] Thành công! Đã lưu tệp tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_insert(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_path = args.output or args.input
        at_pos = args.at if args.at is not None else (doc.page_count + 1)

        src_info = f"nguồn '{Path(args.source).name}'"
        if args.pages:
            src_info += f" (các trang: {args.pages})"

        print(
            f"[*] Đang chèn từ {src_info} vào vị trí {at_pos} của '{Path(args.input).name}'..."
        )
        doc.insert_from_file(
            source_path=args.source,
            at_position=at_pos,
            source_pages=args.pages,
        )
        saved = doc.save(out_path)
        print(
            f"[+] Thành công! Tổng số trang hiện tại: {doc.page_count}. Đã lưu tại: {saved}"
        )
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_delete(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_path = args.output or args.input

        print(
            f"[*] Đang xóa các trang [{args.pages}] khỏi '{Path(args.input).name}'..."
        )
        doc.delete_pages(args.pages)
        saved = doc.save(out_path)
        print(
            f"[+] Thành công! Tổng số trang còn lại: {doc.page_count}. Đã lưu tại: {saved}"
        )
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_rotate(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input)
        out_path = args.output or args.input

        print(
            f"[*] Đang xoay các trang [{args.pages}] một góc {args.angle}° trong '{Path(args.input).name}'..."
        )
        doc.rotate_pages(pages=args.pages, angle=args.angle)
        saved = doc.save(out_path)
        print(f"[+] Thành công! Đã lưu tệp tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_merge(args: argparse.Namespace) -> int:
    try:
        inputs = args.inputs or []
        if len(inputs) == 0:
            print("[LỖI] Cần ít nhất 1 tệp PDF đầu vào để gộp", file=sys.stderr)
            return 1

        print(
            f"[*] Đang gộp {len(inputs)} tệp PDF theo thứ tự: {[Path(p).name for p in inputs]}..."
        )
        saved = merge_pdfs(inputs, args.output)
        reader_check = PdfDocument.open(saved)
        print(
            f"[+] Thành công! Tổng số trang: {reader_check.page_count}. Đã lưu tại: {saved}"
        )
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_encrypt(args: argparse.Namespace) -> int:
    try:
        out_path = args.output or args.input
        print(f"[*] Đang mã hóa '{Path(args.input).name}' bằng mật khẩu...")
        saved = encrypt_pdf(args.input, out_path, args.user_pw, args.owner_pw)
        print(f"[+] Thành công! File đã mã hóa tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_decrypt(args: argparse.Namespace) -> int:
    try:
        out_path = args.output or args.input
        print(f"[*] Đang giải mã '{Path(args.input).name}'...")
        saved = decrypt_pdf(args.input, out_path, args.password)
        print(f"[+] Thành công! File đã giải mã tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_meta(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input, password=args.password)
        out_path = args.output or args.input
        doc.set_metadata(
            title=args.title,
            author=args.author,
            subject=args.subject,
            keywords=args.keywords,
            creator=args.creator,
        )
        saved = doc.save(out_path)
        print(f"[+] Thành công! Đã cập nhật metadata tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_watermark(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input, password=args.password)
        out_path = args.output or args.input
        target = args.pages or list(range(1, doc.page_count + 1))

        print(f"[*] Đang đóng dấu '{args.text}' lên '{Path(args.input).name}'...")
        doc.add_text_watermark(
            text=args.text,
            pages=target,
            font_size=args.font_size,
            rotation=args.rotation,
            opacity=args.opacity,
        )
        saved = doc.save(out_path)
        print(f"[+] Thành công! Đã lưu tệp tại: {saved}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_compress(args: argparse.Namespace) -> int:
    try:
        out_path = args.output or args.input
        before = Path(args.input).stat().st_size

        print(f"[*] Đang tối ưu không mất dữ liệu '{Path(args.input).name}'...")
        saved = compress_pdf(args.input, out_path)
        after = Path(saved).stat().st_size
        saved_pct = (1 - after / before) * 100 if before > 0 else 0
        print(
            f"[+] Thành công! {format_bytes(before)} -> {format_bytes(after)} (giảm {saved_pct:.1f}%). Lưu tại: {saved}"
        )
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_convert(args: argparse.Namespace) -> int:
    try:
        print(f"[*] Đang chuyển {len(args.inputs)} file Office sang PDF...")
        created = convert_office_to_pdf(
            args.inputs,
            output_dir=args.output_dir,
            engine=args.engine,
            timeout=args.timeout,
        )
        dest = f"'{args.output_dir}'" if args.output_dir else "cùng thư mục file gốc"
        print(f"[+] Thành công! Đã tạo {len(created)} file PDF vào {dest}:")
        for f in created:
            print(f"    • {f}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_text(args: argparse.Namespace) -> int:
    try:
        doc = PdfDocument.open(args.input, password=args.password)
        if args.page:
            text = doc.extract_text(page_num=args.page)
            print(f"--- [Trang {args.page}] ---")
            print(text)
        else:
            all_text = doc.extract_text()
            for p_num, content in all_text.items():
                print(f"--- [Trang {p_num}] ---")
                print(content)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1


def handle_ui(args: argparse.Namespace) -> int:
    import http.server
    import socketserver
    import threading
    import webbrowser

    port = args.port
    web_dir = Path(__file__).resolve().parent.parent.parent / "web"
    if not web_dir.exists():
        web_dir = Path(__file__).resolve().parent.parent / "web"

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(web_dir), **kw)

        def log_message(self, format, *a):
            pass

    url = f"http://127.0.0.1:{port}"
    print("=" * 60)
    print("  PDF Craft - Giao diện Web UI kéo thả (Drag & Drop)")
    print("=" * 60)
    print(f"  • Máy chủ đang chạy tại: {url}")
    print("  • Đang tự động mở trình duyệt...")
    print("  • Nhấn Ctrl+C trong terminal để dừng server.")
    print("=" * 60)

    threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        with socketserver.TCPServer(("127.0.0.1", port), QuietHandler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Đã dừng máy chủ Web UI.")
    except Exception as e:  # noqa: BLE001
        print(f"[LỖI] {e}", file=sys.stderr)
        return 1
    return 0


def handle_register_menu(args: argparse.Namespace) -> int:
    import subprocess

    if sys.platform != "win32":
        print("[LỖI] Đăng ký Menu chuột phải chỉ hỗ trợ Windows.", file=sys.stderr)
        return 1
    exe_path = Path(__file__).resolve().parent.parent.parent / "PDFCraft.exe"
    if exe_path.exists():
        return subprocess.call([str(exe_path), "register-menu"])
    print(f"[LỖI] Không tìm thấy tệp thực thi: {exe_path}", file=sys.stderr)
    return 1


def handle_unregister_menu(args: argparse.Namespace) -> int:
    import subprocess

    if sys.platform != "win32":
        print("[LỖI] Gỡ bỏ Menu chuột phải chỉ hỗ trợ Windows.", file=sys.stderr)
        return 1
    exe_path = Path(__file__).resolve().parent.parent.parent / "PDFCraft.exe"
    if exe_path.exists():
        return subprocess.call([str(exe_path), "unregister-menu"])
    print(f"[LỖI] Không tìm thấy tệp thực thi: {exe_path}", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pdfcraft",
        description="pdfcraft - Công cụ xử lý PDF mạnh mẽ: đọc thông tin, tách trang, di chuyển trang, xoay trang, gộp file, chèn trang từ tệp, xóa trang.",
    )
    subparsers = parser.add_subparsers(dest="command", help="Lệnh thao tác PDF")

    # register-menu & unregister-menu
    subparsers.add_parser(
        "register-menu",
        help="Đăng ký 'Open with PDF Craft' vào Menu chuột phải Windows",
    )
    subparsers.add_parser(
        "unregister-menu",
        help="Gỡ bỏ 'Open with PDF Craft' khỏi Menu chuột phải Windows",
    )

    # ui
    p_ui = subparsers.add_parser(
        "ui", help="Khởi chạy Giao diện Web UI kéo thả mượt mà"
    )
    p_ui.add_argument(
        "-p", "--port", type=int, default=8080, help="Cổng chạy server (mặc định: 8080)"
    )

    # info
    p_info = subparsers.add_parser(
        "info", help="Xem thông tin chi tiết, metadata và danh sách trang của file PDF"
    )
    p_info.add_argument("input", help="Đường dẫn file PDF cần đọc")
    p_info.add_argument("--password", help="Mật khẩu mở file (nếu file mã hóa)")

    # split
    p_split = subparsers.add_parser(
        "split", help="Tách từng trang của file PDF thành các file riêng biệt"
    )
    p_split.add_argument("input", help="Đường dẫn file PDF cần tách")
    p_split.add_argument("-d", "--output-dir", help="Thư mục lưu các file đã tách")
    p_split.add_argument(
        "-p",
        "--pattern",
        default="page_{index}.pdf",
        help="Định dạng tên file (mặc định: page_{index}.pdf)",
    )

    # extract
    p_extract = subparsers.add_parser(
        "extract", help="Trích xuất các trang chỉ định ra một file PDF mới"
    )
    p_extract.add_argument("input", help="Đường dẫn file PDF gốc")
    p_extract.add_argument(
        "--pages", required=True, help="Dải trang cần trích xuất (ví dụ: '1,3,5-7')"
    )
    p_extract.add_argument(
        "-o", "--output", required=True, help="Đường dẫn file PDF kết quả"
    )

    # move
    p_move = subparsers.add_parser(
        "move", help="Di chuyển trang từ vị trí này sang vị trí khác"
    )
    p_move.add_argument("input", help="Đường dẫn file PDF")
    p_move.add_argument(
        "--from-page", type=int, required=True, help="Số trang cần di chuyển (1-based)"
    )
    p_move.add_argument(
        "--to-page",
        type=int,
        required=True,
        help="Vị trí đích cần chuyển tới (1-based)",
    )
    p_move.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # reorder
    p_reorder = subparsers.add_parser(
        "reorder", help="Sắp xếp lại toàn bộ thứ tự trang theo hoán vị chỉ định"
    )
    p_reorder.add_argument("input", help="Đường dẫn file PDF")
    p_reorder.add_argument(
        "--order", required=True, help="Danh sách thứ tự trang mới, ví dụ: '3,1,2,4'"
    )
    p_reorder.add_argument("-o", "--output", help="Đường dẫn file kết quả")

    # insert
    p_insert = subparsers.add_parser(
        "insert", help="Thêm trang từ một file PDF khác vào vị trí chỉ định"
    )
    p_insert.add_argument("input", help="Đường dẫn file PDF đích")
    p_insert.add_argument(
        "-s",
        "--source",
        required=True,
        help="Đường dẫn file PDF nguồn chứa trang cần chèn",
    )
    p_insert.add_argument(
        "--at",
        type=int,
        default=None,
        help="Vị trí chèn (1-based, mặc định: chèn vào cuối tài liệu)",
    )
    p_insert.add_argument(
        "--pages", help="Các trang cần chèn từ file nguồn (mặc định: chèn tất cả)"
    )
    p_insert.add_argument("-o", "--output", help="Đường dẫn file kết quả")

    # delete
    p_delete = subparsers.add_parser(
        "delete", help="Xóa một hoặc nhiều trang khỏi file PDF"
    )
    p_delete.add_argument("input", help="Đường dẫn file PDF")
    p_delete.add_argument(
        "--pages", required=True, help="Các trang cần xóa (ví dụ: '2' hoặc '1,3-4')"
    )
    p_delete.add_argument("-o", "--output", help="Đường dẫn file kết quả")

    # rotate
    p_rotate = subparsers.add_parser(
        "rotate", help="Xoay các trang chỉ định theo góc là bội số của 90 độ"
    )
    p_rotate.add_argument("input", help="Đường dẫn file PDF")
    p_rotate.add_argument(
        "--pages", required=True, help="Các trang cần xoay (ví dụ: '1' hoặc '1,3-4')"
    )
    p_rotate.add_argument(
        "--angle",
        type=int,
        required=True,
        help="Góc xoay theo chiều kim đồng hồ: 90, 180, 270 (hoặc -90, -180)",
    )
    p_rotate.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # merge
    p_merge = subparsers.add_parser(
        "merge", help="Gộp nhiều file PDF thành một file duy nhất theo đúng thứ tự"
    )
    p_merge.add_argument(
        "inputs", nargs="+", help="Danh sách file PDF đầu vào theo thứ tự gộp"
    )
    p_merge.add_argument(
        "-o", "--output", required=True, help="Đường dẫn file PDF kết quả sau khi gộp"
    )

    # encrypt
    p_encrypt = subparsers.add_parser(
        "encrypt", help="Mã hóa file PDF bằng mật khẩu (cần mật khẩu mới mở được)"
    )
    p_encrypt.add_argument("input", help="Đường dẫn file PDF")
    p_encrypt.add_argument(
        "--user-pw", required=True, help="Mật khẩu người dùng (bắt buộc để mở file)"
    )
    p_encrypt.add_argument(
        "--owner-pw", help="Mật khẩu chủ sở hữu toàn quyền (mặc định: giống user-pw)"
    )
    p_encrypt.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # decrypt
    p_decrypt = subparsers.add_parser(
        "decrypt", help="Giải mã file PDF đã mã hóa và lưu bản không mật khẩu"
    )
    p_decrypt.add_argument("input", help="Đường dẫn file PDF đã mã hóa")
    p_decrypt.add_argument("--password", required=True, help="Mật khẩu mở file")
    p_decrypt.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # meta
    p_meta = subparsers.add_parser(
        "meta", help="Xem/sửa metadata (tiêu đề, tác giả, chủ đề...) của file PDF"
    )
    p_meta.add_argument("input", help="Đường dẫn file PDF")
    p_meta.add_argument("--title", help="Tiêu đề tài liệu")
    p_meta.add_argument("--author", help="Tác giả")
    p_meta.add_argument("--subject", help="Chủ đề")
    p_meta.add_argument("--keywords", help="Từ khóa")
    p_meta.add_argument("--creator", help="Ứng dụng tạo file")
    p_meta.add_argument("--password", help="Mật khẩu mở file (nếu file mã hóa)")
    p_meta.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # watermark
    p_wm = subparsers.add_parser(
        "watermark", help="Đóng dấu chìm chữ (DRAFT, BẢN NHÁP...) lên các trang"
    )
    p_wm.add_argument("input", help="Đường dẫn file PDF")
    p_wm.add_argument(
        "--text", required=True, help="Nội dung dấu (khuyên dùng chữ Latin không dấu)"
    )
    p_wm.add_argument("--pages", help="Các trang cần đóng dấu (mặc định: tất cả)")
    p_wm.add_argument("--font-size", type=int, default=48, help="Cỡ chữ (mặc định: 48)")
    p_wm.add_argument(
        "--rotation", type=float, default=45, help="Góc xoay độ (mặc định: 45)"
    )
    p_wm.add_argument(
        "--opacity", type=float, default=0.3, help="Độ đậm 0..1 (mặc định: 0.3)"
    )
    p_wm.add_argument("--password", help="Mật khẩu mở file (nếu file mã hóa)")
    p_wm.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # compress
    p_compress = subparsers.add_parser(
        "compress", help="Tối ưu giảm dung lượng không mất dữ liệu (lossless)"
    )
    p_compress.add_argument("input", help="Đường dẫn file PDF")
    p_compress.add_argument(
        "-o",
        "--output",
        help="Đường dẫn file kết quả (nếu không chỉ định sẽ ghi đè file gốc)",
    )

    # convert
    p_convert = subparsers.add_parser(
        "convert", help="Chuyển hàng loạt file Word/Excel sang PDF (cần LibreOffice)"
    )
    p_convert.add_argument(
        "inputs", nargs="+", help="Danh sách file Office (docx, xlsx, ...)"
    )
    p_convert.add_argument(
        "-d",
        "--output-dir",
        help="Thư mục chứa PDF kết quả (mặc định: cùng thư mục file gốc)",
    )
    p_convert.add_argument(
        "--engine", help="Đường dẫn soffice (mặc định: tự tìm LibreOffice)"
    )
    p_convert.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="Thời gian chờ tối đa mỗi lượt (giây, mặc định: 180)",
    )

    # text
    p_text = subparsers.add_parser(
        "text", help="Đọc và trích xuất nội dung văn bản từ các trang"
    )
    p_text.add_argument("input", help="Đường dẫn file PDF")
    p_text.add_argument(
        "--page", type=int, help="Chỉ định trang cần trích xuất văn bản (1-based)"
    )
    p_text.add_argument("--password", help="Mật khẩu mở file (nếu file mã hóa)")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 1

    handlers = {
        "info": handle_info,
        "split": handle_split,
        "extract": handle_extract,
        "move": handle_move,
        "reorder": handle_reorder,
        "insert": handle_insert,
        "delete": handle_delete,
        "rotate": handle_rotate,
        "merge": handle_merge,
        "encrypt": handle_encrypt,
        "decrypt": handle_decrypt,
        "meta": handle_meta,
        "watermark": handle_watermark,
        "compress": handle_compress,
        "convert": handle_convert,
        "text": handle_text,
        "ui": handle_ui,
        "register-menu": handle_register_menu,
        "unregister-menu": handle_unregister_menu,
    }

    handler = handlers.get(args.command)
    if handler:
        return handler(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
