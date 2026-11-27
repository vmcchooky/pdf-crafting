# PDF Craft — Lộ trình kỹ thuật: hợp nhất Go & phát hành plug-and-play

> Tài liệu này là lộ trình **kỹ thuật/nền tảng**, bổ sung cho `ROADMAP.md` (lộ trình tính năng).
> Quyết định nền: **hợp nhất về Go hoàn toàn** — không port sang Rust, không viết engine PDF riêng.
> Ngày chốt: 2026-11-27. Mọi con số dung lượng/tốc độ trong tài liệu này đều là số đo thật tại thời điểm chốt (xem Phụ lục A).

## Cập nhật 2026-11-27 (chiều) — tái định hướng: BẢN TẶNG + trạng thái triển khai đợt 1

**Mục đích sử dụng đã chốt: làm để đem tặng bạn bè, không phát hành đại trà.** Tiêu chí tối thượng theo thứ tự: (1) bạn bè cài dễ, mở là dùng; (2) nhẹ máy, ít hao tài nguyên; (3) mượt. Mọi đánh đổi kỹ thuật khác đều chấp nhận được.

Hệ quả lên các chặng:
- **Bỏ:** manifest winget (người nhận không dùng), ký số (thay bằng `HUONG-DAN.md` hướng dẫn qua SmartScreen 2 bước).
- **Hoãn vô thời hạn:** biến thể CLI-only, corpus hồi quy + benchmark CI có ngưỡng, xử lý song song đa nhân, fallback MS Office COM — đều là tối ưu cho khán giả đại trà hoặc chưa có nhu cầu thật.
- **Giữ và đã triển khai đợt 1 (27/11):**
  - [x] Module path Go: `github.com/user/pdfcraft` → `github.com/vmcchooky/pdf-crafting/go`.
  - [x] Ghi nguyên tử: kiểm chứng lại — `saveSafely` vốn đã phủ gần hết; đợt này bổ sung nốt `ExtractPages` và `SplitAll` → **100% đường ghi của bản Go** đi qua ghi tạm + hoán đổi.
  - [x] **Watermark tiếng Việt**: nhúng font subset PDFCraftSans (từ Noto Sans, OFL 1.1, **39 KB**) phủ Latin + tiếng Việt; tự chuyển font khi văn bản có ký tự ngoài WinAnsi, còn lại giữ Helvetica. Có test tự động (`watermark_vietnamese_test.go`).
  - [x] Release: build ma trận **amd64 + arm64** (`CGO_ENABLED=0`, `-trimpath`) + `SHA256SUMS.txt` kèm mỗi release.
  - [x] `HUONG-DAN.md`: hướng dẫn tặng kèm — mở lần đầu, qua SmartScreen, mẹo menu chuột phải.
  - [x] README: sửa dung lượng exe "~10 MB" → "~15 MB" theo số đo thật.
- **Còn lại của Chặng 0 (chưa làm, chủ đích):** di chuyển vật lý `python/` → `legacy/python/` — thay đổi mang tính hình thức nhưng phải sửa đồng bộ CI (5 tham chiếu), `pyproject.toml`, `pyrightconfig.json`, README; để làm riêng một đợt có kiểm chứng CI, tránh phá cây đang ổn định. Trạng thái "Python đóng băng" áp dụng ngay từ bây giờ dù thư mục chưa dời.
- `convert` khi thiếu LibreOffice: thông báo lỗi hiện tại đã rõ ràng và có hướng dẫn — giữ nguyên; đường COM qua MS Office để dành khi có nhu cầu thật từ người nhận.

## 0. Quyết định kiến trúc (đã chốt, không mở lại trừ khi có dữ kiện mới)

### 0.1. Vì sao Go, không phải Rust
- Workload của công cụ (tách/gộp/xoay/trích xuất/nén trang) bị nghẽn ở **giải nén zlib + I/O**, không nghẽn ở runtime ngôn ngữ. Rust không tạo chênh lệch đáng kể ở các thao tác này.
- Hệ sinh thái PDF của Rust còn mỏng: `lopdf` ở mức thấp, không có tương đương `pdfcpu` về độ chín (mã hóa AES, bookmark, optimize, validate). Port sang Rust đồng nghĩa tự dựng lại toàn bộ tầng tính năng mà `pdfcpu` đã cho sẵn và đã kiểm chứng.
- Bản Go **đã tồn tại và hoàn chỉnh**: đủ 17 lệnh, có unit test, đã đối chiếu tương thích chéo với Python (encrypt/decrypt hai chiều). Chi phí hợp nhất về Go ≈ 0 so với viết lại.
- Cái Rust thắng thật (khởi động ~10–20 ms so với ~90 ms; exe nhỏ hơn vài MB) không tương xứng với rủi ro lỗi PDF biên khi viết lại engine.

