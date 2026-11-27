# PDF Craft (Bộ công cụ xử lý PDF tối ưu: Python & Go Native)

Một công cụ chuyên dụng, tốc độ cao cho phép thao tác các tệp PDF dễ dàng:
- **Đọc thông tin** tệp PDF: số trang, kích thước, góc xoay, metadata, trích xuất text (`info`, `text` — hỗ trợ file mã hóa qua `--password`).
- **Tách tệp PDF** thành các trang đơn lẻ (`split`) hoặc trích xuất các trang chỉ định (`extract`).
- **Di chuyển trang** tùy ý từ vị trí A tới vị trí B (`move`).
- **Đổi thứ tự trang** theo hoán vị bất kỳ (`reorder`).
- **Gộp nhiều file PDF** theo đúng thứ tự (`merge`).
- **Xoay trang** theo bội số 90 độ (`rotate`).
- **Thêm trang từ tệp khác** vào vị trí chỉ định (`insert`).
- **Xóa trang** khỏi tệp PDF (`delete`).
- **Mã hóa / giải mã** bằng mật khẩu (`encrypt`, `decrypt` — tương thích chéo Python ↔ Go).
- **Mục lục bookmark**: xem/sửa (`bookmark` list/add/clear/export/import JSON, giữ nguyên khi gộp file), xem trong Web UI.
- **Sửa metadata** Tiêu đề/Tác giả/Chủ đề... (`meta`, qua Web UI).
- **Đóng dấu chìm chữ** DRAFT/BẢN NHÁP... (`watermark`).
- **Tối ưu giảm dung lượng** không mất dữ liệu (`compress`).
- **Chuyển Office sang PDF hàng loạt** (`convert` a.docx b.xlsx — cần LibreOffice).
- **Menu chuột phải Windows**: mở bằng PDF Craft, gộp nhiều file, nén nhanh.
- **Web UI trực quan**: kéo thả đổi thứ tự, Undo/Redo, tìm kiếm text không dấu, nhóm trang, ký & đóng dấu, nén ảnh, lưu/tải project (`.pdfcraft.json`).

Lộ trình tính năng mới xem thêm `ROADMAP.md`.

Công cụ được xây dựng và kiểm thử hoàn chỉnh bằng **Python** (`pip install .`), đồng thời đã được refactor và biên dịch sang **Go Native** (`pdfcraft.exe`) đem lại tốc độ vượt trội, thời gian khởi động tức thì và chạy độc lập 100% không cần cài thêm runtime.

---

## 🚀 Cấu trúc dự án

```
pdf-crafting/
├── pdfcraft.exe              # Artifact phát hành (tải từ GitHub Releases, không commit; build từ Go, xem dưới)
├── pyproject.toml            # Đóng gói Python (pip install .)
├── .github/workflows/ci.yml  # CI: pytest + go test + node --test
├── examples/                 # Tệp PDF mẫu để dùng thử
├── python/                   # Bản cài đặt và thư viện Python
│   ├── pdfcraft/             # Package lõi: PdfDocument & CLI
│   │   ├── __init__.py
│   │   ├── core.py           # Core logic (đọc, tách, gộp, xoay, merge, mã hóa, metadata, watermark, nén)
│   │   ├── office.py         # Chuyển Office sang PDF hàng loạt (LibreOffice headless)
│   │   ├── cli.py            # Giao diện dòng lệnh Python (17 lệnh)
│   │   └── __main__.py       # Entry point cho `python -m pdfcraft` / lệnh `pdfcraft`
│   └── tests/                # Bộ test tự động bằng pytest
├── go/                       # Bản refactor Go (pdfcpu engine + ledongthuc/pdf cho text)
│   ├── go.mod
│   ├── cmd/pdfcraft/         # CLI Go (17 lệnh) + server Web UI (initial-file, context-menu, /api/optimize, /api/convert)
│   └── pkg/pdfcraft/         # Thư viện Go & bộ unit test Go (document.go, office.go)
├── web/                      # Giao diện Web UI kéo thả (100% offline)
│   ├── index.html
│   ├── app.js                # Ứng dụng chính (sắp xếp, nhóm, ký, nén, tìm kiếm, project)
│   ├── utils.js              # Hàm thuần túy dùng chung (có test Node)
│   ├── tests/utils.test.js   # Test Node: node --test web/tests/utils.test.js
│   ├── e2e/pdfcraft.spec.js  # Test E2E Playwright (5 kịch bản, Chromium)
│   ├── package.json          # npm scripts cho E2E (riêng thư mục web/)
│   └── vendor/               # pdf.js + pdf-lib nội bộ
├── benchmark.py              # Script so sánh hiệu năng Python vs Go (gồm file scan)
├── ROADMAP.md                # Lộ trình tính năng mới
└── README.md
```

