package main

// Test cho POST /api/convert (Office -> PDF).
// Engine "soffice" giả = chính test binary (TestMain + PDFCRAFT_FAKE_SOFFICE),
// nên test chạy được trên mọi OS mà không cần LibreOffice thật.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
