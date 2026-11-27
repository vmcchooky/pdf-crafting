# Chặng 2 — Độ tin cậy & tốc độ lõi: thiết kế triển khai

Ngày: 2026-11-27. Nhánh: `stage2-reliability` (tách từ `docs/engineering-roadmap`).
Bối cảnh: roadmap kỹ thuật `ENGINEERING-ROADMAP.md` (Chặng 2) + phát hiện thực tế khi chạy test trên branch roadmap.

## Mục tiêu

1. Không bao giờ hỏng file vì ghi dở / lỗi giữa chừng.
2. Đầu ra PDF được kiểm chứng độc lập (qpdf) và không crash với file khó.
3. Tốc độ có số đo tái lập được; không tụt theo thời gian.
4. Xử lý hàng loạt song song có giới hạn, chỉ giữ nếu số đo chứng minh có lợi.
5. Kết luận rõ ràng (làm/không làm) cho incremental save.

## Không làm

- Tính năng mới ngoài roadmap (OCR, redact, resize…), thay đổi Web UI, ký số, winget.
- Thêm dependency Go mới (kể cả x/sys).

## Hạng mục & tiêu chí hoàn thành

### 1. Sửa lỗi convert Office (thông điệp + fallback)

Hiện trạng: `msOfficeAvailable()` chỉ kiểm tra PowerShell → trên Windows luôn true. Máy không có Office chạy được sẽ nhận lỗi kỹ thuật "RPC server is unavailable" thay vì hướng dẫn; test `TestConvertOfficeErrors` fail trên máy có PowerShell nhưng không có Office dùng được.

Thay đổi:
- Mọi lỗi COM trong `convertBatchMSOffice` trả thông điệp kèm hướng dẫn: cài LibreOffice (link) hoặc kiểm tra bộ Office (Word/Excel/PowerPoint) đã cài đủ.
- Tách hàm dựng thông điệp thuần (pure) để test tất định, không phụ thuộc máy.
- Giữ nguyên cơ chế phát hiện hiện tại (không thêm dependency).

Tiêu chí: `TestConvertOfficeErrors` xanh trên Windows (có/không Office) lẫn Linux; test mới cho hàm thông điệp.

### 2. Ghi nguyên tử — vá fallback

Hiện trạng: `saveSafely` khi `os.Rename` lỗi sẽ `os.Remove(absOut)` rồi rename lần nữa; nếu vẫn lỗi thì `copyFile` ghi trực tiếp lên đích → có cửa sổ mất dữ liệu, phá nguyên tắc "lỗi giữa chừng không đụng file gốc".

Thay đổi:
- Bỏ nhánh xóa đích trước rename.
- Fallback: copy temp → temp phụ cùng thư mục đích → `os.Rename(tempPhụ, đích)`; nếu vẫn lỗi, trả lỗi và giữ nguyên file gốc.
- Test: writer lỗi → file đích cũ không đổi, không còn file tạm; input == output cũng giữ nguyên.

Tiêu chí: test mới xanh; toàn bộ `go test ./...` xanh.

### 3. Corpus hồi quy + qpdf

- `corpus_test.go` sinh tại `t.TempDir()`: PDF hợp lệ, mã hóa AES-256, xref hỏng, file cắt cụt, scan 1 trang ảnh (ImportImagesFile + PNG stdlib), trang xoay, watermark tiếng Việt.
- Chạy info/extract/split/compress/rotate/watermark: không panic; lỗi phải có kiểm soát; output hợp lệ theo `api.ValidateFile`.
- Khi đặt `PDFCRAFT_QPDF_OUTDIR`: test ghi toàn bộ output vào thư mục đó để CI chạy `qpdf --check`.

Tiêu chí: test chạy < ~15 s; CI job qpdf xanh trên `examples/*.pdf` + output corpus.

### 4. Benchmark

- Bổ sung benchmark Go: Info, Extract, Split, Compress, Merge, Watermark (50 trang) + file scan ảnh.
- CI job `bench` **non-blocking** (`continue-on-error`): build binary từ `origin/main` và từ HEAD, đo vi sai trong cùng job (xen kẽ, min-of-N), cảnh báo vàng nếu chậm hơn >20%.
- Script đo: `scripts/bench_compare.py` (chỉ stdlib), sinh fixture 50 trang + scan bằng zlib.

Tiêu chí: job chạy được, không chặn merge; số đo được ghi vào roadmap.

### 5. Xử lý hàng loạt song song

- `compress` và `split` nhận nhiều file đầu vào + `-d <thư_mục>`; một file giữ nguyên hành vi hiện tại.
- Quy ước đích khi batch: `compress` → `<thư_mục>/<base>.pdf`; `split` → `<thư_mục>/<base>_split/` (mỗi nguồn một thư mục con, tránh trùng tên).
- `merge` không song song: nhiều đầu vào nhưng một đầu ra, không có việc độc lập để chạy song song — ghi lý do vào roadmap.
- Worker pool `min(GOMAXPROCS, 4)`; tổng hợp lỗi, exit code 1 nếu có file lỗi; thứ tự thông báo theo index.
- Đo trước/sau trên máy thật (10 file). Nếu chậm hơn trên máy ít nhân → ghi nhận như tiền lệ split và hạ/huỷ mặc định song song.

Tiêu chí: test đơn vị cho batch (thứ tự, lỗi một phần, tên file); số đo ghi vào roadmap.

### 6. Spike incremental save

- Timebox 1 buổi: rà API pdfcpu cho append/incremental.
- Không hỗ trợ → kết luận "không làm" kèm bằng chứng (file/API), ghi vào `ENGINEERING-ROADMAP.md`. Không tự viết cơ chế append.

### 7. CI & tài liệu

- `ci.yml`: xóa job `python` (đường dẫn `python/` đã move → đỏ); thêm bước cross-build `GOOS=windows` cho amd64/arm64; thêm job `qpdf`; thêm job `bench` non-blocking.
- `ENGINEERING-ROADMAP.md`: đánh dấu Chặng 2 theo kết quả thật + số đo; ghi rõ mục nào hoãn/không làm và lý do.

## Xác minh

- Local (Windows): `gofmt -l`, `go vet ./...`, `go test ./...`, `go build`.
- qpdf không có trên máy local → kiểm chứng bằng pdfcpu tại chỗ; qpdf chạy trong CI (trung thực: không tuyên bố đã chạy local).
- CI xanh sau khi push (push/PR cần người dùng duyệt riêng).

## Rủi ro

- Runner CI nhiễu → benchmark vi sai + non-blocking, ngưỡng 20%.
- Corpus tổng hợp không đại diện đủ → bổ sung dần; không chặn phạm vi lần này.
- Batch song song vô ích trên máy ít nhân → đo và ghi lại, không giữ nếu không có lợi.