### 0.2. Vì sao không duy trì song song Python + Go nữa
- Mỗi tính năng hiện phải làm 3 nơi (Python + Go + Web UI) — đây là chi phí thường trực lớn nhất của dự án, lớn hơn mọi tối ưu vi mô.
- Sau Chặng 0, quy ước đồng bộ trong `ROADMAP.md` sửa thành: **Go là bản cài đặt duy nhất**; Web UI đồng bộ khi phù hợp; Python chỉ còn vai trò tham chiếu.

### 0.3. Nguyên tắc bất biến (non-goals)
- [ ] Không nhúng LibreOffice hay bất kỳ runtime ngoài nào vào exe (phá tiêu chí nhẹ).
- [ ] Không dùng UPX/packer để ép dung lượng (chậm khởi động, dễ bị antivirus báo nhầm).
- [ ] Không tự viết engine PDF (parser/writer) — chỉ dùng `pdfcpu` + `ledongthuc/pdf`.
- [ ] Không thêm tính năng mới vào lộ trình này — tính năng đi theo `ROADMAP.md`.

---

## Chặng 0 — Hợp nhất về Go (nền móng)

**Mục tiêu:** một bản cài đặt duy nhất để phát triển và phát hành.

- [ ] Tuyên bố trong `README.md`: bản Go (`pdfcraft.exe`) là bản chính thức; bản Python chuyển trạng thái "legacy/tham chiếu".
- [ ] Di chuyển `python/` → `legacy/python/` (giữ nguyên lịch sử git bằng `git mv`), giữ lại bộ fixture PDF mẫu dùng chung cho test của Go.
- [ ] Đổi module path trong `go/go.mod`: `github.com/user/pdfcraft` → `github.com/vmcchooky/pdf-crafting/go`; cập nhật mọi import path tương ứng.
- [ ] CI: bỏ job pytest/mypy/pyright khỏi pipeline bắt buộc (giữ `go test` + `node --test` + Playwright); tag một release cuối cùng có bản Python để ai cần vẫn tải được.
- [ ] Sửa `ROADMAP.md`: quy ước đồng bộ 3 nơi → Go (+ Web UI khi phù hợp); các mục tính năng chưa làm giữ nguyên.
- [ ] Cập nhật số liệu trong `README.md` theo Phụ lục A (exe amd64 15,3 MB; bỏ con số "~10 MB").

**Tiêu chí hoàn thành:** repo chỉ còn một đường phát hành (Go); CI xanh; README nhất quán.
**Ước lượng:** nhỏ (1–2 buổi). **Rủi ro:** thấp — không đổi hành vi người dùng.

---

## Chặng 1 — Phát hành plug-and-play cho Windows

**Mục tiêu:** người dùng Windows tải về là chạy, trên cả máy x64 lẫn ARM.

- [ ] `release.yml`: build ma trận 2 kiến trúc `amd64` + `arm64` (`GOOS=windows`, `CGO_ENABLED=0`, `-ldflags="-s -w" -trimpath`), đặt tên file phân biệt rõ: `PDFCraft-windows-amd64.exe`, `PDFCraft-windows-arm64.exe`.
- [ ] Thêm biến thể **CLI-only**: build tag (ví dụ `nocui`) loại `//go:embed all:web` và lệnh `ui`/`open` khỏi binary → dung lượng dự kiến ~12,9 MB (trừ ~2,4 MB Web UI nhúng). Phát hành song song bản full.
- [ ] Đính kèm `SHA256SUMS.txt` trong mỗi release.
- [ ] Tạo manifest **winget** (`winget install pdfcraft`) trỏ về release trên GitHub.
- [ ] Kiểm tra tay trên máy sạch (VM Windows 10 + Windows 11, không cài sẵn gì): tải → chạy `info`/`merge` → mở `ui` → `register-menu`.
- [ ] Ghi rõ trong README: yêu cầu tối thiểu Windows 10+ (giới hạn của Go 1.26, không hỗ trợ Windows 7/8).

**Việc để dành (chưa làm ở chặng này):** ký số Authenticode để hết cảnh báo SmartScreen — chỉ cân nhắc khi có người dùng thật ngoài vòng quen biết, vì chi phí chứng thư hằng năm không nhỏ. Ghi nhận đây là rào cản phân phối lớn nhất còn lại, không phải vấn đề kỹ thuật.

**Tiêu chí hoàn thành:** release có đủ 4 file (2 kiến trúc × 2 biến thể) + checksum; cài qua winget được; chạy sạch trên VM Windows trắng.
**Ước lượng:** trung bình (2–3 buổi, phần lớn là kiểm thử máy sạch).

---

## Chặng 2 — Độ tin cậy & tốc độ lõi

**Mục tiêu:** file không bao giờ hỏng vì ghi dở; tốc độ đo được và không tụt theo thời gian. (Học từ storytold/pdfcraft: ghi nguyên tử, kiểm chứng bằng qpdf, corpus file ác tính.)

