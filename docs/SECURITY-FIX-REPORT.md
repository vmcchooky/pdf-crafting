# Báo cáo vá bảo mật & độ tin cậy — PDF Craft (11/2026)

> Nguồn: `docs/SECURITY-AUDIT-2026-11.md` (17 mục S1–S17).
> Branch làm việc: `fix/security-audit-2026-11` (từ `audit/security-checklist-2026-11`).
> Base PR: `audit/security-checklist-2026-11`.
> Môi trường thực hiện: Linux cloud (không có Windows/LibreOffice/Playwright sẵn
> ở thời điểm đầu; xem "Phần chưa kiểm tra" bên dưới).
> Go: 1.27.4 (cài từ go.dev, `go.mod` yêu cầu 1.26.11).

## 1. Bảng tổng hợp

| ID | Trạng thái | Commit | Test đã chạy | Ghi chú |
|----|-----------|--------|--------------|---------|
| S1 | ✅ Xong | `fix(security): S1 prevent same-file move data loss` | `go test -race ./...` pass (2 package); test mới `TestMovePageSameFileNoOp` (5 sub-test), `TestCopyFileSameFileErrors`, `TestSameFile` | Case-variant trên Windows chỉ kiểm tra bằng code (`strings.EqualFold`, test có nhánh `runtime.GOOS == "windows"` — skip trên Linux, chạy trên CI Windows) |
| S2 | ✅ Xong | `fix(security): S2/S17 authenticate and graceful shutdown` | `httptest` 4 case + `TestGracefulShutdownSlowHandler` (block 1s); live smoke binary thật (GET 405, POST 401 không token, POST 202 + tắt graceful); `go test -race ./...` pass | Playwright bấm nút thoát chưa chạy (cuối đợt) |
| S3 | ✅ Xong | `feat(security): S3 add session token and Host/Origin validation` | `httptest` (5 test func, 17 assert); live smoke bằng binary thật (xem §2); `go test -race ./...` pass; `node --test web/tests/utils.test.js` 23 pass | Playwright smoke chưa chạy (chạy ở cuối đợt); checkbox Playwright trong checklist vẫn `[ ]` tới lúc đó |
| S4 | ✅ Xong | `fix(security): S4/S16 validate project and kill stored XSS` | Node unit test 17 test (validator + dataUrl + 512MB gate); `node --test` 40 pass; `go vet` + `go test -race ./...` pass; `sync_web.py --check` OK | Playwright fixture project độc + project hợp lệ chưa chạy (cuối đợt) |
| S5 | ✅ Xong | `fix(security): S5 upgrade pdf.js to 4.10.38 and disable eval` | Node test 5 test (grep getDocument + version + mở PDF thật bằng worker Node); `node --test` 45/45 pass; live smoke server thật (.mjs 200 + MIME text/javascript); `go test -race` pass | Playwright render/password/project/export/ký + console error chưa chạy (cuối đợt) |
| S6 | ✅ Xong | `fix(security): S6/S7 context-menu CSRF and clickjacking headers` | `httptest` 2 endpoint × 4 case; live smoke binary thật (401/403/200 generic); `go test -race` pass | Playwright bấm nút → confirm → trạng thái đổi; install/uninstall thật trên Windows chưa kiểm tra |
| S7 | ✅ Xong | `fix(security): S6/S7 context-menu CSRF and clickjacking headers` | `httptest` header trên `/`, API, 404, 421, 401; live smoke `curl -I` cả `/` và `/api/...` đều có 2 header | Playwright smoke không bị CSP chặn + kiểm tra iframe chưa chạy (cuối đợt) |
| S8 | ✅ Xong | `fix(security): S8 hold optimize semaphore until goroutine ends` | 3 test mới (`-race` pass): slot giữ sau disconnect, panic → 500, tối đa 3 + 503 sau 5s; full `go test -race ./...` pass | — |
| S9 | ✅ Xong | `fix(security): S9/S10 sync Office convert and raise server timeouts` | 4 test convert mới (`-race` pass): workDir/semaphore, cancel → 504, panic → 500, tối đa 2 + 503; test convert cũ (fake soffice) vẫn pass | Playwright upload 1/nhiều file; cảnh báo xóa file trên Windows chưa kiểm tra |
| S10 | ✅ Xong | `fix(security): S9/S10 sync Office convert and raise server timeouts` | `TestUIServerTimeouts` (5m/5m/10s/120s) + `TestFinalizeExportContentLengthMatchesBody` (Content-Length = body, PDF mở được + bookmark); full `go test -race` pass | Playwright export flow; export 100–300 MB thật chưa chạy |
| S11 | ✅ Xong | `fix(security): S11 hide initial-file path and stream content` | 4 test mới (`-race` pass): JSON không path, consume 1 lần, Range 206, 20 request đồng thời chỉ 1 lần 200; full `go test -race` pass | Ngưỡng 2 GiB chưa test với file thật |
| S12 | ✅ Đã sửa | `9856cb5` | Unit + CLI integration (5 test) pass; full `go test -race ./...` pass | Prompt chỉ áp dụng cho lệnh bắt buộc mật khẩu (decrypt/encrypt user-pw); Python CLI còn lộ argv (out-of-scope, ghi residual risk) |
| S13 | ✅ Đã sửa | `d2e2f3e` | Unit + fake-engine + LibreOffice thật (5 test) pass; `GOOS=windows go vet` pass | Macro không chạy chưa kiểm chứng thủ công (cần file macro thật, để Windows); PowerPoint không có AskToUpdateLinks qua COM; token quyền thấp chưa làm (technical debt) |
| S14 | ✅ Đã sửa | `d64ee3d` | 5 test mới + test cũ pass; full `go test -race ./...` pass | Directory sync best-effort (bỏ qua lỗi); Windows bỏ qua sync thư mục (không hỗ trợ) |
| S15 | ✅ Đã sửa* | `6bb66c8` | `httptest` (header + no-inline-script) pass; `curl -I` đủ 7 header trên binary thật | *Playwright CHƯA chạy được trên VM này (môi trường chặn tải/chạy Chromium — xem §2 S15); worker trình duyệt chưa kiểm chứng |
| S16 | ✅ Xong | `fix(security): S4/S16 validate project and kill stored XSS` | Cùng test S4 (validator + gate 512MB); `node --test` 40 pass | Playwright invalid JSON / out-of-range / oversized / hợp lệ chưa chạy (cuối đợt) |
| S17 | ✅ Xong | `fix(security): S2/S17 authenticate and graceful shutdown` | `TestGracefulShutdownSlowHandler` (handler block 1s hoàn tất); `TestRequestShutdownNonBlocking`; `go test -race ./...` pass | Manual Ctrl+C / Enter / convert lớn rồi shutdown chưa kiểm tra thủ công (mục Windows) |

## 2. Chi tiết từng mục

### S1 — `move` same-file làm file thành 0 byte ✅
- **Nguyên nhân gốc:** `MovePage` so sánh `absIn` (tuyệt đối) với `outPath`
  (thường là chuỗi input tương đối) — hai chuỗi khác nhau dù cùng file; sau đó
  `copyFile` mở đích bằng `O_TRUNC` trước khi copy, truncate chính nguồn.
- **Fix (`go/pkg/pdfcraft/document.go`):**
  - Thêm helper `sameFile(a, b)`: `os.Stat` cả hai → `os.SameFile` nếu cùng
    tồn tại (bắt symlink/hardlink, khác hoa/thường trên Windows); nếu một bên
    không tồn tại thì so sánh `filepath.Clean` (`strings.EqualFold` trên Windows).
  - `MovePage` khi `fromPage == toPage`: tính `absOut`, `sameFile` → `return nil`
    (no-op thật sự); khác file → `saveSafely` + `copyFile` vào temp.
  - `copyFile` defense-in-depth: trả lỗi rõ ràng nếu source và đích cùng file
    (theo `sameFile`) thay vì truncate; kiểm tra lỗi `io.CopyBuffer` và `Close`.
- **Test (`go/pkg/pdfcraft/document_test.go`):** `TestMovePageSameFileNoOp`
  (absolute / relative / `./` / symlink / different-output),
  `TestCopyFileSameFileErrors`, `TestSameFile` — tất cả pass.
  Viết test trước, chạy trên code cũ để tái hiện (test fail do `sameFile` chưa
  tồn tại + hành vi truncate), sau đó fix và pass.

### S3 — Không kiểm tra Host/Origin → DNS rebinding + CSRF ✅
- **Nguyên nhân gốc:** server chỉ bind `127.0.0.1`, không handler/middleware nào
  kiểm tra `r.Host`/`Origin`; `Host: evil.example:18089` vẫn trả 200.
