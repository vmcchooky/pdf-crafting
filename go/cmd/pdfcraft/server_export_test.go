package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/vmcchooky/pdf-crafting/go/pkg/pdfcraft"
)

func newFinalizeRequest(t *testing.T, pdfData, bookmarkData []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, part := range []struct {
		field string
		name  string
		data  []byte
	}{
		{field: "pdf", name: "crafted.pdf", data: pdfData},
		{field: "bookmarks", name: "bookmarks.json", data: bookmarkData},
	} {
		fw, err := mw.CreateFormFile(part.field, part.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(part.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/export/finalize", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestFinalizeExportAddsBookmarksToPDF(t *testing.T) {
	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	pdfData, err := os.ReadFile(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	bookmarkData := []byte(`[{"title":"Chapter One","page":2,"kids":[{"title":"Details","page":3}]}]`)
	req := newFinalizeRequest(t, pdfData, bookmarkData)
	rec := httptest.NewRecorder()
	handleFinalizeExport(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/pdf" {
		t.Fatalf("expected application/pdf, got %q", got)
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatal("response is not a PDF")
	}

	resultPath := filepath.Join(t.TempDir(), "result.pdf")
	if err := os.WriteFile(resultPath, rec.Body.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	marks, err := pdfcraft.ListBookmarks(resultPath, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(marks) != 1 || marks[0].Title != "Chapter One" || marks[0].Page != 2 {
		t.Fatalf("unexpected bookmarks: %#v", marks)
	}
	if len(marks[0].Kids) != 1 || marks[0].Kids[0].Title != "Details" || marks[0].Kids[0].Page != 3 {
		t.Fatalf("unexpected nested bookmarks: %#v", marks[0].Kids)
	}
}

func TestFinalizeExportRejectsOutOfRangeBookmark(t *testing.T) {
	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	pdfData, err := os.ReadFile(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	req := newFinalizeRequest(t, pdfData, []byte(`[{"title":"Outside","page":999}]`))
	rec := httptest.NewRecorder()
	handleFinalizeExport(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFinalizeExportRejectsMalformedBookmarkJSON(t *testing.T) {
	pdfPath := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	pdfData, err := os.ReadFile(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	req := newFinalizeRequest(t, pdfData, []byte(`not-json`))
	rec := httptest.NewRecorder()
	handleFinalizeExport(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", rec.Code, rec.Body.String())
	}
}
