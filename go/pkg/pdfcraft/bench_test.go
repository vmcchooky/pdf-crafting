package pdfcraft

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

func benchPDF(b *testing.B, pages int) string {
	b.Helper()
	path := filepath.Join(b.TempDir(), "bench.pdf")
	createBenchPDF(b, path, pages)
	return path
}

func BenchmarkGetInfo50(b *testing.B) {
	path := benchPDF(b, 50)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := GetInfo(path); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkExtract20(b *testing.B) {
	path := benchPDF(b, 50)
	out := filepath.Join(b.TempDir(), "extract.pdf")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := ExtractPages(path, out, []string{"1-20"}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSplitAll10(b *testing.B) {
	path := benchPDF(b, 10)
	base := b.TempDir()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		dir := filepath.Join(base, "split")
		if _, err := SplitAll(path, dir); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCompress50(b *testing.B) {
	path := benchPDF(b, 50)
	out := filepath.Join(b.TempDir(), "compress.pdf")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := CompressPdf(path, out); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkMerge5x10(b *testing.B) {
	dir := b.TempDir()
	inputs := make([]string, 5)
	for i := range inputs {
		inputs[i] = filepath.Join(dir, fmt.Sprintf("part_%d.pdf", i))
		createBenchPDF(b, inputs[i], 10)
	}
	out := filepath.Join(dir, "merged.pdf")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := MergeFiles(inputs, out); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkWatermark50(b *testing.B) {
	path := benchPDF(b, 50)
	out := filepath.Join(b.TempDir(), "watermark.pdf")
	if err := AddTextWatermark(path, out, "BẢN NHÁP", nil, 40, 45, 0.3); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := AddTextWatermark(path, out, "BẢN NHÁP", nil, 40, 45, 0.3); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCompressScan(b *testing.B) {
	dir := b.TempDir()
	pngPath := filepath.Join(dir, "scan.png")
	writeTestPNG(b, pngPath, 620, 877)
	scan := filepath.Join(dir, "scan.pdf")
	if err := api.ImportImagesFile([]string{pngPath}, scan, nil, nil); err != nil {
		b.Fatal(err)
	}
	out := filepath.Join(dir, "scan_compress.pdf")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := CompressPdf(scan, out); err != nil {
			b.Fatal(err)
		}
	}
}