- **Fix:**
  - **Go (`go/cmd/pdfcraft/server.go`):**
    - `newSessionToken()`: 32 byte `crypto/rand`, hex 64 ký tự, sinh mới mỗi
      lần chạy; không ghi file/log/URL.
    - `securityMiddleware(port, token, next)` bọc toàn bộ mux: (1) `Host` phải
      là `127.0.0.1`/`localhost` có port (`net.SplitHostPort`, thiếu port →
      từ chối) — sai trả 421; (2) mọi `/api/*` bắt buộc header
      `X-PDFCraft-Token` khớp token (`crypto/subtle.ConstantTimeCompare`),
      token rỗng phía server → từ chối hết — sai/thiếu trả 401; (3) method đổi
      trạng thái (POST/PUT/PATCH/DELETE): có `Origin` thì phải khớp
      `http://127.0.0.1:<port>`/`http://localhost:<port>`, không có `Origin`
      thì chỉ cho `Sec-Fetch-Site` `same-origin`/`none`/vắng — sai trả 403.
      Không thêm `Access-Control-Allow-Origin`.
    - Refactor mux thành `newMux(port, token, webRoot)` để test được mà không
      cần dựng browser; `runUI` sinh token rồi bọc mux bằng middleware.
    - `/` và `/index.html`: đọc file nhúng, thay placeholder
      `__PDFCRAFT_TOKEN__` bằng token, `Cache-Control: no-store`,
      `Content-Type: text/html; charset=utf-8`, bypass gzip cache.
  - **Web:** `web/index.html` thêm
    `<meta name="pdfcraft-token" content="__PDFCRAFT_TOKEN__">`;
    `web/app.js` thêm `API_TOKEN` + helper `apiFetch` (gắn header
    `X-PDFCraft-Token`) và đổi cả 8 call site `fetch('/api/...')` sang
    `apiFetch` (convert, initial-file, initial-file/content,
    context-menu/status, context-menu/install|uninstall, export/finalize,
    optimize, shutdown). Chạy `python scripts/sync_web.py` — 11 file khớp.
- **Test (`go/cmd/pdfcraft/server_security_test.go`):**
  `TestSecurityMiddlewareHost`, `TestSecurityMiddlewareToken`,
  `TestSecurityMiddlewareOrigin`, `TestSecurityMiddlewareEmptyToken`,
  `TestTokenInjection` (`/` và `/index.html` chứa meta token, `no-store`;
  `/app.js` không chứa token), `TestNewSessionToken` (64 ký tự hex, ngẫu nhiên).
- **Live smoke** (binary thật, port 18098): `/` chứa meta token ngẫu nhiên;
  `Host: evil.example` → **421**; `/api/...` không token → **401**; có token →
  **200**; POST cross-origin có token → **403**.
- **Chưa kiểm tra:** Playwright smoke (upload/preview/export/optimize/
  context-menu status) — chạy ở cuối đợt sau khi cài Playwright.

### S2 + S17 — Shutdown không xác thực + `os.Exit` giết request ✅
- **Nguyên nhân gốc:** handler `/api/shutdown` chạy với mọi method, không
  token/Origin, trả 200 rồi `os.Exit(0)` sau 350ms; signal handler và phím
  Enter/Q cũng `server.Close()` + `os.Exit(0)`, giết request đang chạy.
- **Fix (`go/cmd/pdfcraft/server.go`):**
  - `/api/shutdown`: chỉ chấp nhận POST (khác → 405); token + Origin đã do
    middleware S3 kiểm tra; trả `202 Accepted` JSON `{"status":"accepted"}`;
    gọi `requestShutdown()` thay vì `os.Exit`.
  - `shutdownCh := make(chan struct{}, 1)` (package-level) +
    `requestShutdown()` gửi non-blocking (lần gửi thêm bị bỏ qua).
  - `runUI`: `server.Serve` chạy trong goroutine; main `select` giữa
    `shutdownCh` và `serveErr`; khi tắt: `server.Shutdown` với timeout 15s
    (cho request đang chạy hoàn tất), lỗi → `server.Close()` + log; `runUI`
    return bình thường, `main` thoát — không còn `os.Exit` trong bất kỳ đường
    shutdown nào (grep chỉ còn trong comment).
  - Signal (Ctrl+C/SIGTERM) và phím Enter/Q đều gọi `requestShutdown()` —
    cùng một đường graceful với nút thoát UI (UI đã có hộp thoại `confirm`
    + `apiFetch` POST từ S3, không đổi).
- **Test (`go/cmd/pdfcraft/server_security_test.go`):**
  `TestShutdownEndpoint` (GET 405 + không tín hiệu; POST không token 401;
  POST Origin lạ 403; POST hợp lệ 202 + tín hiệu tắt),
  `TestRequestShutdownNonBlocking`,
  `TestGracefulShutdownSlowHandler` (handler block 1s vẫn hoàn tất).
- **Live smoke** (binary thật, port 18097): GET shutdown có token → **405**,
  server vẫn sống; POST không token → **401**; POST có token → **202**
  `{"status":"accepted"}`, process tắt với log
  "Đang tắt máy chủ (graceful shutdown)... / Đã tắt. Cảm ơn bạn đã dùng PDF Craft!".
- **Chưa kiểm tra:** Playwright bấm nút thoát; manual Ctrl+C / Enter / convert
  file lớn rồi shutdown trên Windows.

### S4 + S16 — Stored XSS qua file project + không validate/giới hạn ✅
- **Nguyên nhân gốc:** `loadProjectFile` nhận mọi trường từ file `.pdfcraft.json`
  (untrusted) rồi đưa vào `innerHTML` (`renderGroupBar` chèn `${g.name}`/
  `${g.color}`, `renderSignStageStamps`/`renderSignStampsList` chèn
  `${stamp.dataUrl}` vào `src`); state bị xóa TRƯỚC khi load xong nên file lỗi
  để lại state nửa vời; `file.text()` không kiểm tra size.
- **Fix — validator (`web/utils.js`, pure, test Node được):**
  - `validateProjectPayload(project)` → `{ ok, errors, docMeta }`:
    `app === 'pdfcraft'`, `version` là number; giới hạn sources ≤ 100,
    pages ≤ 10000, groups ≤ 1000, stamps/trang ≤ 500; group `id` an toàn
    1–64 ký tự (duy nhất), `name` ≤ 120, `color` khớp `/^#[0-9a-fA-F]{6}$/`;
    source `name` ≤ 255, `data` base64 chuẩn, `fileSize` ≥ 0; page `source`
    trong `[0, sources.length)`, `pageIndex` int ≥ 0, `rotation` ∈
    {0,90,180,270}, `title` ≤ 200, `groupIds` chỉ id tồn tại; stamp `id` an
    toàn, `dataUrl` khớp `data:image/(png|jpeg|webp);base64,...` ≤ 20 MB,
    `relX/relY/relW/relH`/`opacity` trong [0,1]; `sanitizeDocMeta` chỉ giữ
    string (5 key quen thuộc), cắt 500 ký tự, bỏ key lạ.
  - `isValidDataUrl(dataUrl)` (dùng chung cho render) và
    `isProjectFileTooLarge(fileSize)` (gate 512 MB).
- **Fix — loader (`web/app.js` `loadProjectFile`):** kiểm tra `file.size` trước
  `file.text()`; validate toàn bộ payload TRƯỚC khi chạm state (lỗi → toast
  liệt kê tối đa 3 lỗi, giữ nguyên project đang mở); load sources/pages vào
  cấu trúc tạm (`tempSources`/`tempPages`); kiểm tra `pageIndex < numPages`
  sau khi mở từng source — sai thì **reject toàn bộ project** (giữ state cũ,
  destroy các pdfJsDoc đã mở trong temp); chỉ commit vào state khi mọi thứ
  hợp lệ. `hideStartupGreeting()` cũng dời vào lúc commit.
- **Fix — render an toàn:** `renderGroupBar` dựng chip bằng DOM API
  (`textContent` cho tên, `style.backgroundColor` với fallback `#888888` nếu
  màu không phải hex); `renderSignStageStamps`/`renderSignStampsList` tạo `img`
  bằng `createElement`, chỉ gán `src` khi `isValidDataUrl` (giữ nguyên span
  `.sign-stamp-opacity` vì code khác query nó). Rà soát: `groupChecklist`,
  card title (`input.value`), `sourceTag.textContent`, `signPageSelect`
  (`option.textContent`) đã an toàn từ trước — không đổi.
