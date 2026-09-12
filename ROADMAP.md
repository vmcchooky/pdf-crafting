# PDF Craft - Lộ trình tính năng mới (New Features Roadmap)

> File ghi nhớ các tính năng dự kiến phát triển sau v1.1.0.
> Quy ước: mỗi tính năng khi làm phải đồng bộ 3 nơi **Python (`python/pdfcraft/`)** + **Go (`go/pkg/pdfcraft/` + CLI)** + **Web UI (`web/`)** nếu phù hợp, kèm test (pytest / go test / node --test / Playwright).

## ✅ Đang làm đầu tiên (ưu tiên cao nhất)

### 1. Chuyển Office sang PDF hàng loạt (`convert`) — ĐANG TRIỂN KHAI
- **Mô tả**: `pdfcraft convert a.docx b.xlsx -d ./pdf_out/` chuyển hàng loạt Word/Excel (và họ hàng: doc, xls, odt, ods, ppt...) sang PDF, giữ nguyên tên file.
- **Engine**: LibreOffice headless (`soffice --convert-to pdf`) nếu có; fallback MS Word COM trên Windows; báo lỗi rõ ràng khi thiếu engine.
- **Phạm vi**: Python `convert_office_to_pdf()` + CLI `convert`, Go `ConvertOfficeToPdf()` + CLI `convert`, test mock engine.
- **Chưa làm**: nút "Chuyển Office sang PDF" trong Web UI (cần backend upload → convert → trả file, để pha sau).

## 📋 Hàng đợi tính năng (chưa lên lịch chi tiết)

### 2. Mở file PDF mã hóa ngay trong Web UI
- Hiện tại chỉ CLI đọc được (`--password`). Web cần hộp nhập mật khẩu khi nạp file mã hóa (pdf.js hỗ trợ `password` trong `getDocument`).

### 3. OCR cho file scan (scan → searchable text)
- File scan hiện là điểm mù của tìm kiếm + `text`. Tích hợp Tesseract OCR (qua CLI ngoài) hoặc dịch vụ OCR, nhúng text layer vào PDF.
- Liên quan: benchmark scan đã có (`benchmark.py` mục [4]) để đo hiệu quả.

### 4. Bookmark / Outline (mục lục) editor
- Đọc, thêm, sửa, xóa bookmark; giữ bookmark khi merge/extract (hiện pdfcpu giữ một phần, cần kiểm chứng).

### 5. Chuẩn hóa khổ giấy & resize trang
- Resize/normalize toàn bộ trang về A4/A5/Letter, căn giữa nội dung, thêm lề trắng.

### 6. Redact (che/bôi đen văn bản vĩnh viễn)
- Tìm text (tái dùng search engine) → phủ đen + xóa text gốc khỏi content stream.

### 7. Linearize / Web-optimized (Fast Web View)
- Xuất PDF linearized để xem trực tuyến nhanh (`pdfcpu` hỗ trợ linearize khi ghi).

### 8. Tách theo kích thước / bookmark (`split-by-size`, `split-by-bookmark`)
- Chia file lớn thành nhiều file con theo dung lượng hoặc theo mục lục.

### 9. So sánh 2 file PDF (`diff`)
- So text từng trang, báo cáo trang khác nhau (hỗ trợ kiểm tra hợp đồng).

### 10. Chữ ký số chuẩn (PAdES) — khác với "Ký & Đóng dấu" ảnh hiện tại
- Ký số bằng chứng thư số (certificate), xác thực được trong Adobe Reader.

### 11. Form (AcroForm) fill từ CSV/JSON
- Điền hàng loạt biểu mẫu PDF từ dữ liệu có cấu trúc.

### 12. Nút Office→PDF trong Web UI
- Upload docx/xlsx → backend convert (tái dùng engine của mục 1) → nạp tiếp vào workspace.
