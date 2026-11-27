# Hướng dẫn dùng PDF Craft (bản tặng)

PDF Craft là công cụ xử lý PDF chạy thẳng trên Windows — **không cần cài đặt, không cần internet**, mọi thứ nằm trong đúng một tệp `.exe` (bản tải về tên `PDFCraft-windows-amd64.exe` hoặc `PDFCraft-windows-arm64.exe`; có thể đổi tên thành `PDFCraft.exe` cho gọn).

## Bắt đầu trong 30 giây

1. Chép tệp `.exe` vào bất cứ đâu trên máy (để ở Desktop là tiện nhất; đổi tên thành `PDFCraft.exe` nếu muốn).
2. **Nhấp đúp** vào tệp — giao diện sẽ tự mở trong trình duyệt.
3. Kéo thả tệp PDF vào cửa sổ là bắt đầu dùng được: gộp, tách, xoay, sắp xếp trang, nén, đóng dấu...

## Lần đầu chạy, Windows hiện cảnh báo xanh thì sao?

Vì đây là phần mềm tặng tay, chưa mua chứng thư ký số, Windows có thể hiện màn hình **"Windows protected your PC"** ở lần chạy đầu tiên. Cách qua, chỉ làm một lần:

1. Bấm **More info** (Thông tin thêm).
2. Bấm **Run anyway** (Vẫn chạy).

Từ lần sau Windows không hỏi nữa. Tệp do chính người tặng đưa, nên bước này an toàn.

## Mẹo dùng tiện hơn

- **Gắn vào menu chuột phải**: chạy lệnh `PDFCraft.exe register-menu` một lần — từ đó chuột phải lên tệp PDF sẽ có sẵn: *Mở bằng PDF Craft*, *Gộp PDF*, *Nén nhanh*.
- **Nén file scan nặng**: mở giao diện, dùng panel **Nén & Xuất file** (chọn DPI/chất lượng ảnh) — mạnh hơn lệnh `compress` thường.
- **Chữ ký & con dấu**: trong giao diện có thư viện dấu và dấu chức danh mẫu, kéo thả thẳng lên trang.
- **Đóng dấu chữ tiếng Việt** ("BẢN NHÁP", "ĐÃ DUYỆT"...): hiển thị đúng dấu — cứ gõ bình thường.

## Việc cần biết

- Máy cần **Windows 10 trở lên**. Hầu hết máy dùng bản `amd64`; chỉ máy Windows chạy chip ARM (rất hiếm, ví dụ Surface Pro X) mới cần bản `arm64`.
- Tính năng **chuyển Word/Excel sang PDF** dùng Microsoft Office có sẵn trên máy của bạn, hoặc LibreOffice (miễn phí) nếu không có MS Office — các tính năng PDF còn lại không cần gì thêm.
- PDF Craft **không gửi dữ liệu đi đâu cả**: không tài khoản, không theo dõi, xử lý 100% trên máy của bạn. Chương trình ghi ra tệp tạm cùng thư mục rồi mới thay thế, nên lỗi giữa chừng không làm hỏng tệp đang có. **Lưu ý:** các lệnh `compress`, `rotate`, `meta`, `move`, `reorder` mặc định ghi đè lên tệp gốc — dùng `-o <tệp_mới>` nếu muốn giữ bản gốc.

## Gặp trục trặc?

Cứ nhắn lại cho người đã tặng bạn công cụ này.
