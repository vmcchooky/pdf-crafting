package main

// Test cho POST /api/convert (Office -> PDF).
// Engine "soffice" giả = chính test binary (TestMain + PDFCRAFT_FAKE_SOFFICE),
// nên test chạy được trên mọi OS mà không cần LibreOffice thật.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("PDFCRAFT_FAKE_SOFFICE") == "1" {
		var outDir string
		var inputs []string
		args := os.Args[1:]
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "--headless":
				continue
			case "--convert-to":
				i++
				continue
			case "--outdir":
				if i+1 < len(args) {
					outDir = args[i+1]
					i++
				}
				continue
			default:
				if strings.HasPrefix(args[i], "-") {
					continue
				}
				inputs = append(inputs, args[i])
			}
		}
		for _, in := range inputs {
			stem := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in))
			_ = os.WriteFile(filepath.Join(outDir, stem+".pdf"),
				[]byte("%PDF-1.4 fake\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"), 0644)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func useFakeSoffice(t *testing.T) {
	t.Helper()
	t.Setenv("PDFCRAFT_SOFFICE", os.Args[0])
	t.Setenv("PDFCRAFT_FAKE_SOFFICE", "1")
}

func newConvertRequest(t *testing.T, files map[string][]byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for name, data := range files {
		fw, err := mw.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/convert", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestConvertSingleFileReturnsPDF(t *testing.T) {
	useFakeSoffice(t)
	req := newConvertRequest(t, map[string][]byte{"bao_cao.docx": []byte("fake-docx")})
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, rec.Body.String())
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/pdf" {
		t.Errorf("expected application/pdf, got %q", ct)
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Errorf("response is not a PDF")
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, ".pdf") {
		t.Errorf("missing pdf filename in Content-Disposition: %q", cd)
	}
}

func TestConvertMultipleFilesReturnsZip(t *testing.T) {
	useFakeSoffice(t)
	req := newConvertRequest(t, map[string][]byte{
		"a.docx": []byte("fake-a"),
		"b.xlsx": []byte("fake-b"),
	})
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, rec.Body.String())
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("expected application/zip, got %q", ct)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 2 {
		t.Errorf("expected 2 files in zip, got %d", len(zr.File))
	}
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, ".pdf") {
			t.Errorf("expected .pdf entry, got %q", f.Name)
		}
	}
}

func TestConvertNoEngineReturns501JSON(t *testing.T) {
	t.Setenv("PDFCRAFT_SOFFICE", "")
	old := findOfficeEngineForWeb
	findOfficeEngineForWeb = func() string { return "" }
	defer func() { findOfficeEngineForWeb = old }()

	req := newConvertRequest(t, map[string][]byte{"bao_cao.docx": []byte("fake-docx")})
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d: %s", res.StatusCode, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["success"] != false || payload["needLibreOffice"] != true {
		t.Errorf("unexpected error payload: %v", payload)
	}
}

func TestConvertUnsupportedExtension(t *testing.T) {
	useFakeSoffice(t)
	req := newConvertRequest(t, map[string][]byte{"anh.png": []byte("PNG")})
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["success"] != false {
		t.Errorf("unexpected payload: %v", payload)
	}
}

func TestConvertMethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/convert", nil)
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// drainConvertSemaphore xả mọi slot convert còn giữ (dọn dẹp sau test).
func drainConvertSemaphore() {
	for {
		select {
		case <-convertSemaphore:
		default:
			return
		}
	}
}

