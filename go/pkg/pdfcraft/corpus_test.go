package pdfcraft

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// writeTestPNG tạo ảnh PNG có hoa văn để làm trang "scan".
func writeTestPNG(tb testing.TB, path string, w, h int) {
	tb.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 7), G: uint8(y * 3), B: 180, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		tb.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		tb.Fatal(err)
	}
}

func corruptStartXref(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	marker := []byte("startxref\n")
	i := bytes.LastIndex(data, marker)
	if i < 0 {
		t.Fatalf("startxref not found in %s", src)
	}
	start := i + len(marker)
	end := start
	for end < len(data) && data[end] >= '0' && data[end] <= '9' {
		end++
	}
	if end == start {
		t.Fatalf("startxref offset not found in %s", src)
	}
	// Chỉ đổi các chữ số của offset, giữ nguyên độ dài và %%EOF để fixture
	// hỏng đúng một chỗ (xref) thay vì hỏng thêm trailer.
	for k := start; k < end; k++ {
		data[k] = '9'
	}
	if err := os.WriteFile(dst, data, 0644); err != nil {
		t.Fatal(err)
	}
}

func truncatedCopy(t *testing.T, src, dst string, cut int) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) <= cut {
		t.Fatalf("file too small to truncate: %s", src)
	}
	if err := os.WriteFile(dst, data[:len(data)-cut], 0644); err != nil {
		t.Fatal(err)
	}
}

// qpdfOutDir trả về thư mục con (nếu PDFCRAFT_QPDF_OUTDIR được đặt) để CI
// chạy qpdf --check; rỗng nghĩa là không xuất.
func qpdfOutDir(t *testing.T) string {
	t.Helper()
	root := os.Getenv("PDFCRAFT_QPDF_OUTDIR")
	if root == "" {
		return ""
	}
	sub := filepath.Join(root, strings.NewReplacer("/", "_", "\\", "_", " ", "_").Replace(t.Name()))
	if err := os.MkdirAll(sub, 0750); err != nil {
		t.Fatal(err)
	}
	return sub
}

func exportForQPDF(t *testing.T, src, outDir string) {
	t.Helper()
	if outDir == "" {
		return
	}
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outDir, filepath.Base(src)), data, 0644); err != nil {
		t.Fatal(err)
	}
}

func requireValid(t *testing.T, path string) {
	t.Helper()
	if err := api.ValidateFile(path, nil); err != nil {
		t.Fatalf("output không hợp lệ (%s): %v", path, err)
	}
}

