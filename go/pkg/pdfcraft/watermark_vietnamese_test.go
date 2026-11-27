package pdfcraft

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// TestWatermarkVietnameseUsesEmbeddedFont kiểm chứng watermark tiếng Việt
// dùng font Unicode nhúng (PDFCraftSans) thay vì Helvetica — trước đây
// Helvetica (WinAnsi) làm mất dấu tiếng Việt. Kiểm qua ngữ cảnh đã parse
// của pdfcpu vì file xuất nén object stream (tìm byte thô không tin cậy).
func TestWatermarkVietnameseUsesEmbeddedFont(t *testing.T) {
	tempDir := t.TempDir()
	src := filepath.Join(tempDir, "src.pdf")
	createValidTestPDF(t, src, 2)

	out := filepath.Join(tempDir, "wm.pdf")
	if err := AddTextWatermark(src, out, "BẢN NHÁP — CHƯA PHÊ DUYỆT", nil, 40, 45, 0.3); err != nil {
		t.Fatalf("AddTextWatermark tiếng Việt lỗi: %v", err)
	}

	if err := api.ValidateFile(out, nil); err != nil {
		t.Fatalf("file watermark không hợp lệ theo pdfcpu: %v", err)
	}

	ctx, err := api.ReadContextFile(out)
	if err != nil {
		t.Fatalf("đọc lại file xuất: %v", err)
	}

	foundFont := false
	foundEmbedded := false
	for _, entry := range ctx.XRefTable.Table {
		d, ok := entry.Object.(types.Dict)
		if !ok {
			continue
		}
		if bf, ok := d["BaseFont"]; ok {
			if name, ok := bf.(types.Name); ok && strings.Contains(string(name), watermarkFontName) {
				foundFont = true
			}
		}
		if _, ok := d["FontFile2"]; ok {
			foundEmbedded = true
		}
	}
	if !foundFont {
		t.Fatalf("file xuất không có font %s — watermark tiếng Việt vẫn dùng font lõi", watermarkFontName)
	}
	if !foundEmbedded {
		t.Fatalf("file xuất không nhúng chương trình font (FontFile2) — máy khác sẽ thiếu font")
	}
}

// TestTextNeedsUnicodeFont chốt ranh giới WinAnsi: chữ Latin-1 thuần
// (café) vẫn dùng Helvetica, ký tự tiếng Việt đặc trưng phải qua font nhúng.
func TestTextNeedsUnicodeFont(t *testing.T) {
	if textNeedsUnicodeFont("DRAFT - café") {
		t.Fatalf("chuỗi Latin-1 thuần không cần font Unicode")
	}
	for _, s := range []string{"BẢN NHÁP", "ĐÃ DUYỆT", "MẬT", "Ước mơ"} {
		if !textNeedsUnicodeFont(s) {
			t.Fatalf("%q cần font Unicode", s)
		}
	}
}
