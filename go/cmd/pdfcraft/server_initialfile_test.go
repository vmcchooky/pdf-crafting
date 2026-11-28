package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestInitialFileJSONHasNoPath (S11): JSON không còn path tuyệt đối;
// không token → 401; POST → 405.
func TestInitialFileJSONHasNoPath(t *testing.T) {
	h := testHandler(t, testServerToken)
	t.Cleanup(func() { setInitialFile("") })

	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	abs, err := filepath.Abs(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	setInitialFile(abs)

	// Không token → 401 (S3).
	rec := doTestRequest(t, h, http.MethodGet, "/api/initial-file", testHost, "", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("không token: status = %d, muốn 401", rec.Code)
	}

	// POST → 405.
	rec = doTestRequest(t, h, http.MethodPost, "/api/initial-file", testHost, testServerToken, "", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: status = %d, muốn 405", rec.Code)
	}

	rec = doTestRequest(t, h, http.MethodGet, "/api/initial-file", testHost, testServerToken, "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: status = %d, muốn 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body không phải JSON: %v", err)
	}
	if body["has_file"] != true {
		t.Errorf("has_file = %v, muốn true", body["has_file"])
	}
	if body["filename"] != "sample.pdf" {
		t.Errorf("filename = %v, muốn sample.pdf", body["filename"])
	}
	if _, ok := body["path"]; ok {
		t.Errorf("JSON còn chứa path tuyệt đối: %v", body["path"])
	}
	if strings.Contains(rec.Body.String(), abs) {
		t.Errorf("JSON lộ đường dẫn tuyệt đối: %s", rec.Body.String())
	}
	if _, ok := body["size"]; !ok {
		t.Errorf("JSON thiếu size")
	}
}

// TestInitialFileContentConsumeOnce (S11): request đầu 200 + stream đúng;
// request thứ hai → 404; Range → 206.
func TestInitialFileContentConsumeOnce(t *testing.T) {
	h := testHandler(t, testServerToken)
	t.Cleanup(func() { setInitialFile("") })

	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	abs, err := filepath.Abs(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	setInitialFile(abs)

	rec := doTestRequest(t, h, http.MethodGet, "/api/initial-file/content", testHost, testServerToken, "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("lần 1: status = %d, muốn 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Errorf("Content-Type = %q, muốn application/pdf", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, muốn no-store", cc)
	}
	if !strings.HasPrefix(string(rec.Body.Bytes()), "%PDF") {
		t.Errorf("body không phải PDF")
	}
	if len(rec.Body.Bytes()) != len(want) {
		t.Errorf("body = %d byte, file gốc = %d byte", rec.Body.Len(), len(want))
	}

	// Request thứ hai sau khi consume → 404.
	rec = doTestRequest(t, h, http.MethodGet, "/api/initial-file/content", testHost, testServerToken, "", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("lần 2: status = %d, muốn 404", rec.Code)
	}
}

// TestInitialFileContentRange (S11): ServeContent hỗ trợ Range → 206.
func TestInitialFileContentRange(t *testing.T) {
	h := testHandler(t, testServerToken)
	t.Cleanup(func() { setInitialFile("") })

	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	abs, err := filepath.Abs(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	setInitialFile(abs)

	req := doTestRequestWithHeaders(t, h, http.MethodGet, "/api/initial-file/content", testHost, testServerToken, map[string]string{"Range": "bytes=0-99"})
	if req.Code != http.StatusPartialContent {
		t.Fatalf("Range: status = %d, muốn 206", req.Code)
	}
	if cr := req.Header().Get("Content-Range"); !strings.HasPrefix(cr, "bytes 0-99/") {
		t.Errorf("Content-Range = %q, muốn \"bytes 0-99/...\"", cr)
	}
	if len(req.Body.Bytes()) != 100 || string(req.Body.Bytes()) != string(want[:100]) {
		t.Errorf("Range body sai: %d byte", req.Body.Len())
	}
}

// TestInitialFileContentConcurrentConsume (S11): 20 request đồng thời —
// chỉ đúng 1 request đọc được file, còn lại 404.
func TestInitialFileContentConcurrentConsume(t *testing.T) {
	h := testHandler(t, testServerToken)
	t.Cleanup(func() { setInitialFile("") })

	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	abs, err := filepath.Abs(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	setInitialFile(abs)

	const n = 20
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := doTestRequest(t, h, http.MethodGet, "/api/initial-file/content", testHost, testServerToken, "", "")
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()

	ok, notFound := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusNotFound:
			notFound++
		default:
			t.Errorf("status lạ: %d", c)
		}
	}
	if ok != 1 || notFound != n-1 {
		t.Errorf("đồng thời: 200×%d, 404×%d — muốn đúng 1 lần 200 và %d lần 404", ok, notFound, n-1)
	}
}