func TestCorpusOperationsDoNotPanic(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "valid_5p.pdf")
	createValidTestPDF(t, base, 5)

	encrypted := filepath.Join(dir, "encrypted.pdf")
	if err := EncryptPdf(base, encrypted, "matkhau", ""); err != nil {
		t.Fatalf("tạo fixture mã hóa: %v", err)
	}

	brokenXref := filepath.Join(dir, "broken_xref.pdf")
	corruptStartXref(t, base, brokenXref)

	truncated := filepath.Join(dir, "truncated.pdf")
	truncatedCopy(t, base, truncated, 40)

	pngPath := filepath.Join(dir, "scan.png")
	writeTestPNG(t, pngPath, 620, 877)
	scan := filepath.Join(dir, "scan.pdf")
	if err := api.ImportImagesFile([]string{pngPath}, scan, nil, nil); err != nil {
		t.Fatalf("tạo fixture scan: %v", err)
	}

	rotated := filepath.Join(dir, "rotated.pdf")
	if err := RotatePages(base, rotated, []string{"1"}, 90); err != nil {
		t.Fatalf("tạo fixture xoay: %v", err)
	}

	watermarked := filepath.Join(dir, "watermarked.pdf")
	if err := AddTextWatermark(base, watermarked, "BẢN NHÁP — CHƯA PHÊ DUYỆT", []string{"1"}, 40, 45, 0.3); err != nil {
		t.Fatalf("tạo fixture watermark: %v", err)
	}

	t.Run("valid", func(t *testing.T) {
		out := t.TempDir()
		qdir := qpdfOutDir(t)
		if _, err := GetInfo(base); err != nil {
			t.Fatalf("info: %v", err)
		}
		ext := filepath.Join(out, "extract.pdf")
		if err := ExtractPages(base, ext, []string{"1-2"}); err != nil {
			t.Fatalf("extract: %v", err)
		}
		requireValid(t, ext)
		exportForQPDF(t, ext, qdir)

		splitDir := filepath.Join(out, "split")
		files, err := SplitAll(base, splitDir)
		if err != nil {
			t.Fatalf("split: %v", err)
		}
		for _, f := range files {
			requireValid(t, f)
			exportForQPDF(t, f, qdir)
		}

		comp := filepath.Join(out, "compress.pdf")
		if err := CompressPdf(base, comp); err != nil {
			t.Fatalf("compress: %v", err)
		}
		requireValid(t, comp)
		exportForQPDF(t, comp, qdir)
	})

	t.Run("scan", func(t *testing.T) {
		out := t.TempDir()
		qdir := qpdfOutDir(t)
		info, err := GetInfo(scan)
		if err != nil {
			t.Fatalf("info scan: %v", err)
		}
		if info.PageCount != 1 {
			t.Fatalf("scan page count = %d, want 1", info.PageCount)
		}
		comp := filepath.Join(out, "scan_compress.pdf")
		if err := CompressPdf(scan, comp); err != nil {
			t.Fatalf("compress scan: %v", err)
		}
		requireValid(t, comp)
		exportForQPDF(t, comp, qdir)
	})

	t.Run("rotated", func(t *testing.T) {
		qdir := qpdfOutDir(t)
		requireValid(t, rotated)
		exportForQPDF(t, rotated, qdir)
	})

	t.Run("watermarked", func(t *testing.T) {
		qdir := qpdfOutDir(t)
		requireValid(t, watermarked)
		exportForQPDF(t, watermarked, qdir)
	})

	t.Run("encrypted", func(t *testing.T) {
		if _, err := GetInfo(encrypted); err == nil {
			t.Fatal("GetInfo without password must fail on encrypted corpus")
		}
		info, err := GetInfoWithPassword(encrypted, "matkhau")
		if err != nil {
			t.Fatalf("GetInfoWithPassword: %v", err)
		}
		if info.PageCount != 5 {
			t.Fatalf("encrypted page count = %d, want 5", info.PageCount)
		}
	})

	for name, path := range map[string]string{"broken_xref": brokenXref, "truncated": truncated} {
		t.Run(name, func(t *testing.T) {
			out := t.TempDir()
			qdir := qpdfOutDir(t)
			// pdfcpu phải phục hồi được hai fixture này; nếu không, coverage
			// sẽ âm thầm rỗng (mọi thao tác đều lỗi).
			info, err := GetInfo(path)
			if err != nil {
				t.Fatalf("pdfcpu phải phục hồi được %s: %v", name, err)
			}
			if info.PageCount < 1 {
				t.Fatalf("%s: page count = %d", name, info.PageCount)
			}
			ext := filepath.Join(out, "extract.pdf")
			if err := ExtractPages(path, ext, []string{"1"}); err != nil {
				t.Fatalf("extract %s: %v", name, err)
			}
			requireValid(t, ext)
			comp := filepath.Join(out, "compress.pdf")
			if err := CompressPdf(path, comp); err != nil {
				t.Fatalf("compress %s: %v", name, err)
			}
			requireValid(t, comp)
			exportForQPDF(t, comp, qdir)
			splitDir := filepath.Join(out, "split")
			files, err := SplitAll(path, splitDir)
			if err != nil {
				t.Fatalf("split %s: %v", name, err)
			}
			if len(files) != info.PageCount {
				t.Fatalf("split %s tạo %d file, want %d", name, len(files), info.PageCount)
			}
			for _, f := range files {
				requireValid(t, f)
			}
		})
	}
}