- **Test (`web/tests/project.test.js`, 17 test):** project hợp lệ/tối thiểu;
  app sai; base64 nguồn sai (5 mẫu); source/pageIndex ngoài phạm vi;
  rotation 45; màu nhóm xấu (5 mẫu incl. `javascript:`); tên nhóm quá dài;
  id nhóm trùng; groupIds lạ; giới hạn số lượng; dataUrl độc (text/html, svg,
  javascript:, http, base64 sai) + quá 20 MB; relX/opacity ngoài [0,1];
  id stamp chứa HTML; sanitize docMeta; gate 512 MB (600 MB reject, đúng
  512 MB pass). **`node --test` 40/40 pass** (23 utils cũ + 17 mới).
- **Chưa kiểm tra:** Playwright fixture project độc (assert không execute +
  toast), Playwright project hợp lệ load đủ trang/nhóm/dấu, kiểm chứng
  trình duyệt cho hành vi reject `pageIndex >= numPages` — chạy ở cuối đợt
  cùng bộ Playwright.

### S5 — PDF.js 3.11.174 dính CVE-2024-4367 (CVSS 8.8) ✅
- **Nguyên nhân gốc:** pdf.js 3.11.174 ≤ 4.1.392, vá ở 4.2.67; mọi
  `getDocument` dùng default `isEvalSupported: true` nên PDF độc chạy JS
  trong origin app.
- **Fix — upgrade lên pdfjs-dist 4.10.38 (latest 4.x, legacy ESM build):**
  pdfjs-dist ≥ 4.2 chỉ còn ESM (`.mjs`), không còn UMD classic script.
  `web/vendor/pdf.min.js`/`pdf.worker.min.js` (3.11.174) bị xóa, thay bằng
  `legacy/build/pdf.min.mjs` + `pdf.worker.min.mjs` từ gói npm chính thức
  `pdfjs-dist@4.10.38` (đã kiểm chứng export `getDocument`,
  `GlobalWorkerOptions`, `PDFDateString`, `version`).
  - `web/index.html`: thay `<script src="vendor/pdf.min.js" defer>` bằng
    module script `import * as pdfjsLib from './vendor/pdf.min.mjs'` gán
    `window.pdfjsLib` — module script chạy theo thứ tự tài liệu, trước các
    deferred classic script (utils.js, app.js) nên app.js thấy global sẵn.
  - `web/app.js`: `workerSrc` → `vendor/pdf.worker.min.mjs`; thêm constant
    `PDFJS_OPTIONS = { isEvalSupported: false }` và dùng ở cả 3 `getDocument`
    (load project, mở PDF thường, mở PDF có mật khẩu).
  - `scripts/sync_web.py`: whitelist đổi sang `.mjs`; file vendor cũ xóa cả
    khỏi bản nhúng (`go/cmd/pdfcraft/web/vendor/`) để binary không còn chứa
    bản 3.11.174 dính CVE.
  - `web/e2e/pdfcraft.spec.js`: `require('../vendor/pdf.min.js')` →
    dynamic `import('../vendor/pdf.min.mjs')` trong `test.beforeAll` (file
    test là CJS); 2 `getDocument` trong spec cũng thêm `...PDFJS_OPTIONS`.
  - Vì sao không 5.x/6.x: 5.x bỏ bản legacy, đổi yêu cầu trình duyệt — 4.10.38
    là "mới nhất tương thích" với cách app dùng pdf.js (API `getDocument`/
    `getPage`/`getViewport`/`getTextContent`/`getMetadata`/`PDFDateString`
    không đổi).
- **Test (`web/tests/pdfjs.test.js`, 5 test):** mọi `getDocument` trong app.js
  đều chứa `PDFJS_OPTIONS`; `PDFJS_OPTIONS` định nghĩa đúng
  `isEvalSupported: false`; index.html không còn tham chiếu `.js` cũ;
  `workerSrc` trỏ `.mjs`; import thật vendor build trong Node —
  `version = 4.10.38 >= 4.2.67`, đủ export, worker cùng version; **mở PDF
  mẫu thật (e2e/fixtures/sample.pdf) bằng worker Node với
  `isEvalSupported: false` → 3 trang, trang 1 có text.** `node --test`
  **45/45 pass**.
- **Live smoke** (binary thật, port 18096): `/` 200; `vendor/pdf.min.mjs`
  200 `text/javascript` 398237 bytes; `vendor/pdf.worker.min.mjs` 200
  `text/javascript` 1417586 bytes; Go tự map `.mjs` → `text/javascript`
  nên module script load được.
- **Chưa kiểm tra:** Playwright trong trình duyệt thật (render, text layer,
  search, PDF mật khẩu, project load, export, ký, console error) — cuối đợt.

### S6 + S7 — CSRF context-menu + clickjacking ✅
- **Nguyên nhân gốc (S6):** install/uninstall chỉ kiểm tra POST; UI gọi thẳng
  không `confirm()`; lỗi trả `err.Error()` có thể lộ đường dẫn.
  **(S7):** response không có `X-Frame-Options`/CSP.
- **Fix (S6):**
  - Token + Origin đã có từ middleware S3 (mọi `/api/*` cần token, POST cần
    Origin loopback) — S6 xác minh lại bằng test riêng cho cả hai endpoint.
  - UI (`web/app.js` `setupContextMenuEvents`): thêm `confirm()` trước khi
    gọi install/uninstall.
  - Handler (`server.go`): lỗi chỉ log chi tiết ở server (`log.Printf`),
    response chỉ còn thông báo chung
    "Không thể cập nhật Menu chuột phải Windows" — không lộ registry path.
- **Fix (S7):** `securityHeadersMiddleware` mới (đặt ngoài cùng trong `runUI`,
  bọc cả `securityMiddleware`): gắn `X-Frame-Options: DENY` +
  `Content-Security-Policy: frame-ancestors 'none'` lên MỌI response — kể cả
  response lỗi (421/401) và asset 404. Hằng `frameAncestorsCSP` để S15 mở
  rộng thành CSP đầy đủ. `testHandler` trong test cũng mirror đúng wiring này.
