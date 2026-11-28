# Checklist vá bảo mật & độ tin cậy — PDF Craft (11/2026)

> **Đây là nguồn chân lý cho đợt vá.** Mỗi mục có ID `S1`…`S17`, bằng chứng,
> việc cần làm, tiêu chí nghiệm thu và test bắt buộc. Không đánh dấu `[x]` nếu
> test tương ứng chưa chạy và chưa ghi kết quả vào `docs/SECURITY-FIX-REPORT.md`.
>
> **Phạm vi:** Go Web UI server, CLI/core PDF, Windows context menu, chuyển đổi
> Office, và các DOM sink trong Web UI. Không bao gồm Python legacy (đã đóng băng).
>
> **Môi trường đích:** Windows 10/11 là chính; CI có thể chạy Linux. Mọi thay đổi
> phải build được cả `GOOS=windows` và `GOOS=linux` nếu file không có build tag.

---

## 0. Bối cảnh & mô hình đe dọa

PDF Craft là ứng dụng desktop cục bộ: một tiến trình Go mở HTTP server chỉ bind
`127.0.0.1`, phục vụ Web UI nhúng, và xử lý PDF/Office bằng thư viện trong nước.

Các tác nhân cần chặn:

1. **Trang web độc hại** trong trình duyệt của người dùng:
   - CSRF vào các endpoint `POST` (đặc biệt context-menu ghi registry, shutdown).
   - DNS rebinding: domain của attacker resolve về `127.0.0.1`, mang `Host` giả
     để đọc response của server.
   - Clickjacking: nhúng UI local vào iframe để lừa bấm nút.
2. **Tệp độc hại do người dùng mở**: PDF (CVE pdf.js), `.pdfcraft.json`, tài liệu
   Office.
3. **Lỗi logic nội bộ** gây mất dữ liệu hoặc treo tiến trình: `move` same-file,
   timeout/goroutine, shutdown cưỡng bức.

**Không nằm trong mô hình đe dọa:** tiến trình độc hại chạy cùng tài khoản người
dùng (nó đã có quyền đọc file và can thiệp process). Tuy vậy, token + Host check
vẫn giúp giảm bề mặt.

**Nguyên tắc:** không thêm CORS `*`, không tắt kiểm tra chứng chỉ, không log mật
khẩu/nội dung tài liệu, không đưa thư viện mới vào runtime nếu stdlib làm được.

---

## 1. Quy tắc chung cho người/AI vá

1. **Một issue = một commit** (hoặc một nhóm rất nhỏ có liên quan trực tiếp).
   Không trộn thay đổi UI không liên quan vào commit bảo mật.
2. **Không phá API/CLI hiện có.** Thêm flag/hành vi mới theo hướng tương thích
   ngược; nếu buộc phải đổi, cập nhật README/HUONG-DAN và tất cả call site.
3. **Web UI có hai bản:** `web/` là source of truth; `go/cmd/pdfcraft/web/` là bản
   nhúng. Sau mỗi thay đổi web phải chạy `python scripts/sync_web.py` và commit cả
   hai. CI guard: `python scripts/sync_web.py --check`.
4. **Chạy tối thiểu trước khi báo xong:**
   - `cd go && gofmt -w . && go vet ./... && go test -race ./... && go build ./...`
   - `GOOS=windows GOARCH=amd64 go build ./...` (nếu môi trường là Linux/macOS)
   - `govulncheck ./...`
   - `python scripts/sync_web.py --check`
   - `node --test web/tests/utils.test.js`
   - `cd web && npx playwright test` (Chromium)
5. **Không dùng `os.Exit` trong handler HTTP** hoặc trong goroutine xử lý request.
6. **Mọi dữ liệu từ file/HTTP là untrusted.** Không nối chuỗi vào `innerHTML`,
   không mở file theo path do HTTP request chỉ định, không tin `Content-Type`.
7. **Giữ thay đổi nhỏ, dễ review.** Nếu một fix quá lớn, tách thành nhiều commit
   trong cùng PR và ghi rõ phần nào là hardening, phần nào là bắt buộc.
8. **Cập nhật tài liệu sai sự thật.** `ENGINEERING-ROADMAP.md:26` đang ghi server
   Web UI “đạt, không phải sửa”; sửa lại theo kết quả thực tế.
9. **Báo cáo cuối:** tạo `docs/SECURITY-FIX-REPORT.md` ghi rõ issue nào đã xong,
   test nào đã chạy, output tóm tắt, residual risk, và commit hash.

---

## 2. Thứ tự thực hiện đề xuất

Thứ tự này ưu tiên chặn mất dữ liệu và các lỗ hổng có thể bị khai thác từ web,
đồng thời tạo nền tảng token/graceful shutdown cho các mục sau:

1. **S1** — mất dữ liệu `move` (không phụ thuộc gì).
2. **S3** — token + Host/Origin (nền tảng cho S2, S6, S11).
3. **S2 + S17** — shutdown có xác thực + graceful shutdown.
4. **S4 + S16** — validate project + diệt XSS.
5. **S5** — pdf.js CVE.
6. **S6 + S7** — CSRF context menu + clickjacking headers.
7. **S8** — optimize semaphore/goroutine.
8. **S9 + S10** — convert Office + export timeout.
9. **S11** — initial-file disclosure.
10. **S12** — password trong argv.
11. **S13** — hardening Office.
12. **S14** — fsync.
13. **S15** — security headers/CSP.

