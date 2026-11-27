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
- **Đợt 2 (27/11, chiều muộn) — hoàn thiện:**
  - [x] Chặng 0 xong hẳn: `python/` → `legacy/python/` (git mv, giữ lịch sử), bỏ job Python khỏi CI, cập nhật `pyproject.toml`/`pyrightconfig.json`/README/ROADMAP; thêm `legacy/README.md`.
  - [x] **Tốc độ tách trang (split) nhanh hơn ~2,7 lần**: `SplitAll` chuyển từ CollectFile-từng-trang (phân tích lại tệp N lần) sang `SplitFile` của pdfcpu (phân tích 1 lần) — đo bằng benchmark kèm trong repo (`BenchmarkSplitAll60`: 254 ms → 95 ms trên máy kiểm chứng). Phương án worker-pool song song đã thử và **loại bỏ bằng số đo**: chậm hơn trên máy ít nhân, tốn RAM hơn.
  - [x] `convert`: thêm đường **Microsoft Office COM** (Word/Excel/PowerPoint qua PowerShell, danh sách file truyền bằng manifest JSON) khi máy Windows không có LibreOffice; thông báo lỗi khi thiếu cả hai đã rõ ràng.
  - [x] Lệnh `version`/`--version` in phiên bản từ dữ liệu build Go tự nhúng (kèm VCS revision khi build từ checkout).
  - [x] Rà soát an toàn server Web UI: chỉ bind `127.0.0.1`, giới hạn thân request 150 MB, tên file tải lên được rút gọn vào thư mục tạm riêng — đạt, không phải sửa.

## Cập nhật 2026-11-27 (tối) — Chặng 2 hoàn tất trên nhánh `stage2-reliability`

- Sửa lỗi `convert`: khi Microsoft Office COM thất bại, thông báo kèm hướng dẫn cài LibreOffice/kiểm tra bộ Office thay vì lỗi RPC thô; `TestConvertOfficeErrors` xanh trên Windows (trước đó đỏ trên máy có PowerShell nhưng Office không chạy được).
- Vá `saveSafely`: bỏ fallback xóa file đích trước `rename`; fallback mới copy sang temp phụ rồi rename, lỗi giữa chừng giữ nguyên file gốc; thêm test writer-failure và test đích là thư mục.
- CI: bỏ job Python (đã move `legacy/python/`), thêm cross-build Windows amd64/arm64, job `qpdf`, job `bench` non-blocking.
- Corpus sinh tổng hợp + benchmark CLI vi sai + xử lý hàng loạt song song (số đo ở Chặng 2).
- Spike incremental save: **không khả thi** với pdfcpu 0.15.0 — xem kết luận ở Chặng 2.
- Các mục từng "hoãn vô thời hạn" (corpus, benchmark CI, xử lý song song) đã được nâng lại và hoàn tất trong đợt này.

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

- [x] **Ghi nguyên tử**: mọi lệnh ghi của bản Go đi qua `saveSafely` (ghi tạm cùng thư mục + hoán đổi). Vá fallback (27/11/2026): không xóa/ghi trực tiếp lên file đích trước khi thay thế thành công — copy sang temp phụ rồi rename lần nữa; có test writer-failure, test đích là thư mục, test ghi đè.
- [x] **Kiểm chứng đầu ra bằng qpdf**: job CI `qpdf` cài qpdf, chạy `TestCorpus` với `PDFCRAFT_QPDF_OUTDIR` rồi `qpdf --check` toàn bộ output + `examples/*.pdf`. Máy Windows local không có qpdf nên phần xác nhận độc lập diễn ra trên CI; local đã validate bằng pdfcpu.
- [x] **Corpus hồi quy**: sinh tại temp trong `go/pkg/pdfcraft/corpus_test.go` (không commit binary): PDF hợp lệ, mã hóa AES-256, xref hỏng, file cắt cụt, scan ảnh, trang xoay, watermark tiếng Việt. Chạy info/extract/split/compress/rotate/watermark — không panic, lỗi có kiểm soát, output validate bằng pdfcpu; chạy trong CI.
- [x] **Xử lý hàng loạt song song**: `compress`/`split` nhận nhiều file với worker pool `min(GOMAXPROCS, 4)`; giữ nguyên hành vi khi 1 file. Đo 27/11/2026 (`BenchmarkBatchCompressWorkers`, 10 file × 20 trang, máy 8 nhân logic): 28,3 ms (1 worker) → 19,4 ms (2 worker) → 21,0 ms (4 worker) tối thiểu qua các lượt đo — song song có lợi, giữ cap 4 (2 worker nhỉnh hơn trên máy đo nhưng chênh lệch nằm trong nhiễu). `merge` không song song: nhiều đầu vào nhưng một đầu ra, không có việc độc lập.
- [x] **Benchmark trong CI**: job `bench` non-blocking (`continue-on-error`) build binary từ `origin/main` và từ nhánh, đo vi sai 6 chỉ số CLI (info/extract/split/compress trên file 50 trang + file scan) trên cùng runner, cảnh báo vàng khi chậm hơn >20%. Benchmark Go cục bộ: `BenchmarkGetInfo50`, `BenchmarkExtract20`, `BenchmarkSplitAll10`, `BenchmarkCompress50`, `BenchmarkMerge5x10`, `BenchmarkWatermark50`, `BenchmarkCompressScan`, `BenchmarkBatchCompressWorkers`. Lưu ý trung thực: đo local Windows cho thấy lệnh ngắn dao động tới ±44% giữa hai binary giống hệt nhau — vì vậy job chỉ cảnh báo, không chặn merge.
- [x] **Spike incremental save**: kết luận **KHÔNG LÀM**. Bằng chứng trên pdfcpu v0.15.0: `pkg/pdfcpu/read.go:1683` ghi chú giả định một xref section — "no incremental updates"; `pkg/pdfcpu/model/xreftable.go:3308` còn `TODO enable incremental writing`; `pkg/api` không có hàm incremental/append. Không tự viết cơ chế append riêng (đúng điều kiện dừng của spike).

**Tiêu chí hoàn thành:** không còn đường ghi trực tiếp lên file đích; CI có qpdf + corpus + benchmark; spike có kết luận viết thành văn bản (làm/không làm). — **Đạt tại local (27/11/2026); các job CI mới bổ sung chờ lần chạy đầu tiên sau khi push.**
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
