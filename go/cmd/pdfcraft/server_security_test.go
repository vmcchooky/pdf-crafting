package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

const (
	testServerPort  = 18099
	testServerToken = "test-token-1234567890abcdef"
)

// testHandler dựng mux thật với token cố định để kiểm tra middleware S3.
// Mirror đúng wiring của runUI: securityHeadersMiddleware ngoài cùng.
func testHandler(t *testing.T, token string) http.Handler {
	t.Helper()
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		t.Fatalf("fs.Sub(webFS) lỗi: %v", err)
	}
	return securityHeadersMiddleware(securityMiddleware(testServerPort, token, newMux(testServerPort, token, sub)))
}

func doTestRequest(t *testing.T, h http.Handler, method, target, host, token, origin, fetchSite string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	req.Host = host
	if token != "" {
		req.Header.Set(sessionTokenHeader, token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if fetchSite != "" {
		req.Header.Set("Sec-Fetch-Site", fetchSite)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const testHost = "127.0.0.1:18099"

// doTestRequestWithHeaders như doTestRequest nhưng gắn thêm header tùy ý.
func doTestRequestWithHeaders(t *testing.T, h http.Handler, method, target, host, token string, extra map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	req.Host = host
	if token != "" {
		req.Header.Set(sessionTokenHeader, token)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestSecurityMiddlewareHost (S3): Host lạ (DNS rebinding) hoặc thiếu port
// phải bị từ chối trên mọi route.
func TestSecurityMiddlewareHost(t *testing.T) {
	h := testHandler(t, testServerToken)

	rec := doTestRequest(t, h, http.MethodGet, "/", "evil.example:18099", "", "", "")
	if rec.Code != http.StatusMisdirectedRequest && rec.Code != http.StatusForbidden {
		t.Errorf("Host evil: status = %d, muốn 403 hoặc 421", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodGet, "/api/context-menu/status", "evil.example:18099", testServerToken, "", "")
	if rec.Code != http.StatusMisdirectedRequest && rec.Code != http.StatusForbidden {
		t.Errorf("Host evil trên /api: status = %d, muốn 403 hoặc 421", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodGet, "/", "127.0.0.1", "", "", "")
	if rec.Code != http.StatusMisdirectedRequest && rec.Code != http.StatusForbidden {
		t.Errorf("Host thiếu port: status = %d, muốn 403 hoặc 421", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodGet, "/", "localhost:18099", "", "", "")
	if rec.Code != http.StatusOK {
		t.Errorf("Host localhost hợp lệ: status = %d, muốn 200", rec.Code)
	}
}

// TestSecurityMiddlewareToken (S3): mọi /api/* thiếu/sai token phải 401;
// đúng token mới qua được.
func TestSecurityMiddlewareToken(t *testing.T) {
	h := testHandler(t, testServerToken)

	rec := doTestRequest(t, h, http.MethodGet, "/api/context-menu/status", testHost, "", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("thiếu token: status = %d, muốn 401", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodGet, "/api/context-menu/status", testHost, "sai-token", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("sai token: status = %d, muốn 401", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodGet, "/api/context-menu/status", testHost, testServerToken, "", "")
	if rec.Code != http.StatusOK {
		t.Errorf("đúng token: status = %d, muốn 200", rec.Code)
	}

	// Route tĩnh không cần token.
	rec = doTestRequest(t, h, http.MethodGet, "/app.js", testHost, "", "", "")
	if rec.Code != http.StatusOK {
		t.Errorf("asset tĩnh không token: status = %d, muốn 200", rec.Code)
	}
}

// TestSecurityMiddlewareOrigin (S3): POST cross-origin có token vẫn 403;
// Origin loopback hoặc Sec-Fetch-Site same-origin/none thì qua.
func TestSecurityMiddlewareOrigin(t *testing.T) {
	h := testHandler(t, testServerToken)

	rec := doTestRequest(t, h, http.MethodPost, "/api/context-menu/install", testHost, testServerToken, "https://evil.example", "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("Origin lạ: status = %d, muốn 403", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodPost, "/api/context-menu/install", testHost, testServerToken, "http://127.0.0.1:18099", "")
	if rec.Code == http.StatusForbidden {
		t.Errorf("Origin loopback bị chặn: status = %d", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodPost, "/api/context-menu/install", testHost, testServerToken, "", "cross-site")
	if rec.Code != http.StatusForbidden {
		t.Errorf("Sec-Fetch-Site cross-site: status = %d, muốn 403", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodPost, "/api/context-menu/install", testHost, testServerToken, "", "same-origin")
	if rec.Code == http.StatusForbidden {
		t.Errorf("Sec-Fetch-Site same-origin bị chặn: status = %d", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodPost, "/api/context-menu/install", testHost, testServerToken, "", "")
	if rec.Code == http.StatusForbidden {
		t.Errorf("không Origin/Sec-Fetch-Site (CLI/test) bị chặn: status = %d", rec.Code)
	}
}

// TestSecurityMiddlewareEmptyToken (S3): server không có token thì mọi /api/*
// đều bị từ chối (fail closed).
func TestSecurityMiddlewareEmptyToken(t *testing.T) {
	h := testHandler(t, "")
	rec := doTestRequest(t, h, http.MethodGet, "/api/context-menu/status", testHost, "bat-cu-token-nao", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("token rỗng phía server: status = %d, muốn 401", rec.Code)
	}
}

// TestTokenInjection (S3): trang chính chứa meta token do server inject,
// asset tĩnh không chứa token, trang chính không được cache.
func TestTokenInjection(t *testing.T) {
	h := testHandler(t, testServerToken)

	for _, target := range []string{"/", "/index.html"} {
		rec := doTestRequest(t, h, http.MethodGet, target, testHost, "", "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d, muốn 200", target, rec.Code)
		}
		body := rec.Body.String()
		want := `<meta name="pdfcraft-token" content="` + testServerToken + `">`
		if !strings.Contains(body, want) {
			t.Errorf("GET %s không chứa meta token đã inject", target)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("GET %s Cache-Control = %q, muốn \"no-store\"", target, cc)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET %s Content-Type = %q, muốn text/html", target, ct)
		}
	}

	rec := doTestRequest(t, h, http.MethodGet, "/app.js", testHost, "", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /app.js: status = %d, muốn 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), testServerToken) {
		t.Errorf("/app.js chứa token phiên — token không được nằm trong file JS tĩnh")
	}
}

// TestNewSessionToken (S3): token ngẫu nhiên mỗi lần sinh, đủ dài, hex.
func TestNewSessionToken(t *testing.T) {
	a, err := newSessionToken()
	if err != nil {
		t.Fatalf("newSessionToken lỗi: %v", err)
	}
	b, err := newSessionToken()
	if err != nil {
		t.Fatalf("newSessionToken lỗi: %v", err)
	}
	if len(a) != 64 {
		t.Errorf("độ dài token = %d, muốn 64 (32 byte hex)", len(a))
	}
	if a == b {
		t.Errorf("hai token liên tiếp giống nhau — không ngẫu nhiên")
	}
	for _, c := range a {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			t.Errorf("token chứa ký tự ngoài hex: %q", c)
			break
		}
	}
}

// drainShutdownCh xả tín hiệu tắt còn sót (shutdownCh dùng chung cả package).
func drainShutdownCh() {
	select {
	case <-shutdownCh:
	default:
	}
}

// TestShutdownEndpoint (S2): GET → 405, server vẫn sống; POST không token →
// 401; POST Origin lạ → 403; POST hợp lệ → 202 + tín hiệu tắt.
func TestShutdownEndpoint(t *testing.T) {
	h := testHandler(t, testServerToken)

	drainShutdownCh()
	rec := doTestRequest(t, h, http.MethodGet, "/api/shutdown", testHost, testServerToken, "", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /api/shutdown: status = %d, muốn 405", rec.Code)
	}
	select {
	case <-shutdownCh:
		t.Errorf("GET /api/shutdown đã gửi tín hiệu tắt — không được")
	default:
	}

	rec = doTestRequest(t, h, http.MethodPost, "/api/shutdown", testHost, "", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("POST không token: status = %d, muốn 401", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodPost, "/api/shutdown", testHost, testServerToken, "https://evil.example", "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST Origin lạ: status = %d, muốn 403", rec.Code)
	}

	drainShutdownCh()
	rec = doTestRequest(t, h, http.MethodPost, "/api/shutdown", testHost, testServerToken, "http://127.0.0.1:18099", "")
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST hợp lệ: status = %d, muốn 202", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "accepted") {
		t.Errorf("POST hợp lệ: body = %q, muốn chứa \"accepted\"", rec.Body.String())
	}
	select {
	case <-shutdownCh:
	case <-time.After(time.Second):
		t.Errorf("POST hợp lệ không gửi tín hiệu tắt trong 1s")
	}
}

// TestRequestShutdownNonBlocking (S17): gửi tín hiệu nhiều lần không kẹt.
func TestRequestShutdownNonBlocking(t *testing.T) {
	drainShutdownCh()
	done := make(chan struct{})
	go func() {
		requestShutdown()
		requestShutdown()
		requestShutdown()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("requestShutdown bị kẹt")
	}
	drainShutdownCh()
}

// TestGracefulShutdownSlowHandler (S17): server.Shutdown chờ handler đang
// chạy (block 1s) hoàn tất thay vì giết request.
func TestGracefulShutdownSlowHandler(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(time.Second)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("done"))
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen lỗi: %v", err)
	}
	srv := &http.Server{Handler: handler}
	go func() { _ = srv.Serve(ln) }()

	done := make(chan int, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/")
		if err != nil {
			done <- 0
			return
		}
		defer resp.Body.Close()
		done <- resp.StatusCode
	}()
	time.Sleep(100 * time.Millisecond) // để request bắt đầu chạy

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown lỗi: %v", err)
	}
	select {
	case code := <-done:
		if code != http.StatusOK {
			t.Errorf("request đang chạy kết thúc với status = %d, muốn 200", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("request đang chạy không hoàn tất trước khi Shutdown trả về")
	}
}

// TestContextMenuEndpoints (S6): install/uninstall chỉ POST; không token →
// 401; Origin lạ → 403; lỗi chỉ trả thông báo chung, không lộ đường dẫn.
func TestContextMenuEndpoints(t *testing.T) {
	h := testHandler(t, testServerToken)

	for _, endpoint := range []string{"/api/context-menu/install", "/api/context-menu/uninstall"} {
		rec := doTestRequest(t, h, http.MethodGet, endpoint, testHost, testServerToken, "", "")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s: status = %d, muốn 405", endpoint, rec.Code)
		}

		rec = doTestRequest(t, h, http.MethodPost, endpoint, testHost, "", "", "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("POST %s không token: status = %d, muốn 401", endpoint, rec.Code)
		}

		rec = doTestRequest(t, h, http.MethodPost, endpoint, testHost, testServerToken, "https://evil.example", "")
		if rec.Code != http.StatusForbidden {
			t.Errorf("POST %s Origin lạ: status = %d, muốn 403", endpoint, rec.Code)
		}

		rec = doTestRequest(t, h, http.MethodPost, endpoint, testHost, testServerToken, "http://127.0.0.1:18099", "")
		if rec.Code != http.StatusOK {
			t.Errorf("POST %s hợp lệ: status = %d, muốn 200", endpoint, rec.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("POST %s: body không phải JSON: %v", endpoint, err)
		}
		// Trên Linux (không phải Windows) install/uninstall luôn lỗi —
		// nhưng lỗi trả về phải là thông báo chung, không chứa đường dẫn.
		if _, ok := body["success"]; !ok {
			t.Errorf("POST %s: thiếu trường success trong %s", endpoint, rec.Body.String())
		}
		if msg, _ := body["error"].(string); msg != "" {
			if msg != "Không thể cập nhật Menu chuột phải Windows" {
				t.Errorf("POST %s: error = %q, muốn thông báo chung (không lộ chi tiết)", endpoint, msg)
			}
			if strings.Contains(msg, "\\") || strings.Contains(msg, "/") || strings.Contains(msg, ":\\") {
				t.Errorf("POST %s: error lộ đường dẫn: %q", endpoint, msg)
			}
		}
	}
}

// assertAntiClickjackingHeaders kiểm tra hai header S7 có trên response.
func assertAntiClickjackingHeaders(t *testing.T, rec *httptest.ResponseRecorder, what string) {
	t.Helper()
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("%s: X-Frame-Options = %q, muốn \"DENY\"", what, got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Errorf("%s: Content-Security-Policy = %q, muốn chứa \"frame-ancestors 'none'\"", what, got)
	}
}

// assertSecurityHeaders kiểm tra đủ bộ header S15 (gồm 2 header S7).
func assertSecurityHeaders(t *testing.T, rec *httptest.ResponseRecorder, what string) {
	t.Helper()
	assertAntiClickjackingHeaders(t, rec, what)
	want := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "no-referrer",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Permissions-Policy":           "camera=(), microphone=(), geolocation=()",
	}
	for h, v := range want {
		if got := rec.Header().Get(h); got != v {
			t.Errorf("%s: %s = %q, muốn %q", what, h, got, v)
		}
	}
	csp := rec.Header().Get("Content-Security-Policy")
	for _, d := range []string{
		"default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
		"worker-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'",
		"base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
	} {
		if !strings.Contains(csp, d) {
			t.Errorf("%s: CSP thiếu %q (CSP=%q)", what, d, csp)
		}
	}
	// script-src phải đúng 'self' — không 'unsafe-inline'/'unsafe-eval'
	// (style-src có 'unsafe-inline' là cố ý nên chỉ kiểm tra directive này).
	for _, part := range strings.Split(csp, ";") {
		if strings.HasPrefix(strings.TrimSpace(part), "script-src") {
			if strings.TrimSpace(part) != "script-src 'self'" {
				t.Errorf("%s: script-src = %q, muốn \"script-src 'self'\"", what, strings.TrimSpace(part))
			}
		}
	}
	if strings.Contains(csp, "'unsafe-eval'") {
		t.Errorf("%s: CSP chứa 'unsafe-eval': %q", what, csp)
	}
}

// TestCSPAllowsAppScripts (S15): CSP script-src 'self' chặn inline script —
// index.html không được còn <script> nội tuyến; loader pdf.js phải là file
// riêng trong embed và import đúng vendor build.
func TestCSPAllowsAppScripts(t *testing.T) {
	data, err := fs.ReadFile(webFS, "web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	// Bỏ comment HTML trước khi quét (comment không chạy, không bị CSP chặn).
	noComments := regexp.MustCompile(`(?s)<!--.*?-->`).ReplaceAll(data, nil)
	for _, line := range strings.Split(string(noComments), "\n") {
		if strings.Contains(line, "<script") && !strings.Contains(line, "src=") {
			t.Errorf("index.html còn inline <script> (CSP script-src 'self' sẽ chặn): %s", strings.TrimSpace(line))
		}
	}
	if !strings.Contains(string(data), `src="pdfjs-loader.mjs"`) {
		t.Errorf("index.html không nạp pdfjs-loader.mjs")
	}
	loader, err := fs.ReadFile(webFS, "web/pdfjs-loader.mjs")
	if err != nil {
		t.Fatalf("pdfjs-loader.mjs thiếu trong embed: %v", err)
	}
	if !strings.Contains(string(loader), "./vendor/pdf.min.mjs") || !strings.Contains(string(loader), "window.pdfjsLib") {
		t.Errorf("pdfjs-loader.mjs không import/gán pdfjsLib:\n%s", loader)
	}
}

// TestSecurityHeaders (S7+S15): đủ bộ header có trên trang chính, API,
// asset 404 và cả response lỗi (421/401).
func TestSecurityHeaders(t *testing.T) {
	h := testHandler(t, testServerToken)

	rec := doTestRequest(t, h, http.MethodGet, "/", testHost, "", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: status = %d, muốn 200", rec.Code)
	}
	assertSecurityHeaders(t, rec, "GET /")

	rec = doTestRequest(t, h, http.MethodGet, "/api/context-menu/status", testHost, testServerToken, "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/context-menu/status: status = %d, muốn 200", rec.Code)
	}
	assertSecurityHeaders(t, rec, "GET /api/context-menu/status")

	rec = doTestRequest(t, h, http.MethodGet, "/asset-khong-ton-tai.js", testHost, "", "", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET asset lạ: status = %d, muốn 404", rec.Code)
	}
	assertSecurityHeaders(t, rec, "GET 404")

	// Response lỗi từ middleware trong (421 Host lạ, 401 thiếu token)
	// vẫn phải có header vì headers middleware nằm ngoài cùng.
	rec = doTestRequest(t, h, http.MethodGet, "/", "evil.example:18099", "", "", "")
	if rec.Code != http.StatusMisdirectedRequest {
		t.Errorf("GET / Host lạ: status = %d, muốn 421", rec.Code)
	}
	assertSecurityHeaders(t, rec, "GET / Host lạ (421)")

	rec = doTestRequest(t, h, http.MethodGet, "/api/shutdown", testHost, "", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("GET /api/shutdown không token: status = %d, muốn 401", rec.Code)
	}
	assertSecurityHeaders(t, rec, "GET /api/shutdown (401)")
}