---

## ⚡ Cách 1: Sử dụng tệp thực thi Go (`pdfcraft.exe`) - Khuyên dùng

Bạn có thể chạy trực tiếp `pdfcraft.exe` trên terminal/PowerShell mà không cần cài Python hay bất kỳ thư viện nào:

### Đọc thông tin & text (`info`, `text`)
```bash
.\pdfcraft.exe info examples/sample_doc.pdf
.\pdfcraft.exe info encrypted.pdf --password secret123
.\pdfcraft.exe text examples/sample_doc.pdf --page 1
```

### Tách / trích xuất (`split`, `extract`)
```bash
.\pdfcraft.exe split examples/sample_doc.pdf -d ./pages_output
.\pdfcraft.exe extract examples/sample_doc.pdf -pages 1,3,5 -o extracted.pdf
.\pdfcraft.exe extract examples/sample_doc.pdf -pages 2-4 -o extracted_range.pdf
```

### Sắp xếp trang (`move`, `reorder`, `rotate`)
```bash
.\pdfcraft.exe move examples/sample_doc.pdf -from 4 -to 1 -o moved.pdf
.\pdfcraft.exe reorder examples/sample_doc.pdf -order 5,4,3,2,1 -o reversed.pdf
.\pdfcraft.exe rotate examples/sample_doc.pdf -pages 1,3 -angle 90 -o rotated.pdf
```

### Gộp / chèn / xóa (`merge`, `insert`, `delete`)
```bash
.\pdfcraft.exe merge a.pdf b.pdf c.pdf -o merged.pdf
.\pdfcraft.exe insert examples/sample_doc.pdf -source examples/sample_insert.pdf -at 2 -o inserted.pdf
.\pdfcraft.exe delete examples/sample_doc.pdf -pages 2,4 -o deleted.pdf
```

### Bảo mật & metadata & watermark & nén
```bash
.\pdfcraft.exe encrypt doc.pdf --user-pw secret123 -o doc_enc.pdf
.\pdfcraft.exe decrypt doc_enc.pdf --password secret123 -o doc.pdf
.\pdfcraft.exe meta doc.pdf --title "Bao cao Q3" --author "PDF Craft" -o doc_meta.pdf
.\pdfcraft.exe bookmark doc.pdf
.\pdfcraft.exe bookmark doc.pdf --add "Ket luan" --page 5 -o doc_bm.pdf
.\pdfcraft.exe watermark doc.pdf --text "DRAFT" --pages 1-2 --font-size 48 --rotation 45 --opacity 0.3 -o doc_wm.pdf
.\pdfcraft.exe compress doc.pdf -o doc_small.pdf
```
*Lưu ý: watermark dùng font Helvetica built-in nên chữ có dấu tiếng Việt có thể không hiển thị đúng. File mã hóa cần `decrypt` trước khi `meta`/`watermark`/`compress`.*

### Chuyển Office sang PDF (`convert`, cần LibreOffice)
```bash
.\pdfcraft.exe convert a.docx b.xlsx -d ./pdf_out/
.\pdfcraft.exe convert *.docx --engine "C:\Program Files\LibreOffice\program\soffice.exe"
```

### Web UI & tích hợp Windows
```bash
.\pdfcraft.exe ui                    # mở giao diện kéo thả
.\pdfcraft.exe open invoice.pdf       # mở UI + nạp sẵn file
.\pdfcraft.exe register-menu          # thêm 3 mục PDF Craft vào chuột phải:
                                      # Open with / Gộp PDF / Nén nhanh
```
*Chuột phải nhiều file PDF → "Gộp PDF với PDF Craft" (1 lần, ra `*_merged.pdf`); chuột phải 1 file → "Nén nhanh" (ra `*_small.pdf`, giữ file gốc).*