> Nếu S3 làm thay đổi mọi fetch call, hãy làm S3 trước S2/S6/S11 để tránh sửa hai lần.

---

## 3. Checklist 17 vấn đề

### S1 — [Critical] `move` same-file làm file thành 0 byte

- **Trạng thái:** `[ ]`
- **Bằng chứng:**
  - `go/pkg/pdfcraft/document.go:230-279` (`MovePage`).
  - `go/pkg/pdfcraft/document.go:853-872` (`copyFile`).
  - `go/cmd/pdfcraft/main.go:354-377` (`runMove`, `-o` mặc định = input).
- **Nguyên nhân:** khi `fromPage == toPage`, code so sánh `absIn != outPath`.
  `absIn` là absolute; `outPath` mặc định là chuỗi input (thường relative). Hai
  chuỗi khác nhau dù cùng file. Sau đó `copyFile` mở đích bằng `O_TRUNC` trước khi
  copy, làm source (cũng là đích) bị truncate còn 0 byte.
- **Repro đã xác nhận:**
  ```powershell
  Copy-Item examples\sample_doc.pdf $env:TEMP\same.pdf
  Set-Location $env:TEMP
  PDFCraft.exe move same.pdf -from 2 -to 2
  # In "Thành công", same.pdf = 0 byte
  ```
- **Việc cần làm:**
  1. Trong `MovePage`, tính `absOut, err := filepath.Abs(outPath)`; dùng
     `filepath.Clean` cho cả hai.
  2. Nếu `fromPage == toPage`:
     - Nếu `sameFile(absIn, absOut)` → `return nil` (no-op thật sự).
     - Nếu khác file → dùng `saveSafely(absIn, absOut, func(tmp string) error {
       return copyFile(absIn, tmp) })`, không ghi trực tiếp vào đích.
  3. Thêm helper `sameFile(a, b string) bool`:
     - `os.Stat` cả hai; nếu cả hai tồn tại, dùng `os.SameFile`.
     - Nếu một bên không tồn tại, so sánh `filepath.Clean`; trên Windows dùng
       `strings.EqualFold` để bắt khác hoa/thường.
  4. Trong `copyFile`, trước khi mở đích: nếu source và đích cùng file (theo
     `sameFile`), trả lỗi rõ ràng thay vì truncate. Đây là defense-in-depth cho
     mọi call site tương lai.
  5. Kiểm tra `close`/`Sync` của đích; không bỏ qua lỗi ghi.
- **Tiêu chí nghiệm thu:**
  - [ ] `move same.pdf -from 2 -to 2` giữ nguyên byte-for-byte.
  - [ ] `move` với `-o` khác file vẫn tạo kết quả đúng.
  - [ ] `copyFile(src, src)` trả lỗi và không làm đổi file.
  - [ ] Không còn so sánh chuỗi path trần trong `MovePage`.
- **Test bắt buộc:**
  - [ ] Go test: same absolute path, same relative path, `./` variant, case variant
    trên Windows, symlink nếu nền tảng hỗ trợ.
  - [ ] Go test: `copyFile` same-file trả lỗi, source còn nguyên.
  - [ ] `go test -race ./...`.

### S2 — [Critical] `/api/shutdown` không xác thực, không kiểm tra method

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `go/cmd/pdfcraft/server.go:466-474`; UI gọi ở `web/app.js:4627`.
- **Nguyên nhân:** handler chạy với mọi method, không token/Origin, trả 200 rồi
  `os.Exit(0)` sau 350 ms.
- **Việc cần làm:**
  1. Chỉ chấp nhận `POST`; method khác → 405.
  2. Yêu cầu token phiên (S3) và kiểm tra Origin (S3).
  3. Trả `202 Accepted` JSON; gửi tín hiệu vào `shutdownCh` (buffered, non-blocking)
     thay vì `os.Exit`.
  4. Nối vào graceful shutdown của S17; không kill request đang chạy.
  5. UI dùng `apiFetch('/api/shutdown', { method: 'POST' })`; giữ hộp thoại xác nhận.
- **Tiêu chí nghiệm thu:**
  - [ ] `GET /api/shutdown` → 405, server vẫn sống.
  - [ ] `POST` không token → 401/403, server vẫn sống.
  - [ ] `POST` có token nhưng `Origin` lạ → 403.
  - [ ] `POST` hợp lệ → 202, server shutdown graceful.
  - [ ] Không còn `os.Exit` trong handler.
- **Test bắt buộc:**
  - [ ] `httptest` cho 4 case trên.
  - [ ] Test graceful: một handler chậm đang chạy vẫn hoàn tất trước khi process thoát.
  - [ ] Playwright: bấm nút thoát → thấy thông báo, server dừng.