// TestConvertSemaphoreHeldUntilConverterEnds (S9): converter giả block;
// workDir còn tồn tại trong lúc chạy, bị xóa sau khi handler return,
// semaphore giữ đến cuối.
func TestConvertSemaphoreHeldUntilConverterEnds(t *testing.T) {
	orig := convertOfficeToPdfFunc
	defer func() { convertOfficeToPdfFunc = orig; drainConvertSemaphore() }()
	drainConvertSemaphore()

	var workDirSeen string
	release := make(chan struct{})
	started := make(chan struct{})
	convertOfficeToPdfFunc = func(ctx context.Context, inputs []string, outDir, engine string, timeoutSec int) ([]string, error) {
		workDirSeen = filepath.Dir(outDir)
		close(started)
		<-release // block đến khi test cho phép
		// Converter thật tự tạo outDir — fake làm giống.
		if err := os.MkdirAll(outDir, 0750); err != nil {
			return nil, err
		}
		out := filepath.Join(outDir, "bao_cao.pdf")
		if err := os.WriteFile(out, []byte("%PDF-1.4 fake"), 0644); err != nil {
			return nil, err
		}
		return []string{out}, nil
	}

	req := newConvertRequest(t, map[string][]byte{"bao_cao.docx": []byte("fake-docx")})
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handleConvertOffice(rec, req)
		close(done)
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatalf("converter giả không chạy trong 5s")
	}
	// Trong lúc converter chạy: workDir phải còn, semaphore giữ 1 slot.
	if _, err := os.Stat(workDirSeen); err != nil {
		t.Fatalf("workDir %q không còn trong lúc converter chạy: %v", workDirSeen, err)
	}
	if n := len(convertSemaphore); n != 1 {
		t.Fatalf("trong lúc converter chạy: len(convertSemaphore) = %d, muốn 1", n)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("handler không return sau khi converter xong")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("sau khi converter xong: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Sau khi handler return: workDir đã xóa, semaphore đã nhả.
	if _, err := os.Stat(workDirSeen); !os.IsNotExist(err) {
		t.Errorf("workDir %q còn tồn tại sau khi handler return", workDirSeen)
	}
	if n := len(convertSemaphore); n != 0 {
		t.Errorf("sau khi handler return: len(convertSemaphore) = %d, muốn 0", n)
	}
}

// TestConvertContextCancelStopsConverter (S9): client ngắt giữa chừng →
// converter nhận hủy, handler return 504, semaphore được nhả.
func TestConvertContextCancelStopsConverter(t *testing.T) {
	orig := convertOfficeToPdfFunc
	defer func() { convertOfficeToPdfFunc = orig; drainConvertSemaphore() }()
	drainConvertSemaphore()

	cancelSeen := make(chan struct{})
	started := make(chan struct{})
	convertOfficeToPdfFunc = func(ctx context.Context, inputs []string, outDir, engine string, timeoutSec int) ([]string, error) {
		close(started)
		select {
		case <-ctx.Done():
			close(cancelSeen)
			return nil, ctx.Err()
		case <-time.After(30 * time.Second):
			return nil, fmt.Errorf("converter không bị hủy")
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	req := newConvertRequest(t, map[string][]byte{"bao_cao.docx": []byte("fake-docx")})
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handleConvertOffice(rec, req)
		close(done)
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatalf("converter giả không chạy trong 5s")
	}
	cancel()
	select {
	case <-cancelSeen:
	case <-time.After(5 * time.Second):
		t.Fatalf("converter không nhận được hủy trong 5s")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("handler không return sau khi hủy")
	}
	if rec.Code != http.StatusGatewayTimeout {
		t.Errorf("sau khi hủy: status = %d, muốn 504", rec.Code)
	}
	if n := len(convertSemaphore); n != 0 {
		t.Errorf("sau khi hủy: len(convertSemaphore) = %d, muốn 0", n)
	}
}

// TestConvertPanicRecovery (S9): converter panic → response 500, process sống,
// semaphore được nhả.
func TestConvertPanicRecovery(t *testing.T) {
	orig := convertOfficeToPdfFunc
	defer func() { convertOfficeToPdfFunc = orig; drainConvertSemaphore() }()
	convertOfficeToPdfFunc = func(ctx context.Context, inputs []string, outDir, engine string, timeoutSec int) ([]string, error) {
		panic("converter boom")
	}

	req := newConvertRequest(t, map[string][]byte{"bao_cao.docx": []byte("fake-docx")})
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("panic converter: status = %d, muốn 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "conversion panic") {
		t.Errorf("panic converter: body = %q, muốn chứa \"conversion panic\"", rec.Body.String())
	}
	if n := len(convertSemaphore); n != 0 {
		t.Errorf("sau panic: len(convertSemaphore) = %d, muốn 0", n)
	}
}

// TestConvertMaxTwoConcurrent (S9): tối đa 2 conversion đồng thời;
// request thứ 3 chờ 5s rồi nhận 503.
func TestConvertMaxTwoConcurrent(t *testing.T) {
	drainConvertSemaphore()
	for i := 0; i < 2; i++ {
		convertSemaphore <- struct{}{}
	}
	defer drainConvertSemaphore()

	start := time.Now()
	req := newConvertRequest(t, map[string][]byte{"bao_cao.docx": []byte("fake-docx")})
	rec := httptest.NewRecorder()
	handleConvertOffice(rec, req)
	elapsed := time.Since(start)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("slot đầy: status = %d, muốn 503", rec.Code)
	}
	if elapsed < 4*time.Second || elapsed > 8*time.Second {
		t.Errorf("slot đầy: chờ %v, muốn ~5s", elapsed)
	}
}