*Không truyền lệnh (double-click exe) sẽ tự mở Web UI.*

---

## 🐍 Cách 2: Sử dụng qua Python

### Cài đặt:
```bash
pip install .
# hoặc dùng trực tiếp: $env:PYTHONPATH="python"; python -m pdfcraft ...
```

### Dòng lệnh (đủ 17 lệnh, cú pháp tương đương bản Go):
```bash
python -m pdfcraft info examples/sample_doc.pdf [--password ...]
python -m pdfcraft text examples/sample_doc.pdf --page 1
python -m pdfcraft split examples/sample_doc.pdf -d ./split_py
python -m pdfcraft extract examples/sample_doc.pdf --pages 1,3,5 -o ext_py.pdf
python -m pdfcraft move examples/sample_doc.pdf --from-page 4 --to-page 1 -o moved_py.pdf
python -m pdfcraft reorder examples/sample_doc.pdf --order 5,4,3,2,1 -o rev_py.pdf
python -m pdfcraft rotate examples/sample_doc.pdf --pages 1,3 --angle 90 -o rot_py.pdf
python -m pdfcraft merge a.pdf b.pdf -o merged_py.pdf
python -m pdfcraft insert examples/sample_doc.pdf -s examples/sample_insert.pdf --at 2 -o ins_py.pdf
python -m pdfcraft delete examples/sample_doc.pdf --pages 2,4 -o del_py.pdf
python -m pdfcraft encrypt doc.pdf --user-pw secret123 -o enc.pdf
python -m pdfcraft decrypt enc.pdf --password secret123 -o doc.pdf
python -m pdfcraft meta doc.pdf --title "Tieu de" --author "Toi" -o doc_meta.pdf
python -m pdfcraft bookmark doc.pdf --add "Ket luan" --page 5 -o doc_bm.pdf
python -m pdfcraft watermark doc.pdf --text "DRAFT" --pages 1-2 -o doc_wm.pdf
python -m pdfcraft compress doc.pdf -o doc_small.pdf
python -m pdfcraft convert a.docx b.xlsx -d ./pdf_out/
```

### Python API:
```python
from pdfcraft import PdfDocument, encrypt_pdf, decrypt_pdf, compress_pdf, merge_pdfs

doc = PdfDocument.open("examples/sample_doc.pdf")          # password="..." nếu file mã hóa
print(f"Tổng số trang: {doc.page_count}")

doc.move_page(from_page=4, to_page=1)
doc.rotate_pages("1,3", 90)
doc.insert_from_file("examples/sample_insert.pdf", at_position=2)
doc.delete_pages(3)
doc.set_metadata(title="Bao cao Q3", author="PDF Craft")
doc.add_text_watermark("DRAFT", pages="1-2")
print("Trang 1:", doc.extract_text(1))
doc.save("output_processed.pdf")                            # save(..., user_password="pw", optimize=True)

merge_pdfs(["a.pdf", "b.pdf"], "merged.pdf")
encrypt_pdf("doc.pdf", "enc.pdf", user_password="pw123")
decrypt_pdf("enc.pdf", "doc.pdf", password="pw123")
compress_pdf("doc.pdf", "small.pdf")

from pdfcraft import convert_office_to_pdf  # cần LibreOffice
convert_office_to_pdf(["a.docx", "b.xlsx"], output_dir="pdf_out/")
```

---

## 🖥️ Cách 3: Web UI kéo thả (`pdfcraft ui`)

- Kéo thả nhiều file, xem trước thumbnail, kéo đổi thứ tự, chọn nhiều (Shift+Click, khung marquee, Ctrl+A).
- Mở file PDF mã hóa: hộp nhập mật khẩu khi nạp file (thử lại khi sai, bỏ qua khi hủy). Lưu ý: xuất file từ nguồn mã hóa cần giải mã trước (`pdfcraft decrypt`).
- **Office → PDF**: nút chuyển file Word/Excel/PowerPoint sang PDF ngay trong Web UI (cần LibreOffice, 1 file nạp vào workspace, nhiều file tải về ZIP).
- Xoay từng trang / xoay hàng loạt đã chọn (phím `R`), đảo ngược, Undo (Ctrl+Z) / Redo (Ctrl+Y).
- **Tìm kiếm** nội dung toàn tài liệu, không phân biệt dấu (`/` để nhảy tới ô tìm kiếm).
- Nhóm trang + xuất theo nhóm, tách từng trang, trích xuất đã chọn.
- **Ký & đóng dấu**: thư viện dấu, gõ chữ ký nghệ thuật, dấu chức danh chuẩn VN.
- **Nén & xuất file**: DPI/quality + 14 tùy chọn nâng cao (backend `/api/optimize`).
- **Metadata**: nút Metadata sửa tiêu đề/tác giả áp dụng cho mọi file xuất.
- **Project**: Lưu project (`.pdfcraft.json` gồm cả file gốc, thứ tự, xoay, nhóm, dấu, metadata) để mở lại tiếp tục.