### S3 — [Critical] Không kiểm tra Host/Origin → DNS rebinding + CSRF

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:443` chỉ bind `127.0.0.1`; không handler/middleware nào
  kiểm tra `r.Host`/`Origin`. Đã thử `Host: evil.example:18089` → 200.
- **Nguyên nhân:** loopback binding không bảo vệ trước DNS rebinding; browser gửi
  `Host` theo domain attacker.
- **Việc cần làm:**
  1. Sinh `sessionToken` ngẫu nhiên 32 byte bằng `crypto/rand` + `hex` mỗi lần chạy.
  2. Thêm middleware bọc toàn bộ mux:
     - `Host` phải là `127.0.0.1:<port>` hoặc `localhost:<port>` (dùng
       `net.SplitHostPort`; thiếu port → từ chối). Trả 403/421 nếu sai.
     - Với `/api/*`: bắt buộc header `X-PDFCraft-Token` khớp token; so sánh bằng
       `crypto/subtle.ConstantTimeCompare`.
     - Với method thay đổi trạng thái (`POST/PUT/PATCH/DELETE`): nếu có `Origin`,
       phải khớp `http://127.0.0.1:<port>` hoặc `http://localhost:<port>`; nếu
       không có `Origin`, chỉ cho phép khi `Sec-Fetch-Site` là `same-origin`/`none`
       hoặc không có header (CLI/test).
     - Không thêm `Access-Control-Allow-Origin`.
  3. Phát token cho UI:
     - Thêm `<meta name="pdfcraft-token" content="__PDFCRAFT_TOKEN__">` vào
       `web/index.html`.
     - Server special-case `/` và `/index.html`: đọc file nhúng, thay placeholder
       bằng token, set `Cache-Control: no-store`, `Content-Type: text/html;
       charset=utf-8`.
     - Các asset khác vẫn dùng file server.
  4. Trong `web/app.js`, thêm helper:
     ```js
     const API_TOKEN = document.querySelector('meta[name="pdfcraft-token"]')?.content || '';
     function apiFetch(url, options = {}) {
       const headers = new Headers(options.headers || {});
       if (API_TOKEN) headers.set('X-PDFCraft-Token', API_TOKEN);
       return fetch(url, { ...options, headers });
     }
     ```
     Thay **tất cả** `fetch('/api/...')` bằng `apiFetch` (8 call site hiện tại:
     convert, initial-file, initial-file/content, context-menu/status,
     context-menu/install|uninstall, export/finalize, optimize, shutdown).
  5. Refactor `runUI` đủ để test middleware (ví dụ `newServer(cfg)` hoặc
     `newMux(token, port, ...)`), không cần dựng cả browser.
- **Tiêu chí nghiệm thu:**
  - [ ] Request `Host: evil.example:<port>` → 403/421 cho mọi route.
  - [ ] Mọi `/api/*` thiếu/sai token → 401/403.
  - [ ] Request cross-origin có token nhưng Origin lạ → 403.
  - [ ] UI tải bình thường, tất cả flow hoạt động với token.
  - [ ] Token không nằm trong file JS tĩnh/URL/log.
  - [ ] Không có CORS header.
- **Test bắt buộc:**
  - [ ] `httptest` cho Host sai, token thiếu, Origin sai, request hợp lệ.
  - [ ] Test `/` chứa meta token; `/app.js` không chứa token.
  - [ ] Playwright smoke: upload, preview, export, optimize, context-menu status.
  - [ ] `curl -H "Host: evil.example"` trả 403/421.

### S4 — [Critical] Stored XSS khi mở `.pdfcraft.json` độc

- **Trạng thái:** `[ ]`
- **Bằng chứng:**
  - `web/app.js:1484` nhận `groups[].name/color`; `:1500` nhận `stamps[]`.
  - `renderGroupBar` `web/app.js:2397-2402` chèn `${g.name}`, `${g.color}` vào
    `innerHTML`/`style`.
  - `renderSignStageStamps` `web/app.js:6893` và `renderSignStampsList`
    `web/app.js:7177` chèn `${stamp.dataUrl}` vào `src`.
- **Nguyên nhân:** project file là untrusted; các trường được đưa vào HTML mà
  không escape/validate. `dataUrl` có thể phá attribute bằng `" onerror=...`.
- **Việc cần làm:**
  1. Viết `validateProjectPayload(project)` (đặt ở `web/utils.js` để test Node,
     hoặc `app.js` nếu cần DOM):
     - `app === 'pdfcraft'`; `version` là number; `sources/pages/groups` là array.
     - Giới hạn: sources ≤ 100, pages ≤ 10000, groups ≤ 1000, stamps/trang ≤ 500.
     - `groups[]`: `id` string 1–64 ký tự; `name` string ≤ 120; `color` khớp
       `/^#[0-9a-fA-F]{6}$/`.
     - `sources[]`: `name` string ≤ 255; `data` string base64 hợp lệ; `fileSize`
       number hữu hạn ≥ 0.
     - `pages[]`: `source` integer trong `[0, sources.length)`; `pageIndex`
       integer ≥ 0; `rotation` thuộc `{0,90,180,270}`; `title` string ≤ 200;
       `groupIds` chỉ chứa id hợp lệ; `stamps` array.
     - `stamps[]`: `dataUrl` khớp
       `/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/` và ≤ 20 MB;
       `relX/relY/relW/relH` finite trong `[0,1]`; `opacity` trong `[0,1]`;
       `rotation` finite; `id` string an toàn.
     - `docMeta` chỉ giữ string, cắt độ dài.
  2. Validate **trước khi** xóa state hiện tại. Nếu lỗi: toast rõ ràng, giữ nguyên
     project đang mở.
  3. Sau khi load từng source, kiểm tra `pageIndex < pdfJsDoc.numPages`; nếu sai,
     reject (hoặc bỏ trang đó kèm cảnh báo — chọn một hành vi và test).
  4. Render an toàn:
     - `renderGroupBar`: tạo DOM bằng `document.createElement`; `nameSpan.textContent
       = g.name`; `dot.style.backgroundColor = safeColor`; không `innerHTML` chứa
       dữ liệu project.
     - `renderSignStageStamps`/`renderSignStampsList`: tạo `img`, set `img.src`
       bằng data URL đã validate; không nội suy vào chuỗi HTML.
     - Rà tất cả `innerHTML` có `p.title`, `source.name`, `docMeta`, `stamp.id`,
       `group.name`; dùng `escapeHtml` hoặc `textContent`.
  5. Thêm CSP `script-src 'self'` (S15) để giảm tác động nếu còn sink.
- **Tiêu chí nghiệm thu:**
  - [ ] Project có `groups[0].name = '<img src=x onerror="window.__xss=1">'`
        hiển thị như text, `window.__xss` undefined.
  - [ ] `stamp.dataUrl = 'x" onerror="window.__xss=1'` bị reject.
  - [ ] `color = 'red;background:url(javascript:...)'` bị reject.
  - [ ] `pageIndex`/`source` ngoài phạm vi bị reject, state cũ không bị xóa.
  - [ ] Không còn template literal chứa dữ liệu project trong `innerHTML`.
- **Test bắt buộc:**
  - [ ] Node unit test cho validator (hợp lệ, XSS name, dataUrl sai, color sai,
        index ngoài phạm vi, quá giới hạn).
  - [ ] Playwright fixture project độc: load, assert không execute, assert toast.
  - [ ] Playwright project hợp lệ vẫn load đủ trang/nhóm/dấu.

### S5 — [Critical] PDF.js 3.11.174 dính CVE-2024-4367

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `web/vendor/pdf.min.js` báo `version = "3.11.174"`;
  `web/app.js:1463,2614,2624` gọi `pdfjsLib.getDocument(...)` không đặt
  `isEvalSupported`.
- **Nguyên nhân:** CVE-2024-4367 (CVSS 8.8) ảnh hưởng `pdfjs-dist <= 4.1.392`,
  vá ở `4.2.67`. Khi `isEvalSupported: true` (mặc định), PDF độc chạy JS trong
  origin app.
- **Việc cần làm:**
  1. **Bắt buộc (mitigation):** đặt `isEvalSupported: false` trong **mọi**
     `getDocument` call. Tập trung thành constant:
     ```js
     const PDFJS_OPTIONS = { isEvalSupported: false };
     // getDocument({ data, ...PDFJS_OPTIONS })
     ```
     Kiểm tra cả `web/app.js` và bản nhúng sau sync.
  2. **Ưu tiên (upgrade):** nâng `pdfjs-dist` lên `>= 4.2.67` (tốt nhất bản mới
     nhất tương thích). Nếu dùng UMD/classic script, chọn legacy build phù hợp
     hoặc chuyển sang ESM module; cập nhật `pdf.worker.min.js` cùng version.
  3. Nếu upgrade quá xâm lấn: giữ 3.11.174 + `isEvalSupported:false`, ghi rõ
     trong report là technical debt, và thêm CSP `script-src 'self'` (không
     `unsafe-eval`).
  4. Thêm kiểm tra hồi quy: test đọc `app.js` và assert mọi `getDocument` có
     `isEvalSupported: false`, hoặc assert `pdfjsLib.version` không nằm trong
     khoảng vulnerable.
- **Tiêu chí nghiệm thu:**
  - [ ] Không còn `getDocument` nào dùng default `isEvalSupported`.
  - [ ] Nếu upgrade: `pdfjsLib.version >= 4.2.67`; worker cùng version; không lỗi
        console.
  - [ ] Render, text layer, search, PDF có mật khẩu, project load, export, ký
        đều hoạt động.
- **Test bắt buộc:**
  - [ ] Unit/grep test cho `isEvalSupported` hoặc version.
  - [ ] Playwright mở PDF thường + PDF có mật khẩu + project; không console error.
  - [ ] `govulncheck` (Go) không liên quan nhưng vẫn chạy.

### S6 — [High] CSRF vào context-menu install/uninstall

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:527-554` chỉ kiểm tra POST; UI gọi ở
  `web/app.js:989-991`.
- **Nguyên nhân:** form cross-site POST tới loopback vẫn gửi được; không token.
- **Việc cần làm:**
  1. Token + Origin check từ S3 áp dụng cho cả hai endpoint.
  2. Giữ method POST; thêm `confirm()` ở UI trước khi install/uninstall.
  3. Không trả chi tiết registry path ra ngoài; chỉ `{success:true}`.
- **Tiêu chí nghiệm thu:**
  - [ ] Request không token/Origin lạ → 403, registry không đổi.
  - [ ] UI có xác nhận; install/uninstall vẫn hoạt động.
- **Test bắt buộc:**
  - [ ] `httptest` cho cả hai endpoint với token/không token/Origin lạ.
  - [ ] Playwright: bấm nút → confirm → trạng thái đổi.

### S7 — [High] Clickjacking

- **Trạng thái:** `[ ]`
- **Bằng chứng:** response thực tế chỉ có `Cache-Control`, `ETag`, `Vary`,
  `Content-Type`; không `X-Frame-Options`/CSP.
- **Việc cần làm:**
  1. Thêm middleware headers (S15) với `X-Frame-Options: DENY` và
     `Content-Security-Policy: frame-ancestors 'none'`.
  2. Đảm bảo header có trên cả response lỗi và asset tĩnh.
- **Tiêu chí nghiệm thu:**
  - [ ] `curl -I /` và `/api/...` đều có hai header trên.
  - [ ] UI không bị nhúng trong iframe (kiểm tra thủ công/Playwright).
- **Test bắt buộc:**
  - [ ] `httptest` assert header.
  - [ ] Playwright smoke không bị CSP chặn.

### S8 — [High] Optimize: semaphore nhả khi goroutine còn chạy

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:39-109`; đặc biệt đọc 150 MB trước semaphore
  (`:46-62`), goroutine không context (`:72-90`), timeout 30 s (`:92-108`).
- **Nguyên nhân:** `defer <-optimizeSemaphore` chạy khi handler return, kể cả khi
  goroutine vẫn đang nén. Lặp request → nhiều goroutine giữ 150 MB + buffer.
- **Việc cần làm:**
  1. Lấy semaphore **trước** khi đọc body; giữ timeout 5 s và `r.Context().Done()`.
  2. Chuyển release vào `defer` **của goroutine**, không của handler:
     ```go
     go func() {
       defer func() { <-optimizeSemaphore }()
       defer recoverToResult(resCh)
       ...
     }()
     ```
  3. Khi handler timeout/disconnect, chỉ return; **không** release semaphore.
     Goroutine tự release khi xong.
  4. Dùng `resCh` buffered 1 để goroutine không block nếu handler đã return.
  5. Thêm `recover()` trong goroutine; pdfcpu có thể panic với PDF hỏng.
  6. Cân nhắc dùng temp file thay `bytes.Buffer` nếu đầu ra lớn; ghi rõ nếu để
     lại làm technical debt.
- **Tiêu chí nghiệm thu:**
  - [ ] Tối đa 3 optimize chạy đồng thời, kể cả khi client timeout.
  - [ ] Semaphore không được release trước khi goroutine kết thúc.
  - [ ] Request lặp không làm số goroutine tăng vô hạn.
  - [ ] PDF hỏng trả lỗi, không crash process.
- **Test bắt buộc:**
  - [ ] Refactor `optimizePDF` thành biến/hàm test hook; test slow optimizer:
        request timeout → `len(optimizeSemaphore)` vẫn 1 đến khi optimizer xong.
  - [ ] Test panic → response lỗi, process sống.
  - [ ] `go test -race`.

### S9 — [High] Convert Office: timeout xóa thư mục khi conversion còn chạy

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:232-387`; parse 150 MB trước semaphore (`:241-267`);
  ctx 120 s (`:322-337`); `defer os.RemoveAll(workDir)` (`:274`); server
  `WriteTimeout: 60s` (`:665-670`).
- **Nguyên nhân:** handler return khi timeout, cleanup chạy trong khi LibreOffice
  vẫn ghi; semaphore release sớm. Request lặp → nhiều process nặng.
- **Việc cần làm:**
  1. Lấy `convertSemaphore` trước `ParseMultipartForm`; giữ timeout 5 s.
  2. Thêm `ConvertOfficeToPdfContext(ctx, ...)` (giữ wrapper cũ cho CLI) và truyền
     `r.Context()` + timeout 120 s vào `exec.CommandContext`/COM.
  3. Gọi conversion **đồng bộ** trong handler (nó đã có timeout 110 s), hoặc nếu
     giữ goroutine thì phải chờ goroutine kết thúc trước khi return/cleanup.
  4. Đảm bảo thứ tự defer: `RemoveAll(workDir)` chạy **trước** khi release
     semaphore (đăng ký `RemoveAll` sau khi đã có `defer <-sem`).
  5. Căn timeout: server `ReadTimeout`/`WriteTimeout` ≥ 5 phút (S10) hoặc
     per-endpoint; handler timeout 120 s > conversion 110 s.
  6. Thêm `recover()` quanh conversion; không để panic giết process.
- **Tiêu chí nghiệm thu:**
  - [ ] Client ngắt/timeout → conversion dừng, workDir được xóa sau khi process
        kết thúc, semaphore release đúng lúc.
  - [ ] Không còn cảnh báo xóa file đang dùng trên Windows.
  - [ ] Tối đa 2 conversion đồng thời.
- **Test bắt buộc:**
  - [ ] Fake converter block; assert workDir còn tồn tại trong lúc chạy, bị xóa
        sau khi return, semaphore giữ đến cuối.
  - [ ] Test context cancellation dừng converter.
  - [ ] Playwright upload 1 và nhiều file (PDF/ZIP) vẫn đúng.

### S10 — [High] `/api/export/finalize` 512 MB vs timeout 60 s

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:120-127` (512 MB), `:665-670` (60 s).
- **Nguyên nhân:** upload/download lớn vượt Read/WriteTimeout; client nhận lỗi
  giữa chừng.
- **Việc cần làm:**
  1. Tăng `ReadTimeout`/`WriteTimeout` lên 5 phút (local app) hoặc dùng
     `http.Server` không set global timeout và kiểm soát bằng context từng handler.
     Giữ `ReadHeaderTimeout: 10s`, `IdleTimeout: 120s`.
  2. Kiểm tra `r.Context().Err()` trước khi ghi response; dùng `io.Copy` và xử lý
     lỗi ghi.
  3. Cân nhắc giảm giới hạn body nếu 512 MB không thực tế; nếu giữ, ghi rõ trong
     UI/docs.
- **Tiêu chí nghiệm thu:**
  - [ ] Export PDF ~100–300 MB thành công trong môi trường test (hoặc test giả
        lập với timeout).
  - [ ] Header `Content-Length` đúng; file tải về mở được.
- **Test bắt buộc:**
  - [ ] Go test với multipart lớn (có thể skip nếu quá nặng, nhưng phải có test
        timeout/header).
  - [ ] Playwright export flow hiện có vẫn pass.

### S11 — [Medium] Lộ đường dẫn + nội dung file ban đầu

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:477-517`: `/api/initial-file` trả `path` tuyệt đối;
  `/content` đọc cả file vào RAM không giới hạn.
- **Nguyên nhân:** endpoint không token; path là thông tin nhạy cảm; đọc cả file
  gây memory spike.
- **Việc cần làm:**
  1. Bỏ `"path"` khỏi JSON; chỉ trả `has_file`, `filename`, `size`.
  2. Thêm `consumeInitialFile()` atomic (lock, lấy path, set "") để hai request
     đồng thời không cùng đọc.
  3. `/content`: mở file, `Stat`, dùng `http.ServeContent` để stream + range;
     set `Content-Type: application/pdf`, `Content-Disposition: inline`, `no-store`.
     Không `os.ReadFile`.
  4. Yêu cầu token (S3); chỉ cho GET.
  5. Nếu file quá lớn (ví dụ > 2 GB), trả 413 thay vì stream? Ghi rõ ngưỡng.
- **Tiêu chí nghiệm thu:**
  - [ ] JSON không còn path tuyệt đối.
  - [ ] Request thứ hai sau khi consume → 404.
  - [ ] File lớn không làm tăng RAM tương ứng.
  - [ ] Không token → 403.
- **Test bắt buộc:**
  - [ ] `httptest` JSON schema, consume một lần, concurrent requests.
  - [ ] Test `Range` request trả 206 (nếu dùng ServeContent).

### S12 — [Medium] Mật khẩu trong argv

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `main.go:229,577,644,721-722,746` dùng `--password`,
  `--user-pw`, `--owner-pw`.
- **Nguyên nhân:** argv hiện trong Task Manager/process list, PowerShell history,
  log EDR.
- **Việc cần làm:**
  1. Thêm `--password-stdin` cho `info`, `text`, `bookmark`, `decrypt`.
  2. Thêm `--user-pw-stdin`, `--owner-pw-stdin` cho `encrypt`.
  3. Đọc một dòng từ stdin, trim `\r\n`, reject rỗng.
  4. Nếu cả flag thường và flag stdin được set → lỗi rõ ràng.
  5. Nếu không có flag và stdin là terminal, prompt bằng
     `golang.org/x/term.ReadPassword`; nếu không phải terminal, báo lỗi hướng dẫn.
  6. Giữ `--password` để tương thích; cập nhật help/README/HUONG-DAN, ghi rõ rủi
     ro argv.
- **Tiêu chí nghiệm thu:**
  - [ ] `echo pw | pdfcraft decrypt file.pdf --password-stdin` hoạt động.
  - [ ] `--password` cũ vẫn hoạt động.
  - [ ] Không log mật khẩu.
- **Test bắt buộc:**
  - [ ] Go test/CLI integration cho stdin; test conflict flag.
  - [ ] Kiểm tra help text có flag mới.

### S13 — [Medium] Office conversion không sandbox

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `go/pkg/pdfcraft/office.go:157-201` chạy LibreOffice với profile
  mặc định; `office_ms_windows.go` dùng COM (`AutomationSecurity=3`).
- **Nguyên nhân:** tài liệu Office untrusted có thể khai thác parser, macro,
  external links; LibreOffice dùng profile người dùng và có thể tái sử dụng
  instance.
- **Việc cần làm (best-effort, ghi rõ residual risk):**
  1. Tạo profile LibreOffice tạm cho mỗi batch:
     `-env:UserInstallation=file:///<temp-profile>` (dùng `url.URL` để encode
     đúng trên Windows).
  2. Thêm `--headless --norestore --nolockcheck --nodefault
     --nofirststartwizard`.
  3. Trong profile, đặt macro security mức cao nhất và tắt external link update
     (xác minh key thực tế của LibreOffice; ghi lại key đã dùng trong report).
  4. Với MS Office COM: đặt `AutomationSecurity=3`, `DisplayAlerts=0`,
     `AskToUpdateLinks=false`, `EnableEvents=false`, `Visible=false`; đóng
     document/app trong `defer`.
  5. Cảnh báo trong UI/README: chỉ chuyển đổi tài liệu tin cậy; sandbox đầy đủ
     (VM/container) là khuyến nghị cho tài liệu không tin cậy.
  6. Nếu có thể, chạy converter với token quyền thấp trên Windows; nếu quá phức
     tạp, ghi technical debt.
- **Tiêu chí nghiệm thu:**
  - [ ] Conversion docx/xlsx/pptx bình thường vẫn chạy.
  - [ ] Profile tạm được tạo/dọn; không dùng profile người dùng.
  - [ ] Macro trong tài liệu test không chạy (kiểm tra thủ công).
  - [ ] Docs có cảnh báo residual risk.
- **Test bắt buộc:**
  - [ ] Unit test args có `-env:UserInstallation` và các flag.
  - [ ] Integration test convert 3 định dạng (nếu môi trường có LibreOffice).
  - [ ] Manual: macro-enabled doc không thực thi.

### S14 — [Medium] `saveSafely` không fsync

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `document.go:819-851` ghi temp rồi rename; `copyFile`
  `:853-872` không `Sync`.
- **Nguyên nhân:** rename nguyên tử nhưng dữ liệu có thể chưa xuống đĩa; mất điện
  có thể để lại file 0 byte/hỏng dù rename đã xảy ra.
- **Việc cần làm:**
  1. Thêm `syncFile(path)` mở `O_RDWR`, gọi `f.Sync()`, đóng và trả lỗi.
  2. Trong `saveSafely`, gọi `syncFile(tempFile)` sau `writerFunc` và trước
     `os.Rename`.
  3. Trong `copyFile`, gọi `outF.Sync()` sau `io.CopyBuffer` trước `Close`; kiểm
     tra cả lỗi copy/close/sync.
  4. Directory sync: best-effort trên Unix; trên Windows bỏ qua nếu `Sync` thư
     mục không hỗ trợ, nhưng ghi chú.
- **Tiêu chí nghiệm thu:**
  - [ ] Mọi output đi qua `saveSafely` đều được sync trước rename.
  - [ ] `copyFile` sync đích và trả lỗi nếu sync thất bại.
  - [ ] Không thay đổi hành vi atomic rename.
- **Test bắt buộc:**
  - [ ] Go test `saveSafely` ghi file đúng, không còn temp.
  - [ ] Test `copyFile` nội dung đúng; nếu có thể, mock sync error.
  - [ ] `go test -race`.

### S15 — [Medium] Thiếu security headers

- **Trạng thái:** `[ ]`
- **Bằng chứng:** response thực tế không có `X-Content-Type-Options`,
  `X-Frame-Options`, CSP, `Referrer-Policy`.
- **Việc cần làm:**
  1. Middleware set:
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY`
     - `Referrer-Policy: no-referrer`
     - `Cross-Origin-Resource-Policy: same-origin`
     - `Cross-Origin-Opener-Policy: same-origin`
     - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
     - `Content-Security-Policy: default-src 'self'; script-src 'self';
       style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
       font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;
       media-src 'self' blob:; object-src 'none'; base-uri 'none';
       form-action 'self'; frame-ancestors 'none'`
  2. Nếu CSP chặn flow nào, điều chỉnh tối thiểu; tuyệt đối không thêm
     `script-src 'unsafe-inline'`/`'unsafe-eval'` nếu chưa có lý do và ghi chú.
  3. Header phải có trên response lỗi và asset tĩnh.
- **Tiêu chí nghiệm thu:**
  - [ ] `curl -I` thấy đủ header.
  - [ ] Playwright không có CSP violation; mọi flow chạy.
  - [ ] pdf.js worker/blob vẫn hoạt động.
- **Test bắt buộc:**
  - [ ] `httptest` assert header.
  - [ ] Playwright full suite; theo dõi console `securitypolicyviolation`.

### S16 — [Medium] Project JSON không giới hạn/validate

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `web/app.js:1414-1503`; `file.text()` không kiểm tra size;
  `pageIndex/source/rotation/stamps` không validate; state bị xóa trước khi load
  xong.
- **Nguyên nhân:** file project untrusted; lỗi giữa chừng để lại state nửa vời;
  file lớn gây treo tab.
- **Việc cần làm:**
  1. Kiểm tra `file.size` trước `file.text()`; ngưỡng hợp lý (ví dụ 512 MB) và
     thông báo rõ.
  2. Dùng validator của S4; validate toàn bộ trước khi mutate state.
  3. Load sources/pages vào cấu trúc tạm; nếu bất kỳ source/pdf page nào lỗi,
     abort và giữ nguyên project hiện tại.
  4. Kiểm tra `pageIndex < numPages` sau khi mở source; reject/limiting có test.
  5. Giới hạn `docMeta` string; bỏ key lạ.
- **Tiêu chí nghiệm thu:**
  - [ ] JSON sai/siêu lớn → toast lỗi, state cũ nguyên vẹn.
  - [ ] `pageIndex`/`source` ngoài phạm vi không làm crash.
  - [ ] Project hợp lệ vẫn load đủ.
- **Test bắt buộc:**
  - [ ] Node unit test validator (dùng chung S4).
  - [ ] Playwright: invalid JSON, out-of-range index, oversized file (mock
        `File.size`), project hợp lệ.

### S17 — [Medium] Shutdown bằng `os.Exit(0)` giết request đang chạy

- **Trạng thái:** `[ ]`
- **Bằng chứng:** `server.go:469-473`, `:691-696`, `:699-707`.
- **Nguyên nhân:** `os.Exit` bỏ qua `server.Shutdown`, kill handler/cleanup.
- **Việc cần làm:**
  1. Tạo `shutdownCh := make(chan struct{}, 1)` và `requestShutdown()`.
  2. API shutdown (S2), signal handler, console Enter/Q đều gọi `requestShutdown()`.
  3. Chạy `server.Serve` trong goroutine; main `select` giữa serve error và
     shutdownCh.
  4. Khi shutdown: `ctx, cancel := context.WithTimeout(context.Background(), 15s)`;
     `server.Shutdown(ctx)`; nếu lỗi → `server.Close()` và log.
  5. Không `os.Exit` trong handler/goroutine; để `runUI` return bình thường.
- **Tiêu chí nghiệm thu:**
  - [ ] Request optimize/convert đang chạy có cơ hội hoàn tất (hoặc bị cancel có
        kiểm soát) trước khi process thoát.
  - [ ] Ctrl+C, Enter/Q, nút thoát đều dùng cùng đường graceful.
  - [ ] Không còn `os.Exit` trong các đường shutdown.
- **Test bắt buộc:**
  - [ ] Test `server.Shutdown` với handler block 1 s; assert hoàn tất.
  - [ ] Manual: convert file lớn rồi shutdown; không thấy file tạm rác.
  - [ ] `go test -race`.

---

## 4. Ma trận kiểm thử tối thiểu

| Lệnh | Kỳ vọng |
| :--- | :--- |
| `cd go && gofmt -l .` | không output |
| `cd go && go vet ./...` | pass |
| `cd go && go test -race ./...` | pass |
| `cd go && go build ./...` | pass |
| `cd go && GOOS=windows GOARCH=amd64 go build ./...` | pass (nếu chạy trên non-Windows) |
| `cd go && govulncheck ./...` | 0 vulnerability trong code gọi tới |
| `python scripts/sync_web.py --check` | OK, 11 files in sync |
| `node --test web/tests/utils.test.js` | pass, gồm test validator mới |
| `cd web && npx playwright test` | pass toàn bộ, không CSP violation |
| `curl -I http://127.0.0.1:<port>/` | có security headers |
| `curl -H "Host: evil.example:<port>" ...` | 403/421 |
| `curl -X POST .../api/shutdown` (không token) | 401/403 |

---

## 5. Definition of Done

Một issue chỉ được đánh dấu `[x]` khi:

- [ ] Code đã sửa đúng nguyên nhân, không chỉ che triệu chứng.
- [ ] Có test hồi quy (unit/integration/E2E tùy mức).
- [ ] Test mới chạy pass cùng toàn bộ suite liên quan.
- [ ] `python scripts/sync_web.py` đã chạy; hai bản web khớp.
- [ ] Không có regression UI/CLI.
- [ ] Tài liệu/help/README được cập nhật nếu hành vi thay đổi.
- [ ] Commit message rõ issue ID.
- [ ] Kết quả được ghi vào `docs/SECURITY-FIX-REPORT.md`.

---

## 6. Commit & PR

- Base branch: `audit/security-checklist-2026-11` (nhánh chứa checklist này và
  snapshot UI hiện tại).
- Fix branch gợi ý: `fix/security-audit-2026-11`.
- Mỗi commit:
  - `fix(security): S1 prevent same-file move data loss`
  - `feat(security): S3 add session token and Host/Origin validation`
  - `fix(security): S2/S17 authenticate and graceful shutdown`
  - …
- PR mô tả: danh sách issue, test đã chạy, residual risk, ảnh hưởng UI.
- Không force-push lên `main`; không commit binary/build output.

---

## 7. Residual risk / ngoài phạm vi

- Sandbox đầy đủ cho LibreOffice/MS Office (VM/container) không nằm trong đợt này;
  S13 chỉ hardening best-effort.
- Nếu chưa nâng pdf.js, CVE-2024-4367 được mitigate bằng `isEvalSupported:false`
  nhưng vẫn là technical debt.
- Người dùng chạy tài khoản admin: mọi lỗi registry/Office đều có tác động lớn
  hơn; khuyến nghị chạy tài khoản thường.
- Token trong HTML không chống được XSS cùng origin; S4/S5/S15 phải làm cùng.
- File PDF/Office cực lớn vẫn có thể gây tốn RAM/CPU; giới hạn hiện tại là 150 MB
  upload và 512 MB export.
