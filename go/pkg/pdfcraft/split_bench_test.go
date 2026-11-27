package pdfcraft

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// createBenchPDF ghi một PDF tối giản N trang (cùng định dạng với
// createValidTestPDF nhưng nhận *testing.B).
func createBenchPDF(b *testing.B, filePath string, pageCount int) {
	b.Helper()
	var data []byte
	data = append(data, "%PDF-1.4\n"...)
	offsets := make([]int, 0)
	offsets = append(offsets, len(data))
	data = append(data, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"...)
	offsets = append(offsets, len(data))
	kids := ""
	for i := 0; i < pageCount; i++ {
		kids += fmt.Sprintf("%d 0 R ", 3+i*2)
	}
	data = append(data, fmt.Sprintf("2 0 obj\n<< /Type /Pages /Kids [%s] /Count %d >>\nendobj\n", kids, pageCount)...)
	for i := 0; i < pageCount; i++ {
		pageObjNum := 3 + i*2
		contentObjNum := pageObjNum + 1
		offsets = append(offsets, len(data))
		data = append(data, fmt.Sprintf("%d 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents %d 0 R >>\nendobj\n", pageObjNum, contentObjNum)...)
		offsets = append(offsets, len(data))
		streamData := fmt.Sprintf("BT /F1 24 Tf 100 700 Td (Page %d) Tj ET", i+1)
		data = append(data, fmt.Sprintf("%d 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n", contentObjNum, len(streamData), streamData)...)
	}
	xrefOffset := len(data)
	totalObjs := 2 + pageCount*2
	data = append(data, fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", totalObjs+1)...)
	for _, off := range offsets {
		data = append(data, fmt.Sprintf("%010d 00000 n \n", off)...)
	}
	data = append(data, fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", totalObjs+1, xrefOffset)...)
	if err := os.MkdirAll(filepath.Dir(filePath), 0750); err != nil {
		b.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filePath, data, 0600); err != nil {
		b.Fatalf("WriteFile: %v", err)
	}
}

// BenchmarkSplitAll60 đo tách 60 trang thành 60 tệp — thao tác mà
// xử lý song song (worker pool) tác động trực tiếp.
func BenchmarkSplitAll60(b *testing.B) {
	dir := b.TempDir()
	src := filepath.Join(dir, "src60.pdf")
	createBenchPDF(b, src, 60)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out := filepath.Join(dir, fmt.Sprintf("out%d", i))
		if _, err := SplitAll(src, out); err != nil {
			b.Fatalf("SplitAll: %v", err)
		}
	}
}
