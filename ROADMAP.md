# PDF Craft - Lộ trình tính năng mới (New Features Roadmap)

> File ghi nhớ các tính năng dự kiến phát triển sau v1.1.0.
> Lộ trình kỹ thuật (hợp nhất về Go, phát hành plug-and-play): xem `ENGINEERING-ROADMAP.md` — quyết định ở đó thay đổi quy ước đồng bộ 3 nơi dưới đây sau khi Chặng 0 hoàn tất.
> Quy ước: mỗi tính năng khi làm phải đồng bộ **Go (`go/pkg/pdfcraft/` + CLI)** + **Web UI (`web/`)** nếu phù hợp, kèm test (go test / node --test / Playwright). *(Cập nhật 2026-11-27: bản Python đã đóng băng ở `legacy/python/` — không còn đồng bộ tính năng sang Python; xem `ENGINEERING-ROADMAP.md`.)*

## ✅ Đang làm đầu tiên (ưu tiên cao nhất)

### 1. Chuyển Office sang PDF hàng loạt (`convert`) — ĐANG TRIỂN KHAI
- **Mô tả**: `pdfcraft convert a.docx b.xlsx -d ./pdf_out/` chuyển hàng loạt Word/Excel (và họ hàng: doc, xls, odt, ods, ppt...) sang PDF, giữ nguyên tên file.
- **Engine**: LibreOffice headless (`soffice --convert-to pdf`) nếu có; fallback MS Word COM trên Windows; báo lỗi rõ ràng khi thiếu engine.
- **Phạm vi**: Python `convert_office_to_pdf()` + CLI `convert`, Go `ConvertOfficeToPdf()` + CLI `convert`, test mock engine.
- **Chưa làm**: nút "Chuyển Office sang PDF" trong Web UI (cần backend upload → convert → trả file, để pha sau).

## 📋 Hàng đợi tính năng (chưa lên lịch chi tiết)

### 2. Mở file PDF mã hóa ngay trong Web UI — ĐÃ XONG
- ~~Hiện tại chỉ CLI đọc được (`--password`).~~ Web đã có hộp nhập mật khẩu khi nạp file mã hóa (pdf.js `password` trong `getDocument`, thử lại khi sai, bỏ qua khi hủy) + E2E. Giới hạn: xuất file từ nguồn mã hóa cần `pdfcraft decrypt` trước (pdf-lib không giải mã).

### 3. OCR cho file scan (scan → searchable text)
- File scan hiện là điểm mù của tìm kiếm + `text`. Tích hợp Tesseract OCR (qua CLI ngoài) hoặc dịch vụ OCR, nhúng text layer vào PDF.
- Liên quan: benchmark scan đã có (`benchmark.py` mục [4]) để đo hiệu quả.

### 4. Bookmark / Outline (mục lục) editor — ĐÃ XONG
- Python (`get/set/add/clear_bookmarks`, `merge_pdfs` giữ bookmark + CLI `bookmark`) và Go (`List/Add/Clear/Export/Import` + CLI `bookmark`) đầy đủ; Go merge giữ bookmark sẵn (pdfcpu). Web UI xem mục lục + nhấp nhảy tới trang (pdf-lib không ghi outline nên thêm/sửa dùng CLI).

### 5. Chuẩn hóa khổ giấy & resize trang
- Resize/normalize toàn bộ trang về A4/A5/Letter, căn giữa nội dung, thêm lề trắng.

### 6. Redact (che/bôi đen văn bản vĩnh viễn)
- Tìm text (tái dùng search engine) → phủ đen + xóa text gốc khỏi content stream.

### 7. Linearize / Web-optimized (Fast Web View) — TẠM GÁC (không khả thi với dep hiện tại)
- Đã kiểm chứng 13/09/2026: `pdfcpu` (kể cả bản mới nhất v0.15.0) chỉ ĐỌC file linearized, không có API ghi (`xreftable.go`: "Linearization section (not yet supported)"); `pypdf` và `pdf-lib` (đã dùng `useObjectStreams`) cũng không ghi linearized. Ghi linearize thủ công quá rủi ro. Mở lại khi pdfcpu hỗ trợ ghi hoặc chấp nhận thêm dep ngoài (qpdf) — đi ngược tiêu chí nhẹ nên để cuối.

### 8. Tách theo kích thước / bookmark (`split-by-size`, `split-by-bookmark`)
- Chia file lớn thành nhiều file con theo dung lượng hoặc theo mục lục.

### 9. So sánh 2 file PDF (`diff`)
- So text từng trang, báo cáo trang khác nhau (hỗ trợ kiểm tra hợp đồng).

### 10. Chữ ký số chuẩn (PAdES) — khác với "Ký & Đóng dấu" ảnh hiện tại
- Ký số bằng chứng thư số (certificate), xác thực được trong Adobe Reader.

### 11. Form (AcroForm) fill từ CSV/JSON
- Điền hàng loạt biểu mẫu PDF từ dữ liệu có cấu trúc.

### 12. Nút Office→PDF trong Web UI — ĐÃ XONG
- ~~Upload docx/xlsx → backend convert (tái dùng engine của mục 1) → nạp tiếp vào workspace.~~ Đã có: nút "Office → PDF" upload 1–10 file → `POST /api/convert` (tái dùng `ConvertOfficeToPdf`, giới hạn 2 lượt đồng thời) → 1 file nạp thẳng vào workspace, nhiều file tải về ZIP. Thiếu LibreOffice báo lỗi rõ ràng + E2E đường lỗi.
