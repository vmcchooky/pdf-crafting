# Prompt cho AI cloud — vá PDF Craft theo checklist

> Dán toàn bộ nội dung dưới đây vào AI cloud có quyền đọc/ghi repo.
> Prompt giả định AI có thể clone repo, tạo branch, chạy test và mở PR.

---

Bạn là một senior security engineer kiêm Go/JavaScript developer. Nhiệm vụ của bạn là vá **tuần tự** 17 vấn đề bảo mật và độ tin cậy trong repo PDF Craft, theo checklist đã được audit sẵn.

## Thông tin repo

- Repo: `https://github.com/vmcchooky/pdf-crafting`
- Base branch: `audit/security-checklist-2026-11`
- Checklist nguồn: `docs/SECURITY-AUDIT-2026-11.md`
- Branch làm việc: tạo mới `fix/security-audit-2026-11` từ base branch ở trên.
- Nếu base branch chưa tồn tại (đã merge vào `main`), dùng `main` và ghi rõ trong báo cáo.

## Mục tiêu

Đọc kỹ `docs/SECURITY-AUDIT-2026-11.md` trước khi sửa bất cứ dòng nào. Đó là nguồn chân lý: mỗi mục có ID `S1`…`S17`, bằng chứng file/dòng, cách sửa, tiêu chí nghiệm thu và test bắt buộc.

Thực hiện **theo đúng thứ tự ở mục “2. Thứ tự thực hiện đề xuất”** trong checklist:

1. `S1` — `move` same-file làm file 0 byte.
2. `S3` — token phiên + kiểm tra Host/Origin (nền tảng cho các mục sau).
3. `S2` + `S17` — shutdown có xác thực + graceful shutdown.
4. `S4` + `S16` — validate project + diệt stored XSS.
5. `S5` — PDF.js CVE-2024-4367.
6. `S6` + `S7` — CSRF context menu + clickjacking.
7. `S8` — optimize semaphore/goroutine.
8. `S9` + `S10` — convert Office + export timeout.
9. `S11` — initial-file disclosure.
10. `S12` — password trong argv.
11. `S13` — hardening Office.
12. `S14` — fsync.
13. `S15` — security headers/CSP.

Không nhảy cóc, không gộp các mục không liên quan vào một commit. Với mỗi mục:

1. Đọc code liên quan và tái hiện vấn đề nếu có thể.
2. Viết test hồi quy **trước hoặc cùng lúc** với fix.
3. Sửa đúng nguyên nhân gốc, không chỉ che triệu chứng.
4. Chạy test của mục đó + test liên quan.
5. Cập nhật checkbox `[x]` trong checklist và ghi kết quả ngắn vào `docs/SECURITY-FIX-REPORT.md`.
6. Commit với message `fix(security): S<ID> <mô tả ngắn>`.

## Ràng buộc kỹ thuật

- **Không phá API/CLI/UI hiện có.** Thêm flag/hành vi mới theo hướng tương thích ngược. Nếu buộc phải đổi, cập nhật mọi call site + README/HUONG-DAN.
- **Web UI có hai bản:** `web/` là source of truth, `go/cmd/pdfcraft/web/` là bản nhúng. Sau mỗi thay đổi web, chạy `python scripts/sync_web.py` và commit cả hai. CI guard: `python scripts/sync_web.py --check`.
- **Không thêm CORS `*`.** Không thêm `Access-Control-Allow-Origin` trừ khi thật sự cần và phải giới hạn origin chính xác.
- **Không log mật khẩu, token, nội dung PDF, hay đường dẫn nhạy cảm.**
- **Không dùng `os.Exit` trong handler HTTP/goroutine xử lý request.** Dùng graceful shutdown.
- **Không tắt kiểm tra bảo mật** (TLS verification, v.v.) để “cho chạy được”.
- **Không thêm dependency runtime mới** nếu stdlib làm được. Nếu cần, ưu tiên thư viện đã có trong `go.mod`/`package.json`.
- **Không commit binary, `node_modules`, `test-results`, file tạm.**
- **Không force-push `main`.** Làm trên branch riêng và mở PR.
- **Giữ thay đổi nhỏ, dễ review.** Nếu một fix quá lớn, tách commit trong cùng PR và ghi rõ phần bắt buộc vs hardening.