- [ ] **Ghi nguyên tử**: mọi lệnh ghi của bản Go ghi ra file tạm cùng thư mục đích rồi `rename` hoán đổi; lỗi giữa chừng không đụng file gốc. Bổ sung test mô phỏng lỗi ghi.
- [ ] **Kiểm chứng đầu ra bằng qpdf**: thêm bước CI chạy `qpdf --check` trên toàn bộ file PDF sinh ra từ bộ test Go + ví dụ trong `examples/`.
- [ ] **Corpus hồi quy**: thư mục `tests/corpus/` gom các PDF khó (mã hóa lạ, xref hỏng, file scan lớn, PDF từ Word/Excel/Chrome...) kèm kỳ vọng (đọc được/lỗi có kiểm soát, tuyệt đối không crash/panic). Chạy trong CI.
- [ ] **Xử lý hàng loạt song song**: `merge`/`compress`/`split` trên nhiều file dùng worker pool giới hạn theo `min(GOMAXPROCS, 4)`; đo trước/sau bằng benchmark; giữ nguyên hành vi khi 1 file.
- [ ] **Benchmark trong CI**: chuyển các mục đo của `benchmark.py` (startup+info, extract, split, compress trên file mẫu 50 trang + file scan) thành script chạy tự động, đặt ngưỡng hồi quy (ví dụ: chậm hơn 20% so với mốc thì CI báo vàng).
- [ ] **Spike incremental save (timebox tối đa 2 buổi, có điều kiện dừng):** kiểm chứng `pdfcpu` có hỗ trợ ghi incremental/append cho các lệnh rẻ (`rotate`, `meta`, `bookmark`) đủ sạch hay không. Nếu không → **dừng, ghi lại kết luận vào đây**, không tự viết cơ chế append riêng. (Tiền lệ: mục linearize trong `ROADMAP.md` đã tạm gác vì cùng lý do phụ thuộc `pdfcpu`.)

**Tiêu chí hoàn thành:** không còn đường ghi trực tiếp lên file đích; CI có qpdf + corpus + benchmark; spike có kết luận viết thành văn bản (làm/không làm).
**Ước lượng:** trung bình–lớn (Chặng 2 trừ spike: ~3–4 buổi).

---

## Chặng 3 — Sửa lỗi chức năng đáng tiền nhất

- [ ] **Watermark tiếng Việt:** nhúng một font subset hỗ trợ đầy đủ dấu tiếng Việt (subset từ font OFL như Inter/Noto Sans, chỉ giữ Latin + Latin Extended + dấu tổ hợp; mục tiêu ≤ 300 KB). Logic: văn bản watermark có ký tự ngoài Latin-1 → dùng font nhúng; còn lại giữ Helvetica built-in. Test: watermark "BẢN NHÁP" hiển thị đúng trên file xuất.
- [ ] **`convert` khi thiếu engine:** không có LibreOffice lẫn MS Office → lỗi thoát rõ ràng, in hướng dẫn cài LibreOffice hoặc gợi ý dùng bản có Office; có MS Office → đi đường COM như thiết kế ở mục 1 của `ROADMAP.md`. Giữ nguyên tắc: tính năng tùy chọn, không nhúng engine.

**Tiêu chí hoàn thành:** watermark tiếng Việt đúng dấu trong file xuất và có test; `convert` trên máy trắng báo lỗi dễ hiểu thay vì lỗi kỹ thuật.
**Ước lượng:** nhỏ–trung bình (1–2 buổi).

---

## Thứ tự thực thi & phụ thuộc

1. Chặng 0 → 2. Chặng 1 → 3. Chặng 3 (độc lập, làm bất cứ lúc nào) → 4. Chặng 2.
   Chặng 1 phụ thuộc Chặng 0 (chỉ phát hành một bản cài đặt). Chặng 2 và 3 độc lập với nhau.
2. Mỗi chặng một release: `v1.2.0` (Chặng 0+1), `v1.3.0` (Chặng 3), `v1.4.0` (Chặng 2) — số phiên bản gợi ý, chốt khi bắt đầu.

## Phụ lục A — Số đo nền (2026-11-27, máy đo: VM Linux, cross-compile)

| Hạng mục | Giá trị |
|---|---|
| Exe Windows amd64 (`-s -w -trimpath`, `CGO_ENABLED=0`) | **15.342.080 byte (~15,3 MB)** |
| Exe Windows arm64 (cùng cờ build) | **14.131.712 byte (~14,1 MB)** |
| Web UI nhúng trong exe (`go:embed all:web`) | ~2,4 MB |
| Khởi động + `info` (đo trên Windows, từ `benchmark.py` của repo) | ~90 ms |
| RAM khi chạy | ~8–15 MB |
| Engine | `pdfcpu v0.15.0` + `ledongthuc/pdf` (text) |
| Toolchain | Go 1.26.11 (yêu cầu Windows 10+ khi chạy) |

## Phụ lục B — Nguồn tham khảo

- storytold/pdfcraft (Rust, Apache-2.0/MIT): học ở *kỹ thuật* — ghi incremental + nguyên tử, kiểm chứng qpdf trong CI, corpus 983 file của pdf.js đạt 0 crash, security handler đầy đủ. Không học ở *phạm vi*: đó là trình đọc/biên tập đầy đủ với engine render tự viết — ngoài nhu cầu của dự án này.