---

## 🧪 Kiểm thử tự động

| Suite | Lệnh | Phạm vi |
| :--- | :--- | :--- |
| Python (pytest, 34 tests) | `python -m pytest python/tests -q` | parse page, load/info, split, extract, move, reorder, rotate, merge, insert, delete, encrypt/decrypt, metadata, watermark, compress, convert (mock engine), save an toàn, CLI |
| Python gates | `ruff check`, `ruff format --check`, `mypy`, `pyright` | lint + format + type-check sạch |
| Go (`go test`) | `cd go; go test ./...` | parse, info, split, extract, move, reorder, rotate, merge, text, encrypt/decrypt, metadata, watermark, compress, convert (lỗi), concurrent |
| Web (Node, 13 tests) | `node --test web/tests/utils.test.js` | LRUCache, escapeHtml, formatBytes, chuẩn hóa dấu, tìm kiếm |
| Web E2E (Playwright, 5 tests) | `cd web; npm install; npx playwright install chromium; npx playwright test` | upload, xoay+undo/redo, tìm kiếm, xuất file, metadata |

CI (`.github/workflows/ci.yml`) chạy tất cả trên mỗi push/PR (gồm gates Python và E2E Chromium).

---

## 📊 So sánh hiệu năng: Python vs Go Native

Kết quả đo đạc thực tế trên Windows bằng `python benchmark.py` (tệp mẫu 50 trang):

| Tiêu chí so sánh | Python CLI (`pypdf`) | Go Native (`pdfcraft.exe`) | Mức độ cải thiện |
| :--- | :--- | :--- | :--- |
| **Độ trễ khởi động CLI (Startup + Info)** | 647.3 ms | **90.0 ms** | **Go nhanh gấp ~7.2 lần** ⚡ |
| **Trích xuất 20 trang (`extract`)** | 602 ms | **97 ms** | **Go nhanh gấp ~6.2 lần** ⚡ |
| **Tách 50 trang (`split`)** | 669 ms | **531 ms** | **Go nhanh hơn 26%** ⚡ |
| **Đọc info file scan 10tr (1.1 MB ảnh)** | 762.7 ms | **83.6 ms** | **Go nhanh gấp ~9.1 lần** ⚡ |
| **Nén lossless file scan (`compress`)** | 751 ms | **146 ms** | **Go nhanh gấp ~5.1 lần** ⚡ |
| **Mức tiêu thụ RAM** | ~50 - 80 MB | **~8 - 15 MB** | **Go tiết kiệm 5x RAM** 💾 |
| **Tính độc lập khi phân phối** | Cần cài Python + pip + lib | **1 file .exe duy nhất (~15 MB)** | Không cần cài đặt bất kỳ runtime nào 📦 |

---

## 🛠️ Biên dịch lại Go Executable (Tùy chọn)

Nếu bạn sửa mã nguồn Go và muốn biên dịch lại:
```bash
python scripts/sync_web.py
cd go
go build -ldflags="-s -w" -o ../PDFCraft.exe ./cmd/pdfcraft
```

> Nguồn thật của Web UI là `web/`. Exe nhúng từ `go/cmd/pdfcraft/web/` (embed,
> `//go:embed all:web` trong `go/cmd/pdfcraft/server.go`), nên bắt buộc chạy
> `python scripts/sync_web.py` trước khi build — CI (`web-sync`) và Release
> đều kiểm tra bước này và fail nếu 2 thư mục lệch nhau.
> File `PDFCraft.exe` không commit vào git; bản chính thức tải từ GitHub Releases
> (tag `v*` tự build + đính kèm exe).