## Kiểm thử bắt buộc

Chạy tối thiểu trước khi báo xong (ghi output tóm tắt vào report):

```bash
cd go
gofmt -w .
go vet ./...
go test -race ./...
go build ./...
# nếu môi trường không phải Windows:
GOOS=windows GOARCH=amd64 go build ./...
govulncheck ./...

cd ..
python scripts/sync_web.py --check
node --test web/tests/utils.test.js

cd web
npm ci
npx playwright install chromium
npx playwright test
```

Nếu môi trường cloud không có Windows/LibreOffice/Playwright, vẫn phải:

- Implement đầy đủ + unit test.
- Cross-compile `GOOS=windows`.
- Ghi rõ trong report phần nào chưa test được và lý do.
- Không đánh dấu `[x]` cho tiêu chí chỉ có thể kiểm tra thủ công trên Windows nếu chưa kiểm tra.

## Yêu cầu bảo mật cụ thể

- **S3 là nền tảng:** làm token + Host/Origin trước S2/S6/S11. Token phải ngẫu nhiên mỗi lần chạy, không nằm trong file JS tĩnh/URL/log. UI đọc token từ meta tag do server inject và gửi header `X-PDFCraft-Token`.
- **S1:** không chỉ sửa `MovePage`; thêm defense-in-depth trong `copyFile` để mọi call site tương lai không truncate source.
- **S4/S16:** validate project trước khi xóa state; dùng `textContent`/DOM API thay vì `innerHTML` cho dữ liệu project; validate `dataUrl` bằng regex chặt.
- **S5:** `isEvalSupported: false` là mitigation bắt buộc; nâng pdf.js >= 4.2.67 là ưu tiên. Nếu nâng, cập nhật cả worker và test kỹ.
- **S8/S9:** semaphore phải được giữ đến khi goroutine/process thực sự kết thúc; cleanup chỉ sau khi converter dừng; thêm `recover()` để PDF hỏng không giết process.
- **S13:** đây là hardening best-effort; không tuyên bố “đã sandbox” nếu chỉ đổi profile. Ghi rõ residual risk.
- **S15:** CSP bắt đầu ở chế độ chặt (`script-src 'self'`, không `unsafe-eval`), chỉ nới `style-src 'unsafe-inline'` nếu app cần; chạy full Playwright và kiểm tra `securitypolicyviolation`.

## Deliverables

1. Branch `fix/security-audit-2026-11` với các commit theo từng mục.
2. Checklist đã cập nhật `[x]` cho các mục hoàn thành.
3. `docs/SECURITY-FIX-REPORT.md` gồm:
   - Bảng `ID | Trạng thái | Commit | Test đã chạy | Ghi chú`.
   - Tóm tắt thay đổi kiến trúc (token/middleware/graceful shutdown).
   - Kết quả test thực tế (pass/fail, số test).
   - Residual risk và phần chưa kiểm tra được.
4. PR mô tả ngắn gọn, link tới checklist, hướng dẫn review theo thứ tự commit.
5. Trả lời cuối cùng cho người dùng bằng tiếng Việt:
   - Đã làm xong mục nào, chưa xong mục nào, vì sao.
   - Cách chạy test.
   - Những điểm cần người dùng kiểm tra thủ công trên Windows (context menu, Office conversion, shutdown).
   - Link PR.

## Điều kiện dừng

- Nếu gặp quyết định sản phẩm (ví dụ bỏ hẳn `--password`), **không tự ý bỏ**; giữ tương thích ngược, thêm lựa chọn an toàn hơn, ghi chú trong report.
- Nếu một fix cần thay đổi lớn ngoài phạm vi (ví dụ sandbox LibreOffice bằng VM), implement phần hardening tối thiểu, ghi rõ phần còn lại là out-of-scope.
- Nếu test fail do môi trường (thiếu LibreOffice/Playwright), ghi rõ; không báo xanh giả.

Bắt đầu bằng việc đọc checklist, liệt kê kế hoạch 17 mục, rồi làm **tuần tự** từ S1. Không hỏi lại nếu checklist đã đủ chi tiết; chỉ hỏi khi có xung đột không thể giải quyết bằng nguyên tắc trong checklist.