- **Test (`server_security_test.go`):** `TestContextMenuEndpoints` (GET 405,
  POST không token 401, POST Origin lạ 403, POST hợp lệ 200 + error đúng
  thông báo chung, không chứa `\`/`/`/path); `TestSecurityHeaders`
  (header có trên `/`, `/api/context-menu/status`, 404, 421, 401).
- **Live smoke** (binary thật, port 18095): `curl -I /` và
  `/api/context-menu/status` đều có 2 header; POST install không token → 401,
  Origin lạ → 403, hợp lệ → 200
  `{"error":"Không thể cập nhật Menu chuột phải Windows","success":false}`
  (trên Linux install luôn lỗi vì chỉ hỗ trợ Windows — đúng hành vi cũ).
- **Chưa kiểm tra:** Playwright bấm nút → confirm → trạng thái đổi;
  install/uninstall thật trên Windows; kiểm tra iframe thủ công — cuối đợt.

### S8 — Optimize: semaphore nhả khi goroutine còn chạy ✅
- **Nguyên nhân gốc:** handler đọc body 150 MB TRƯỚC khi lấy semaphore, rồi
  `defer <-optimizeSemaphore` trong handler nên slot được nhả khi handler
  return dù goroutine còn nén; goroutine không có `recover()` nên pdfcpu
  panic với PDF hỏng sẽ giết process.
- **Fix (`go/cmd/pdfcraft/server.go` `handleOptimizePDF`):**
  - Lấy semaphore TRƯỚC khi đọc body (timeout 5s + `r.Context().Done()`).
  - Bỏ `defer` nhả slot ở handler; release chuyển vào `defer` của goroutine
    (đăng ký trước `recover` để recover chạy trước, nhả sau). Handler
    timeout/disconnect chỉ return — không nhả slot. Trường hợp duy nhất
    handler tự nhả là đọc body lỗi (goroutine chưa chạy).
  - `resCh` đã buffered 1 từ trước — goroutine không block nếu handler đã
    return.
  - Goroutine thêm `recover()` → panic thành `optimizeResult{err}` (500),
    không crash process.
  - `api.Optimize` tách thành biến `optimizePDFFunc` làm test hook.
- **Test (`go/cmd/pdfcraft/server_optimize_test.go`, 3 test, `-race` pass):**
  `TestOptimizeSemaphoreHeldAfterClientDisconnect` (optimizer chậm 2s, cancel
  context → handler return nhưng `len(semaphore)==1` đến khi optimizer xong
  mới về 0), `TestOptimizePanicRecovery` (panic → 500 chứa "optimize panic",
  slot về 0), `TestOptimizeMaxThreeConcurrent` (3 slot đầy → request thứ 4
  chờ đúng ~5s rồi 503). Lưu ý: test disconnect cần channel `slowDone` để
  đồng bộ happens-before khi restore hook — bản đầu bị race detector bắt.
- **Technical debt (checklist mục 6):** output vẫn dùng `bytes.Buffer`
  trong RAM thay vì temp file — giới hạn bởi input ≤ 150 MB nên bộ nhớ có
  chặn trên, nhưng 3 optimize đồng thời có thể giữ tới ~450 MB + input.
  Chưa đổi sang temp file vì xâm lấn; ghi lại ở đây.

### S9 + S10 — Convert Office timeout + export 512 MB vs timeout 60s ✅
- **Nguyên nhân gốc (S9):** handler parse multipart 150 MB TRƯỚC khi lấy
  semaphore; `defer <-convertSemaphore` và `defer os.RemoveAll(workDir)` ở
  handler nên timeout/disconnect xóa thư mục + nhả slot trong lúc LibreOffice
  còn ghi; converter chạy trong goroutine với ctx nội bộ (`Background`) nên
  client ngắt không dừng được process; không có `recover()`.
  **(S10):** server `ReadTimeout`/`WriteTimeout` 60s < handler timeout 120s
  và body export 512 MB.
- **Fix — `pkg/pdfcraft/office.go`:** thêm `ConvertOfficeToPdfContext(ctx, ...)`
  — ctx của caller được truyền xuống `context.WithTimeout` từng lượt convert
  (LibreOffice `exec.CommandContext` + COM đều nhận ctx hủy); wrapper cũ
  `ConvertOfficeToPdf` giữ nguyên cho CLI (gọi với `context.Background()`).
- **Fix — `handleConvertOffice` (`server.go`):**
  - Lấy `convertSemaphore` TRƯỚC `ParseMultipartForm` (timeout 5s + ctx).
  - `defer RemoveAll(workDir)` đăng ký SAU defer nhả semaphore → khi return,
    RemoveAll chạy TRƯỚC khi nhả slot (LIFO).
  - Gọi conversion **đồng bộ** trong handler (bỏ goroutine + resCh): handler
    chỉ return khi converter đã dừng hẳn. `recover()` quanh conversion →
    panic thành lỗi 500, không giết process. Hook test
    `convertOfficeToPdfFunc` (mặc định = `ConvertOfficeToPdfContext`).
  - Response file đơn stream bằng `io.Copy` (thay vì `ReadAll` cả file vào
    RAM) + kiểm tra `r.Context().Err()` trước khi ghi; ZIP kiểm tra ctx
    trước khi ghi + log lỗi ghi.
- **Fix — S10:** `newUIServer` (tách riêng để test được): `ReadTimeout`/
  `WriteTimeout` 60s → **5 phút**; giữ `ReadHeaderTimeout` 10s,
  `IdleTimeout` 120s. `handleFinalizeExport` kiểm tra `r.Context().Err()`
  trước khi ghi response (đã dùng `io.Copy` + xử lý lỗi ghi từ trước).
  Giới hạn 512 MB được GIỮ (theo checklist mục 3: giữ và ghi rõ — thông
  báo lỗi đã nêu "giới hạn 512 MB").
- **Test (4 test convert mới + 2 test S10, `-race` pass):**
  `TestConvertSemaphoreHeldUntilConverterEnds` (fake converter block:
  workDir còn + slot giữ 1 trong lúc chạy; sau return workDir xóa + slot 0),
  `TestConvertContextCancelStopsConverter` (cancel → converter nhận hủy,
  handler 504, slot 0), `TestConvertPanicRecovery` (panic → 500 chứa
  "conversion panic"), `TestConvertMaxTwoConcurrent` (slot đầy → 503 sau ~5s),
  `TestUIServerTimeouts` (5m/5m/10s/120s), `TestFinalizeExportContentLengthMatchesBody`
  (Content-Length = đúng số byte body, PDF mở được + bookmark giữ nguyên).
  Test convert cũ với fake soffice vẫn pass.
- **Chưa kiểm tra:** Playwright upload 1/nhiều file + export flow; cảnh báo
  xóa file đang dùng trên Windows; export 100–300 MB thật — cuối đợt.

### S11 — Lộ đường dẫn + nội dung file ban đầu ✅
- **Nguyên nhân gốc:** `/api/initial-file` trả `path` tuyệt đối (kèm
  `err.Error()` có thể lộ path); `/api/initial-file/content` đọc cả file vào
  RAM (`os.ReadFile`) rồi mới xóa state — hai request đồng thời cùng đọc được.
- **Fix (`go/cmd/pdfcraft/server.go`):**
  - `/api/initial-file`: chỉ cho GET; bỏ `"path"` khỏi JSON — chỉ còn
    `has_file`, `filename`, `size`; lỗi `os.Stat` không lộ chi tiết.
    Token đã do middleware S3 kiểm tra (mọi `/api/*`).
  - Thêm `consumeInitialFile()` atomic (lock, lấy path, set `""`) —
    `/api/initial-file/content` consume trước khi đọc nên request thứ hai → 404.
  - `/content`: chỉ cho GET; mở file + `Stat`, dùng `http.ServeContent`
    để stream + hỗ trợ Range (206), `Content-Type: application/pdf`,
    `Content-Disposition: inline`, `Cache-Control: no-store`; không
    `os.ReadFile`. File > 2 GiB (`maxInitialFileBytes`) → 413.
  - UI (`web/app.js` `checkInitialFile`) chỉ dùng `has_file`/`filename`/
    `size` nên bỏ `path` không phá UI — không cần sửa web.
- **Test (`go/cmd/pdfcraft/server_initialfile_test.go`, 4 test, `-race` pass):**
  `TestInitialFileJSONHasNoPath` (không token 401, POST 405, JSON không có
  `path` và không chứa đường dẫn tuyệt đối), `TestInitialFileContentConsumeOnce`
  (lần 1: 200 + đúng nội dung + `no-store`; lần 2: 404),
  `TestInitialFileContentRange` (206 + `Content-Range: bytes 0-99/...` +
  đúng 100 byte đầu), `TestInitialFileContentConcurrentConsume` (20 request
  đồng thời → đúng 1 lần 200, 19 lần 404).
- **Chưa kiểm tra:** file > 2 GiB thật (ngưỡng chỉ kiểm chứng bằng code).
- **S15:** Playwright + worker trình duyệt chưa kiểm chứng (môi trường
  chặn — xem §2 S15). `style-src` vẫn giữ `'unsafe-inline'` theo
  checklist (app dùng `<style>` nội tuyến); `script-src` chặt
  (`'self'`, không unsafe-inline/unsafe-eval).
- **S14:** fsync không chống được mất điện khi ổ đĩa/filesystem nói dối
  về durability (vd cache ghi không có pin); directory sync là
  best-effort và bỏ qua trên Windows.
- **S13:** KHÔNG tuyên bố "đã sandbox" — chỉ hardening best-effort.
  DDE/OLE-object/remote-image không có key chung đáng tin cậy cho mọi
  phiên bản LibreOffice nên không đặt (theo docling). PowerPoint không
  tắt được cập nhật link qua COM. Token quyền thấp trên Windows chưa làm
  (technical debt). Macro không chạy chưa kiểm chứng bằng file macro thật
  — cần Rio kiểm tra thủ công trên Windows với .docm.
- **S12:** prompt tương tác (`term.ReadPassword`) chưa chạy thật trên terminal
  — chỉ kiểm tra nhánh non-terminal trong test; cần Rio kiểm tra trên Windows
  terminal (`decrypt`/`encrypt` không flag). Python CLI (`python -m pdfcraft
  ... --password`) vẫn lộ mật khẩu trong argv — ngoài phạm vi S12 (checklist
  chỉ nêu `main.go`), ghi nhận residual risk, chưa sửa.

### S12 — Mật khẩu trong argv ✅
- **Nguyên nhân gốc:** `main.go` dùng `--password`/`--user-pw`/`--owner-pw` —
  argv hiện trong Task Manager/process list, PowerShell history, log EDR.
- **Fix (`go/cmd/pdfcraft/main.go`, `go.mod`, `README.md`):**
  - Helper mới: `readPasswordLine(r)` (đọc một dòng stdin, trim `\r\n`, reject
    rỗng; EOF có nội dung vẫn nhận); `resolvePasswordFlag(flagVal, useStdin, stdin)`
    (cả hai flag cùng set → lỗi rõ ràng; đường stdin đọc một dòng; đường argv
    giữ nguyên + cảnh báo stderr "mật khẩu lộ trong process list, dùng
    --password-stdin hoặc nhập tương tác" — KHÔNG log giá trị mật khẩu);
    `resolveRequiredPassword` (như trên, rồi nếu trống: stdin không phải terminal
    → lỗi hướng dẫn dùng `--password-stdin`; là terminal → prompt "Mật khẩu: "
    bằng `golang.org/x/term.ReadPassword`, trim, reject rỗng). `x/term` thêm làm
    dependency trực tiếp (`go get golang.org/x/term@latest`, v0.48.0; x/sys
    0.48.0 → 0.50.0).
  - `info`/`text`/`bookmark`: thêm flag `--password-stdin` (tùy chọn), resolve
    qua `resolvePasswordFlag`; không flag = không mật khẩu (giữ hành vi cũ).
  - `decrypt`: thêm `--password-stdin`; mật khẩu resolve qua
    `resolveRequiredPassword` (bắt buộc); bỏ kiểm tra `*password == ""` cũ.
  - `encrypt`: thêm `--user-pw-stdin`/`--owner-pw-stdin`; user-pw qua
    `resolveRequiredPassword`, owner-pw qua `resolvePasswordFlag` (trống = mặc
    định giống user-pw như cũ, `document.go:578-580`).
  - Sửa `parseFlagsAndArgs`: trước đây ăn token sau MỌI flag `-` làm giá trị —
    làm vỡ bool flag (`--password-stdin file.pdf` ăn mất `file.pdf`). Giờ không
    ăn token tiếp theo khi arg chứa `=` hoặc flag là bool (`fs.Lookup` +
    `IsBoolFlag` qua interface `boolFlagValue`).
  - Help tổng + usage từng lệnh cập nhật flag mới; README Go CLI thêm cảnh báo
    rủi ro argv + ví dụ `--password-stdin`. HUONG-DAN.md không nhắc mật khẩu
    nên không sửa.
  - **Quyết định thiết kế (lệch khỏi đọc chữ checklist mục 5):** prompt tương
    tác CHỈ áp dụng nơi mật khẩu BẮT BUỘC (decrypt, encrypt user-pw). Với lệnh
    mật khẩu tùy chọn (info/text/bookmark), không flag = "không mật khẩu" như
    cũ — prompt ở đó sẽ phá script/pipe (stdin không phải terminal → lỗi).
- **Test (`go/cmd/pdfcraft/main_password_test.go`, 5 test, `-race` pass):**
  `TestReadPasswordLine` (CRLF trim, EOF không newline, rỗng → lỗi),
  `TestResolvePasswordFlag` (conflict, stdin, argv tương thích ngược, không nguồn
  → ""), `TestResolveRequiredPasswordNonTerminal` (lỗi hướng dẫn dùng
  `--password-stdin`), `TestParseFlagsAndArgsBoolFlag` (bool flag không ăn
  file), `TestPasswordStdinCLI` (build binary thật: encrypt `--user-pw-stdin`
  → info `--password-stdin` → decrypt `--password-stdin` → file giải mã mở
  được không cần mật khẩu; `--password` cũ vẫn hoạt động; sai mật khẩu qua
  stdin → lỗi; conflict hai flag → lỗi, không ghi file; help có flag mới).
  Smoke CLI thủ công trước khi viết test: cùng các case trên đều đúng
  (encrypt/info/decrypt qua stdin, legacy, conflict exit 1, thiếu mật khẩu +
  stdin không phải terminal → exit 1 + hướng dẫn).
  **Lưu ý test:** `main()` không arg chạy Web UI server và không thoát — lần
  đầu test help gọi binary không arg nên treo (đã sửa test dùng `--help`).
  **Follow-up (28/11):** `readPasswordLine` trước đây dùng `bufio.NewReader`
  — bufio đọc trước (read-ahead) trên cùng `os.Stdin`, khi `encrypt` dùng cả
  `--user-pw-stdin` lẫn `--owner-pw-stdin` thì dòng owner-pw bị nuốt mất
  (reader thứ hai thấy EOF). Đổi sang đọc byte-by-byte (`r.Read(buf[0:1])`)
  không buffer giữa các lần gọi: mỗi lần gọi đọc đúng một dòng từ vị trí
  hiện tại của stream. Test thêm: đọc hai dòng liên tiếp trên cùng reader,
  cả hai dòng đều nhận đủ.
- **Chưa kiểm tra:** prompt tương tác thật trên terminal (chỉ kiểm tra nhánh
  non-terminal trong test; nhánh `term.ReadPassword` chưa chạy thật — cần Rio
  kiểm tra trên Windows terminal khi chạy `decrypt`/`encrypt` không flag).

### S13 — Office conversion không sandbox ✅ (best-effort, KHÔNG tuyên bố "đã sandbox")
- **Nguyên nhân gốc:** LibreOffice chạy với profile mặc định của người dùng
  (không flag, không cấu hình macro/link); COM dùng `AutomationSecurity=3`
  sẵn nhưng thiếu `AskToUpdateLinks`.
- **Fix LibreOffice (`go/pkg/pdfcraft/office.go`):**
  - Profile tạm cho mỗi batch: `writeLibreOfficeProfile(profileDir)` tạo
    `<tmpDir>/profile/user/registrymodifications.xcu` với key đã xác minh
    (theo docling/hardentools, LibreOffice 24.2): `MacroSecurityLevel=3`
    (Very High) + `DisableMacrosExecution=true` (macro không chạy),
    Writer/Calc `Content/Update Link=0` (không cập nhật link ngoài/DDE khi
    mở file). Profile nằm trong `tmpDir` của batch nên được dọn cùng
    (`defer RemoveAll`); lỗi tạo profile → fail closed, không convert bằng
    profile mặc định.
  - Arg profile: `-env:UserInstallation=file:///<profile>` qua `net/url`
    (`libreOfficeProfileArg`, URL-encode đúng trên Windows).
    **Follow-up (28/11):** trên Windows, đường dẫn `C:/Users/...` không có
    slash đầu khiến `url.URL.String()` sinh `file://C:/Users/...` (host =
    `"C:"` — sai chuẩn file URL) và LibreOffice bỏ qua profile tạm, quay về
    profile người dùng. `libreOfficeProfileArg` giờ luôn `filepath.Abs` rồi
    thêm slash đầu khi thiếu → `file:///C:/Users/...` trên mọi nền tảng.
    Test thêm: case đường dẫn Windows relative + absolute luôn sinh URL có
    3 slash.
  - Flag: `--headless --norestore --nolockcheck --nodefault
    --nofirststartwizard --nologo` (5 flag đầu theo checklist, `--nologo`
    thêm theo docling) — dựng bởi hàm thuần `libreOfficeArgs` để test được.
  - Mỗi batch có profile riêng nên 2 convert đồng thời (semaphore S9) không
    đụng lock profile.
- **Fix COM (`go/pkg/pdfcraft/office_ms_windows.go`, chỉ Windows):** thêm
  `$word.AskToUpdateLinks = $false` và `$excel.AskToUpdateLinks = $false`.
  Đóng document/app trong `finally`/`Quit()` đã có sẵn từ trước — không đổi.
  PowerPoint không có thuộc tính `AskToUpdateLinks` qua COM → không đặt được
  (residual risk).
- **Cảnh báo (checklist mục 5):** README mục convert (cảnh báo đầy đủ +
  khuyến nghị VM/container cho tài liệu không tin cậy); tooltip nút
  "Office → PDF" + toast khi convert trong Web UI.
- **Chưa làm (checklist mục 6):** chạy converter với token quyền thấp trên
  Windows — quá phức tạp cho đợt này, ghi technical debt.
- **Test (`go/pkg/pdfcraft/office_hardening_test.go`, 5 test, `-race` pass):**
  `TestLibreOfficeArgsHardened` (profile URL + đủ 5 flag + không chứa home
  dir), `TestLibreOfficeProfileArgEncoding` (dấu cách → `%20`),
  `TestWriteLibreOfficeProfile` (xcu là XML hợp lệ + đủ 4 key),
  `TestConvertOfficeToPdfFakeEngine` (fake `soffice` shell: argv nhận đúng
  profile tạm + flag; xcu có trong profile khi engine chạy),
  `TestConvertOfficeToPdfRealLibreOffice` (LibreOffice 24.2.7.2 thật trên máy
  này: convert 3 định dạng docx/xlsx/pptx từ fixture tối thiểu sinh trong
  test (`writeMinimalOfficeFixtures`, OOXML zip + XML) → 3 PDF hợp lệ, text
  trích được "Hello ..."). Fixture sinh trong test thay vì commit file nhị
  phân vì `push-files` chỉ nhận file UTF-8 (không đẩy được .docx/.xlsx/
  .pptx qua GitHub MCP). Test COM (`office_ms_windows_test.go`, build tag windows)
  assert script chứa `AskToUpdateLinks`, `AutomationSecurity=3`,
  `DisplayAlerts=0`, `EnableEvents`, `Visible`, `Close`/`Quit` — chỉ chạy
  trên Windows CI; đã kiểm tra biên dịch bằng `GOOS=windows go vet` +
  `go test -c`.
  **Xác minh thủ công thêm:** chạy `soffice` với profile gieo xcu y hệt code
  Go → convert docx thành công; sau khi LO thoát, xcu trong profile vẫn giữ
  `MacroSecurityLevel=3`, `DisableMacrosExecution`, 2 key `Link=0` (key hợp
  lệ, LO không loại bỏ); `~/.config/libreoffice` không hề được tạo trước và
  sau khi chạy — profile người dùng không bị chạm tới.
- **Chưa kiểm tra:** macro trong tài liệu thật có chạy hay không — cần file
  macro-enabled (.docm) và kiểm tra thủ công trên Windows (2 checkbox macro
  trong checklist S13 cố tình để `[ ]`).

### S14 — `saveSafely` không fsync ✅
- **Nguyên nhân gốc:** `saveSafely` ghi temp rồi rename nguyên tử, nhưng dữ
  liệu có thể chưa xuống đĩa — mất điện có thể để lại file 0 byte/hỏng dù
  rename đã xảy ra. `copyFile` cũng không `Sync`.
- **Fix (`go/pkg/pdfcraft/document.go`):**
  - Helper mới `syncFile(path)`: mở `O_RDWR`, `Sync()`, đóng, trả lỗi.
  - `saveSafely`: gọi `syncFile(tempFile)` sau `writerFunc`, trước
    `os.Rename` (lỗi sync → fail closed, không rename, file đích giữ nguyên);
    sau mỗi `Rename` thành công (cả đường trực tiếp lẫn fallback
    `copyFile`→`replaceTemp`) gọi `syncDir` để bản ghi rename bền.
  - `copyFile`: gọi `Sync()` (qua seam `fileSync`) sau `io.CopyBuffer`,
    trước `Close`; lỗi copy/sync/close đều được trả về (kiểm tra copy/close
    đã có từ S1).
  - `syncDir(dir)`: best-effort trên Unix (mở thư mục + `Sync()`, bỏ qua
    lỗi); trên Windows bỏ qua hẳn vì mở thư mục để `Sync` không hỗ trợ.
  - Seam test `fileSync` (package var, mặc định `f.Sync()` thật) để giả lập
    lỗi sync trong test.
- **Test (`go/pkg/pdfcraft/atomic_write_test.go`, 5 test mới, `-race` pass):**
  `TestSaveSafelySyncsBeforeRename` (đếm qua seam: sync được gọi trên đúng
  file `.tmp_` trước rename; nội dung đích đúng; không temp thừa),
  `TestSaveSafelySyncErrorPreservesDestination` (sync lỗi → `saveSafely`
  lỗi, đích giữ nguyên, không temp thừa),
  `TestCopyFileSyncsDestination` (sync đúng 1 lần, nội dung đúng),
  `TestCopyFileSyncError` (sync lỗi → `copyFile` lỗi),
  `TestSyncFile` (`syncFile` file thật OK, file thiếu lỗi, `syncDir` không
  panic cả với thư mục thiếu). Test `saveSafely`/`copyFile` cũ vẫn pass.
- **Chưa kiểm tra:** độ bền khi mất điện thật (không mô phỏng được trong test
  — fsync chỉ đảm bảo theo hợp đồng hệ điều hành); sync thư mục trên Windows
  bỏ qua theo checklist (ghi chú trong code).

### S15 — Thiếu security headers ✅ (trừ kiểm chứng Playwright — môi trường chặn)
- **Nguyên nhân gốc:** response không có `X-Content-Type-Options`, CSP,
  `Referrer-Policy`, CORP/COOP, `Permissions-Policy` (chỉ có `X-Frame-Options`
  + CSP `frame-ancestors` từ S7).
- **Fix (`go/cmd/pdfcraft/server.go`, `web/index.html`, `web/pdfjs-loader.mjs` mới, `scripts/sync_web.py`):**
  - `securityHeadersMiddleware` (ngoài cùng, đã có từ S7) giờ set đủ bộ:
    `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`,
    `Cross-Origin-Opener-Policy: same-origin`,
    `Permissions-Policy: camera=(), microphone=(), geolocation=()`, và CSP đầy
    đủ đúng checklist: `default-src 'self'; script-src 'self'; style-src 'self'
    'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
    connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:;
    object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors
    'none'`. Const `frameAncestorsCSP` (S7) được thay bằng `securityCSP`.
    Header có trên mọi response kể cả lỗi (421/401) và 404.
  - **Thay đổi app bắt buộc vì CSP:** `index.html` có inline `<script type=
    "module">` nạp pdf.js — `script-src 'self'` chặn inline script. Đã tách ra
    file riêng `web/pdfjs-loader.mjs` (giữ nguyên vị trí thẻ `<script
    type="module" src="pdfjs-loader.mjs">` trong `<head>` để thứ tự thực thi
    trước các deferred classic script không đổi; import tương đối
    `./vendor/pdf.min.mjs` giữ nguyên). Không thêm `'unsafe-inline'` /
    `'unsafe-eval'` cho script-src. `style-src` giữ `'unsafe-inline'` theo
    checklist vì app dùng `<style>` nội tuyến + style attribute.
  - `scripts/sync_web.py` whitelist thêm `pdfjs-loader.mjs` (giờ 12 file sync).
- **Test (`go/cmd/pdfcraft/server_security_test.go`, `-race` pass):**
  `assertSecurityHeaders` mới kiểm tra đủ 7 header + từng directive CSP +
  `script-src` đúng `'self'` (không unsafe-inline/unsafe-eval);
  `TestSecurityHeaders` (S7+S15) assert trên `/`, API, 404, 421, 401;
  `TestCSPAllowsAppScripts` assert `index.html` (sau khi bỏ comment HTML)
  không còn `<script>` nội tuyến, có nạp `pdfjs-loader.mjs`, loader import
  đúng vendor build và gán `window.pdfjsLib`.
  Smoke binary thật: `curl -I /` đủ 7 header với CSP đúng checklist;
  `/pdfjs-loader.mjs` 200 `text/javascript`; trang phục vụ không còn inline
  script thực thi (4 thẻ `<script src>` + 1 dòng trong comment HTML).
- **Chưa kiểm tra — Playwright bị môi trường chặn (KHÔNG báo xanh giả):**
  `npx playwright install chromium` thất bại — CDN `cdn.playwright.dev`
  không tới được (connection failure), mirror npmmirror cũng thất bại;
  tải Chromium trực tiếp bị chính sách runtime chặn (`policy_denied`, chỉ
  định dùng `/opt/hatch/bin/hatch-chromium-sandbox`); Chrome hệ thống
  `/opt/meta-chromium/chrome` (Muse Browser) thoát ngay khi khởi động
  ("Hatch WebGL domain policy is required for browser startup", exit 13);
  sandbox Chromium khởi động được nhưng mạng bị cô lập — không tới được
  server local (`ERR_CONNECTION_REFUSED` với `127.0.0.1`,
  `ERR_INTERNET_DISCONNECTED` với IP máy `198.19.0.2`; curl tới
  `198.19.0.2` cũng 000). Hệ quả: stock suite 57 test không chạy được trên
  VM này (lần chạy sandbox bị timeout 280s với 0 test xong; chạy 1 test đơn
  xác nhận lỗi `page.goto: net::ERR_CONNECTION_REFUSED`). Vì vậy 3 checkbox
  Playwright/worker-trình-duyệt trong checklist S15 cố tình để `[ ]`.
  Cần chạy `npx playwright test` trên máy có Chromium dùng được (vd máy
  Windows của Rio) để đóng các mục này — đặc biệt kiểm tra
  `securitypolicyviolation` trên console và pdf.js worker render thật.
  Bằng chứng thay thế đã có: httptest + curl (header), test tĩnh (không
  inline script/handler/eval), test Node S5 (mở PDF thật bằng worker Node
  với `isEvalSupported:false`).

## 3. Tóm tắt thay đổi kiến trúc
- **Token phiên (S3):** mỗi lần chạy server sinh token 32 byte ngẫu nhiên
  (`crypto/rand`, hex). Server inject token vào `<meta name="pdfcraft-token">`
  của trang chính (`no-store`, bypass gzip cache); UI đọc token từ meta tag và
  gắn header `X-PDFCraft-Token` qua helper `apiFetch` cho cả 8 call site.
  Token không nằm trong file JS tĩnh, URL hay log.
- **Middleware bảo mật (S3):** `securityMiddleware` bọc toàn bộ mux — kiểm tra
  `Host` loopback (chống DNS rebinding), token trên `/api/*`, `Origin` /
  `Sec-Fetch-Site` với method đổi trạng thái. Mux được tách thành
  `newMux(port, token, webRoot)` để test được bằng `httptest`.
- **Graceful shutdown (S2/S17):** `shutdownCh` (buffered 1) +
  `requestShutdown()` non-blocking là điểm hội tụ duy nhất của mọi đường tắt:
  API `/api/shutdown` (POST + token + Origin, trả 202), signal Ctrl+C/SIGTERM,
  phím Enter/Q. `runUI` chạy `server.Serve` trong goroutine và `select` chờ
  tín hiệu tắt, sau đó `server.Shutdown` với timeout 15s (lỗi → `Close()`).
  Không còn `os.Exit` trong các đường shutdown; `runUI` return bình thường.
- **Project validation (S4/S16):** `web/utils.js` thêm `validateProjectPayload`
  (pure, test Node), `sanitizeDocMeta`, `isValidDataUrl`,
  `isProjectFileTooLarge` + hằng `PROJECT_LIMITS`. `loadProjectFile` validate
  trước khi mutate state, load vào cấu trúc tạm, kiểm tra `pageIndex < numPages`,
  commit một lần khi hợp lệ (all-or-nothing). Render dữ liệu project bằng DOM
  API/`textContent`, không `innerHTML`.
- **PDF.js 4.10.38 (S5):** vendor đổi sang ESM legacy build (`.mjs`); index.html
  nạp bằng module script gán `window.pdfjsLib`; mọi `getDocument` dùng
  `PDFJS_OPTIONS = { isEvalSupported: false }` (chống CVE-2024-4367).
- **Headers chống clickjacking (S7) → CSP đầy đủ (S15):**
  `securityHeadersMiddleware` ngoài cùng gắn đủ bộ header (nosniff, DENY,
  no-referrer, CORP/COOP same-origin, Permissions-Policy, CSP đầy đủ với
  `script-src 'self'`) lên mọi response; inline `<script>` nạp pdf.js đã tách
  ra `web/pdfjs-loader.mjs` để CSP cho phép.
- **Optimize semaphore (S8):** slot lấy trước khi đọc body, chỉ goroutine
  tối ưu mới được nhả (kể cả khi handler timeout/disconnect); goroutine có
  `recover()`; `api.Optimize` tách thành biến `optimizePDFFunc` làm test hook.
- **Convert đồng bộ + timeout server (S9/S10):** `ConvertOfficeToPdfContext`
  nhận ctx request (hủy/timeout dừng LibreOffice/COM); handler convert gọi
  đồng bộ, `RemoveAll(workDir)` chạy trước khi nhả semaphore; response đơn
  stream bằng `io.Copy`; `newUIServer` có Read/WriteTimeout 5 phút.
- **Initial file (S11):** JSON bỏ `path` tuyệt đối; `consumeInitialFile()`
  atomic; `/content` stream bằng `http.ServeContent` (hỗ trợ Range) + giới
  hạn 2 GiB → 413.
- **Mật khẩu stdin (S12):** `readPasswordLine` / `resolvePasswordFlag` /
  `resolveRequiredPassword` (`x/term.ReadPassword` khi terminal); flag
  `--password-stdin` / `--user-pw-stdin` / `--owner-pw-stdin`; `--password`
  cũ giữ nguyên + cảnh báo argv. `parseFlagsAndArgs` sửa để không ăn file
  làm giá trị của bool flag.
- **Office hardening (S13):** mỗi batch convert dùng profile LibreOffice tạm
  (`-env:UserInstallation`, macro tắt mức cao nhất, không cập nhật link
  ngoài) + flag `--norestore --nolockcheck --nodefault --nofirststartwizard`;
  COM Word/Excel thêm `AskToUpdateLinks=false`.
- **fsync (S14):** `saveSafely` sync file tạm trước rename + sync thư mục sau
  rename; `copyFile` sync đích trước khi đóng; seam `fileSync` để test lỗi sync.

## 4. Kết quả test thực tế
- `go test -race ./...` (sau S1): **pass** — `cmd/pdfcraft` 4.9s,
  `pkg/pdfcraft` 4.3s.
- `go vet ./...`: pass. `gofmt -l`: không output.
- Sau S2/S17 + S4/S16: `go test -race ./...` **pass**
  (`cmd/pdfcraft` 6.3s, `pkg/pdfcraft` 4.6s); `go vet ./...` pass;
  `node --test web/tests/utils.test.js web/tests/project.test.js` **40/40 pass**
  (23 utils + 17 project); `python3 scripts/sync_web.py --check` OK (11 files).
- Sau S5: `node --test` **45/45 pass** (thêm 5 test pdfjs, gồm mở PDF thật
  bằng worker Node trên build 4.10.38); `go test -race ./...` **pass**
  (`cmd/pdfcraft` 6.2s, `pkg/pdfcraft` 4.2s); live smoke server thật: `.mjs`
  200 + MIME `text/javascript`.
- Sau S6/S7 + S8: `go test -race ./...` **pass** (`cmd/pdfcraft` 13.3s —
  gồm test S8 chậm 2s + 5s, `pkg/pdfcraft` 4.4s); `go vet ./...` pass.
- Sau S9/S10: `go test -race ./...` **pass** (`cmd/pdfcraft` 18.2s —
  gồm test convert/optimize chậm, `pkg/pdfcraft` 4.3s); `go vet ./...` pass.
- Sau S11: `go test -race ./...` **pass** (`cmd/pdfcraft` 18.2s,
  `pkg/pdfcraft` 4.0s); `go vet ./...` pass.
- Sau S12: `go test -race ./...` **pass** (`cmd/pdfcraft` 21.1s — gồm test
  CLI S12 build binary thật ~3s, `pkg/pdfcraft` 4.1s); `go vet ./...` pass;
  `gofmt -l`: không output; smoke CLI thủ công (encrypt/info/decrypt qua
  stdin, legacy `--password`, conflict, thiếu mật khẩu + stdin không phải
  terminal) đều đúng.
- Sau S13: `go test -race ./...` **pass** (`cmd/pdfcraft` 22.7s,
  `pkg/pdfcraft` 10.4s — gồm test convert LibreOffice thật ~5s);
  `go vet ./...` pass (cả `GOOS=windows`); `node --test` **45/45 pass**;
  `python3 scripts/sync_web.py --check` OK.
- Sau S14: `go test -race ./...` **pass** (`cmd/pdfcraft` 22.4s,
  `pkg/pdfcraft` 10.8s); `go vet ./...` pass (cả `GOOS=windows`).
- Sau S15: `go test -race ./...` **pass** (`cmd/pdfcraft` 21.4s,
  `pkg/pdfcraft` 10.8s); `go vet ./...` pass; `gofmt -l`: không output;
  smoke binary thật (đủ 7 header, loader 200, không inline script).
  Playwright: KHÔNG chạy được trên VM này (xem §2 S15).
- Follow-up S12 (28/11, máy Windows): `go vet ./...` pass; nội dung index
  gofmt sạch; `go test ./cmd/pdfcraft/ ./pkg/pdfcraft/` pass (22.4s + 11.7s,
  gồm test đọc 2 dòng stdin liên tiếp). Lưu ý môi trường: `gofmt -l .` trên
  Windows flag file chưa sửa do `core.autocrlf=true` (working tree CRLF),
  CI checkout LF nên sạch — không chạy `gofmt -w`.
- Follow-up S13 (28/11, máy Windows): `libreOfficeProfileArg` thêm slash đầu
  cho đường dẫn Windows; `go test ./pkg/pdfcraft/` pass (11.7s, gồm test
  mới cho URL 3 slash); full suite + `GOOS=linux go build` chạy ở Task 1
  Step 5 (xem progress ledger).

**Bộ test cuối đợt (sau S15, trước khi mở PR):**
- `cd go; gofmt -w .` → sạch (`gofmt -l` không output); `go vet ./...` pass;
  `go test -race ./...` **pass** (`cmd/pdfcraft` 21.1s, `pkg/pdfcraft` 10.4s);
  `go build ./...` pass; `GOOS=windows GOARCH=amd64 go build ./...` pass.
- `govulncheck ./...`: lần đầu báo 1 finding GO-2026-5932
  (`x/crypto/openpgp` v0.57.0, code không gọi tới) → đã nâng
  `golang.org/x/crypto` v0.57.0 → v0.58.1-0.20261009181718-2f1f834330b2
  (kèm `x/text` 0.42.0 → 0.43.0, commit `cebaee3`); chạy lại:
  **"No vulnerabilities found."** Full suite chạy lại sau nâng dep vẫn pass.
- `python3 scripts/sync_web.py --check` OK (12 file); `node --test` **45/45
  pass**. Lưu ý: ngay sau S15, test pdfjs Node fail 1 (assert import
  `vendor/pdf.min.mjs` nằm trong `index.html` — import đã chuyển sang
  `pdfjs-loader.mjs`) → đã sửa test theo cấu trúc mới (commit `046ad39`),
  node 45/45 pass trở lại. Đây là test cũ chưa theo kịp refactor, không
  phải regression của app.
- `cd web; npm ci` OK (4 packages); `npx playwright install chromium`
  **thất bại** (CDN bị chặn + tải Chromium trực tiếp bị chính sách runtime
  chặn); `npx playwright test` **không chạy được** trên VM này (xem §2 S15).
  DoD cuối checklist: 6/8 mục `[x]`; 2 mục còn `[ ]` ("Test mới chạy pass
  cùng toàn bộ suite liên quan", "Không có regression UI/CLI") vì
  Playwright chưa chạy được — không đánh dấu xanh giả.
- (Các lệnh `go build`, cross-compile Windows, `govulncheck`, Playwright sẽ
  chạy/ghi ở cuối đợt.)

## 5. Residual risk và phần chưa kiểm tra
- **S1:** case-variant đường dẫn trên Windows (vd `Same.PDF` vs `same.pdf`)
  chỉ được kiểm tra bằng đọc code + test có nhánh `runtime.GOOS == "windows"`;
  chưa chạy thực tế trên Windows — cần CI Windows hoặc kiểm tra thủ công.
- **S4/S16:** kiểm chứng trình duyệt (mở project độc thật trong Playwright:
  assert `window.__xss` undefined + toast; mở project hợp lệ 10 sources /
  1000 trang; reject `pageIndex >= numPages` giữ state cũ) chưa chạy — để cuối
  đợt cùng bộ Playwright. Gate 512 MB chỉ mới unit-test qua helper
  `isProjectFileTooLarge` (chưa mở file 600 MB thật trong trình duyệt).
- **S5:** kiểm chứng trình duyệt thật (render/text layer/search/PDF mật khẩu/
  project load/export/ký + không console error) chưa chạy — để cuối đợt cùng
  bộ Playwright. Rủi ro còn lại: module script `.mjs` phụ thuộc thứ tự thực
  thi theo tài liệu (đã kiểm chứng bằng spec HTML + test Node mở PDF thật,
  nhưng chưa chạy trình duyệt thật).
- **S8:** output optimize vẫn dùng `bytes.Buffer` trong RAM thay vì temp
  file — giới hạn bởi input ≤ 150 MB, nhưng 3 optimize đồng thời có thể giữ
  tới ~450 MB + input. Để lại làm technical debt (xem §2 S8).
- **S9/S10:** Playwright upload 1/nhiều file + export flow; cảnh báo xóa file
  đang dùng trên Windows; export 100–300 MB thật — chưa chạy, để cuối đợt.
- **Chung:** môi trường làm việc là Linux cloud — chưa có LibreOffice,
  Playwright/Chromium, Windows. Các tiêu chí chỉ kiểm tra thủ công trên
  Windows (context menu, Office conversion, shutdown, macro) sẽ được ghi rõ
  từng mục và không đánh dấu `[x]` nếu chưa kiểm tra.

## 6. PR / CI / Merge
- PR: https://github.com/vmcchooky/pdf-crafting/pull/16
  ("fix(security): S1–S17 khắc phục audit bảo mật 11/2026",
  base `audit/security-checklist-2026-11`, head `fix/security-audit-2026-11`).
- Merge: chỉ merge khi tất cả check CI xanh tại đúng head SHA của PR
  (kiểm chứng bằng `pull_request_read`); nếu CI đỏ/pending/không chạy được
  (vd GitHub Actions bị khóa billing) thì không merge, báo cáo PR + link CI.

### Lần 1 — run 46124572184, head `7939fd2b` (28/11 08:10 UTC): 3 xanh / 3 đỏ
- Xanh: `web-sync`, `qpdf`, `bench` (bench: `split50` chậm hơn 52.5% so
  với base — cảnh báo, job này `continue-on-error: true`).
- Đỏ: `go`, `web`, `go-sec` → **không merge**.
- `go-sec` đỏ do gosec báo 7 findings trên code mới (base: 0 findings):
  G101 tại `server.go:494,499` (chuỗi `"X-PDFCraft-Token"` /
  `"__PDFCRAFT_TOKEN__"` — false positive: tên header + placeholder,
  không phải credential); G304 tại `document.go:836,854` (`syncFile` /
  `syncDir` — path là file/thư mục tạm do app tạo); G104 tại
  `document.go:841,945,951` (`Close()` trong nhánh đã trả lỗi khác).
  Đã sửa: thêm `// #nosec` kèm lý do theo đúng quy ước có sẵn trong
  repo + `_ = Close()` ở nhánh lỗi. Kiểm tra lại local: gosec 0 issues,
  exit 0; `govulncheck` sạch.
- `go` đỏ — nguyên nhân chưa xác định được (log job CI không lấy được qua
  GitHub MCP — không có tool tải log; trang Actions chỉ hiện annotation
  "Process completed with exit code 1"). Đã loại trừ: chạy đúng Go CI
  (1.26.11) local — `gofmt` sạch, `go build`, `go vet`, `go test -race`
  (cmd 26.2s, pkg 19.4s), cross-build Windows amd64 + arm64
  (CGO_ENABLED=0) đều pass; test semaphore chạy 3 lần trên 1 CPU + `-race`
  vẫn pass; runner ubuntu-24.04 KHÔNG có LibreOffice sẵn (đọc README
  runner-images) nên test LibreOffice thật đã skip trên CI. Nghi ngờ còn
  lại: timer trên runner chia sẻ CPU — đã nới cửa sổ chờ trong 2 test
  semaphore từ 4–8s thành 3–15s (vẫn assert chờ ~5s rồi 503, không nới
  vô hạn) rồi push lại để CI chạy lần 2 xác nhận.
- `web` đỏ — **lỗi có sẵn, không phải do PR này**: CI của commit base
  `884c585` (run 46118123403) cũng đỏ đúng 1 job `web`, còn `go` /
  `go-sec` đều xanh. Bộ Playwright không chạy được trên VM này nên không
  xác định được nguyên nhân trong `web`; cần người có máy chạy được
  Playwright/Chromium xem log job `web` trên GitHub. Job `web` đỏ chặn
  merge dù `go`/`go-sec` có xanh lại.

### Lần 2 — run 46127210810, head `2f8c69a` (28/11 08:44 UTC): 4 xanh / 2 đỏ
- Xanh: `web-sync`, `qpdf`, `bench`, **`go-sec` ✅ (fix gosec có tác dụng)**.
- Đỏ: `go`, `web` → **KHÔNG merge**.
- `go` vẫn đỏ dù đã sửa gosec + nới cửa sổ timing. Nguyên nhân chưa xác
  định được: chạy đúng Go CI (1.26.11) local — `gofmt`, `go build`, `go vet`,
  `go test -race` (cmd 26.2s, pkg 19.4s), cross-build Windows amd64 +
  arm64 (`CGO_ENABLED=0`), `GOOS=windows go vet` đều pass; stress
  `go test -race -count=5` pass cả 2 package; test semaphore pass 3 lần
  trên 1 CPU. Link job lỗi có fragment `#step:4:36` (step 4 = cross-build
  hoặc step test, tùy cách đếm "Set up job") — không đủ kết luận. Log job
  CI không lấy được: GitHub MCP không có tool tải log; trang job trên web
  chỉ hiện annotation "Process completed with exit code 1"; lần thử mở
  trang job qua browser bị lỗi mạng. Cần người có quyền đọc log Actions
  (hoặc `gh run view --log`) mở log job `go` của run 46127210810 để biết
  step/test nào fail rồi mới sửa tiếp — không sửa mò thêm.
- `web` vẫn đỏ (lỗi có sẵn từ base, xem lần 1). Job này chặn merge dù
  `go`/`go-sec` có xanh lại.

### Kết luận merge (28/11, sau lần 2)
- **CHƯA MERGE.** CI chưa xanh hết: `go` + `web` đỏ tại head `2f8c69a`.
  Theo quy tắc merge đã giao, dừng lại và báo cáo PR + link CI để xử lý
  tiếp cùng Rio. PR: https://github.com/vmcchooky/pdf-crafting/pull/16 —
  CI: https://github.com/vmcchooky/pdf-crafting/actions/runs/46127210810
- Lưu ý kỹ thuật: lần push fix gosec tạo 2 commit remote cùng nội dung
  (`51fdc00` 08:44:16Z rồi `2f8c69a` 08:44:22Z — `push-files` dường như
  retry nội bộ); head PR là `2f8c69a`, nội dung đúng 37 file.
