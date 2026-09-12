package pdfcraft

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// createValidTestPDF tạo một tệp PDF hợp lệ với N trang phục vụ kiểm thử.
func createValidTestPDF(t *testing.T, filePath string, pageCount int) {
	t.Helper()

	var b []byte
	b = append(b, "%PDF-1.4\n"...)

	offsets := make([]int, 0)

	// Obj 1: Catalog
	offsets = append(offsets, len(b))
	b = append(b, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"...)

	// Obj 2: Pages
	offsets = append(offsets, len(b))
	kids := ""
	for i := 0; i < pageCount; i++ {
		kids += fmt.Sprintf("%d 0 R ", 3+i*2)
	}
	b = append(b, fmt.Sprintf("2 0 obj\n<< /Type /Pages /Kids [%s] /Count %d >>\nendobj\n", kids, pageCount)...)

	// Pages and Contents
	for i := 0; i < pageCount; i++ {
		pageObjNum := 3 + i*2
		contentObjNum := pageObjNum + 1

		// Page object
		offsets = append(offsets, len(b))
		b = append(b, fmt.Sprintf("%d 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents %d 0 R >>\nendobj\n", pageObjNum, contentObjNum)...)

		// Content stream object
		offsets = append(offsets, len(b))
		streamData := fmt.Sprintf("BT /F1 24 Tf 100 700 Td (Page %d) Tj ET", i+1)
		b = append(b, fmt.Sprintf("%d 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n", contentObjNum, len(streamData), streamData)...)
	}

	// Xref
	xrefOffset := len(b)
	totalObjs := 2 + pageCount*2
	b = append(b, fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", totalObjs+1)...)
	for _, off := range offsets {
		b = append(b, fmt.Sprintf("%010d 00000 n \n", off)...)
	}

	// Trailer
	b = append(b, fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", totalObjs+1, xrefOffset)...)

	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	if err := os.WriteFile(filePath, b, 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
}

func TestParsePageSelection(t *testing.T) {
	tests := []struct {
		spec     string
		maxPages int
		want     []int
		wantErr  bool
	}{
		{"1, 3, 5", 5, []int{1, 3, 5}, false},
		{"2-4", 5, []int{2, 3, 4}, false},
		{"1, 3-5", 5, []int{1, 3, 4, 5}, false},
		{"1, 1, 2", 5, []int{1, 2}, false},
		{"6", 5, nil, true},
		{"0", 5, nil, true},
		{"4-2", 5, nil, true},
	}

	for _, tt := range tests {
		got, err := ParsePageSelection(tt.spec, tt.maxPages)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParsePageSelection(%q, %d) error = %v, wantErr %v", tt.spec, tt.maxPages, err, tt.wantErr)
			continue
		}
		if !tt.wantErr {
			if len(got) != len(tt.want) {
				t.Errorf("ParsePageSelection(%q, %d) got %v, want %v", tt.spec, tt.maxPages, got, tt.want)
			}
		}
	}
}

func TestCoreOperations(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "pdfcraft_test_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	pdf5 := filepath.Join(tempDir, "test_5p.pdf")
	createValidTestPDF(t, pdf5, 5)

	pdfInsert := filepath.Join(tempDir, "test_2p.pdf")
	createValidTestPDF(t, pdfInsert, 2)

	// 1. Test GetInfo
	info, err := GetInfo(pdf5)
	if err != nil {
		t.Fatalf("GetInfo failed: %v", err)
	}
	if info.PageCount != 5 {
		t.Errorf("expected 5 pages, got %d", info.PageCount)
	}
	if len(info.Pages) != 5 {
		t.Errorf("expected 5 page infos, got %d", len(info.Pages))
	}

	// 2. Test SplitAll
	splitDir := filepath.Join(tempDir, "split_out")
	splitFiles, err := SplitAll(pdf5, splitDir)
	if err != nil {
		t.Fatalf("SplitAll failed: %v", err)
	}
	if len(splitFiles) != 5 {
		t.Errorf("expected 5 split files, got %d", len(splitFiles))
	}
	for _, f := range splitFiles {
		inf, err := GetInfo(f)
		if err != nil || inf.PageCount != 1 {
			t.Errorf("split file %s invalid: err=%v, count=%d", f, err, inf.PageCount)
		}
	}

	// 3. Test ExtractPages
	extracted := filepath.Join(tempDir, "extracted.pdf")
	if err := ExtractPages(pdf5, extracted, []string{"1", "3", "5"}); err != nil {
		t.Fatalf("ExtractPages failed: %v", err)
	}
	infExt, _ := GetInfo(extracted)
	if infExt.PageCount != 3 {
		t.Errorf("expected 3 extracted pages, got %d", infExt.PageCount)
	}

	// 4. Test MovePage (move page 4 to page 1)
	moved := filepath.Join(tempDir, "moved.pdf")
	if err := MovePage(pdf5, moved, 4, 1); err != nil {
		t.Fatalf("MovePage failed: %v", err)
	}
	infMoved, _ := GetInfo(moved)
	if infMoved.PageCount != 5 {
		t.Errorf("expected 5 pages after move, got %d", infMoved.PageCount)
	}

	// 5. Test ReorderPages
	reordered := filepath.Join(tempDir, "reordered.pdf")
	if err := ReorderPages(pdf5, reordered, []int{5, 4, 3, 2, 1}); err != nil {
		t.Fatalf("ReorderPages failed: %v", err)
	}
	infReord, _ := GetInfo(reordered)
	if infReord.PageCount != 5 {
		t.Errorf("expected 5 pages after reorder, got %d", infReord.PageCount)
	}

	// 6. Test InsertFromFile
	// Chèn 2 trang từ pdfInsert vào vị trí 2 của pdf5 -> tổng 7 trang
	inserted := filepath.Join(tempDir, "inserted.pdf")
	if err := InsertFromFile(pdf5, pdfInsert, inserted, 2, nil); err != nil {
		t.Fatalf("InsertFromFile failed: %v", err)
	}
	infIns, _ := GetInfo(inserted)
	if infIns.PageCount != 7 {
		t.Errorf("expected 7 pages after insert, got %d", infIns.PageCount)
	}

	// 7. Test DeletePages
	deleted := filepath.Join(tempDir, "deleted.pdf")
	if err := DeletePages(pdf5, deleted, []string{"2", "4"}); err != nil {
		t.Fatalf("DeletePages failed: %v", err)
	}
	infDel, _ := GetInfo(deleted)
	if infDel.PageCount != 3 {
		t.Errorf("expected 3 pages after delete, got %d", infDel.PageCount)
	}
}

func TestP0RotateMergeText(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "pdfcraft_p0_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	pdf5 := filepath.Join(tempDir, "base_5p.pdf")
	createValidTestPDF(t, pdf5, 5)
	pdf2 := filepath.Join(tempDir, "extra_2p.pdf")
	createValidTestPDF(t, pdf2, 2)

	// 1. RotatePages: xoay trang 1 và 3 thêm 90°
	rotated := filepath.Join(tempDir, "rotated.pdf")
	if err := RotatePages(pdf5, rotated, []string{"1", "3"}, 90); err != nil {
		t.Fatalf("RotatePages failed: %v", err)
	}
	infRot, _ := GetInfo(rotated)
	if infRot.PageCount != 5 {
		t.Errorf("expected 5 pages after rotate, got %d", infRot.PageCount)
	}

	// Góc không hợp lệ phải báo lỗi
	if err := RotatePages(pdf5, filepath.Join(tempDir, "bad.pdf"), []string{"1"}, 45); err == nil {
		t.Errorf("expected error for angle=45, got nil")
	}
	// Trang ngoài phạm vi phải báo lỗi
	if err := RotatePages(pdf5, filepath.Join(tempDir, "bad2.pdf"), []string{"99"}, 90); err == nil {
		t.Errorf("expected error for out-of-range page, got nil")
	}

	// 2. MergeFiles: 5 + 2 = 7 trang
	merged := filepath.Join(tempDir, "merged.pdf")
	if err := MergeFiles([]string{pdf5, pdf2}, merged); err != nil {
		t.Fatalf("MergeFiles failed: %v", err)
	}
	infMerged, _ := GetInfo(merged)
	if infMerged.PageCount != 7 {
		t.Errorf("expected 7 pages after merge, got %d", infMerged.PageCount)
	}
	if err := MergeFiles(nil, filepath.Join(tempDir, "empty.pdf")); err == nil {
		t.Errorf("expected error for empty merge input, got nil")
	}

	// 3. ExtractText: file test chứa text "Page N"
	texts, err := ExtractText(pdf5, []string{"1", "3"})
	if err != nil {
		t.Fatalf("ExtractText failed: %v", err)
	}
	if len(texts) != 2 {
		t.Errorf("expected 2 text entries, got %d", len(texts))
	}

	allTexts, err := ExtractText(pdf5, nil)
	if err != nil {
		t.Fatalf("ExtractText(all) failed: %v", err)
	}
	if len(allTexts) != 5 {
		t.Errorf("expected 5 text entries, got %d", len(allTexts))
	}
}

func TestP1SecurityMetaWatermarkCompress(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "pdfcraft_p1_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	pdf5 := filepath.Join(tempDir, "base_5p.pdf")
	createValidTestPDF(t, pdf5, 5)

	// 1. Encrypt: không mật khẩu thì đọc lỗi, đúng mật khẩu thì đọc được
	enc := filepath.Join(tempDir, "enc.pdf")
	if err := EncryptPdf(pdf5, enc, "user123", "owner123"); err != nil {
		t.Fatalf("EncryptPdf failed: %v", err)
	}
	if _, err := GetInfo(enc); err == nil {
		t.Errorf("expected error reading encrypted file without password")
	}
	infEnc, err := GetInfoWithPassword(enc, "user123")
	if err != nil {
		t.Fatalf("GetInfoWithPassword failed: %v", err)
	}
	if infEnc.PageCount != 5 {
		t.Errorf("expected 5 pages, got %d", infEnc.PageCount)
	}
	if _, err := GetInfoWithPassword(enc, "sai-mat-khau"); err == nil {
		t.Errorf("expected error for wrong password")
	}
	if err := EncryptPdf(pdf5, filepath.Join(tempDir, "x.pdf"), "", ""); err == nil {
		t.Errorf("expected error for empty user password")
	}

	// 2. Text với mật khẩu
	texts, err := ExtractTextWithPassword(enc, "user123", []string{"1"})
	if err != nil {
		t.Fatalf("ExtractTextWithPassword failed: %v", err)
	}
	if len(texts) != 1 {
		t.Errorf("expected 1 text entry, got %d", len(texts))
	}

	// 3. Decrypt round-trip
	dec := filepath.Join(tempDir, "dec.pdf")
	if err := DecryptPdf(enc, dec, "user123"); err != nil {
		t.Fatalf("DecryptPdf failed: %v", err)
	}
	infDec, err := GetInfo(dec)
	if err != nil || infDec.PageCount != 5 {
		t.Errorf("decrypted file invalid: err=%v", err)
	}
	if err := DecryptPdf(enc, filepath.Join(tempDir, "bad.pdf"), "sai"); err == nil {
		t.Errorf("expected error for wrong decrypt password")
	}

	// 4. Metadata
	meta := filepath.Join(tempDir, "meta.pdf")
	props := map[string]string{"Title": "Tieu de Go", "Author": "PDF Craft"}
	if err := SetMetadata(pdf5, meta, props); err != nil {
		t.Fatalf("SetMetadata failed: %v", err)
	}
	infMeta, _ := GetInfo(meta)
	if infMeta.Title != "Tieu de Go" || infMeta.Author != "PDF Craft" {
		t.Errorf("metadata not applied: %+v", infMeta)
	}
	if err := SetMetadata(pdf5, filepath.Join(tempDir, "m2.pdf"), nil); err == nil {
		t.Errorf("expected error for empty props")
	}

	// 5. Watermark: đủ 5 trang, tham số sai báo lỗi
	wm := filepath.Join(tempDir, "wm.pdf")
	if err := AddTextWatermark(pdf5, wm, "DRAFT", []string{"1", "2"}, 48, 45, 0.3); err != nil {
		t.Fatalf("AddTextWatermark failed: %v", err)
	}
	infWm, _ := GetInfo(wm)
	if infWm.PageCount != 5 {
		t.Errorf("expected 5 pages after watermark, got %d", infWm.PageCount)
	}
	if err := AddTextWatermark(pdf5, filepath.Join(tempDir, "w2.pdf"), "X", nil, 48, 45, 1.5); err == nil {
		t.Errorf("expected error for opacity > 1")
	}
	if err := AddTextWatermark(pdf5, filepath.Join(tempDir, "w3.pdf"), "  ", nil, 48, 45, 0.3); err == nil {
		t.Errorf("expected error for empty watermark text")
	}

	// 6. Compress lossless: vẫn đủ trang
	opt := filepath.Join(tempDir, "opt.pdf")
	if err := CompressPdf(pdf5, opt); err != nil {
		t.Fatalf("CompressPdf failed: %v", err)
	}
	infOpt, _ := GetInfo(opt)
	if infOpt.PageCount != 5 {
		t.Errorf("expected 5 pages after compress, got %d", infOpt.PageCount)
	}
}

func TestConvertOfficeErrors(t *testing.T) {
	tempDir := t.TempDir()

	// 1. Thiếu input
	if _, err := ConvertOfficeToPdf(nil, tempDir, "fake-engine", 30); err == nil {
		t.Errorf("expected error for empty input")
	}

	// 2. File không tồn tại
	if _, err := ConvertOfficeToPdf(
		[]string{filepath.Join(tempDir, "khong_co.docx")}, tempDir, "fake-engine", 30,
	); err == nil {
		t.Errorf("expected error for missing file")
	}

	// 3. Định dạng không hỗ trợ
	pngPath := filepath.Join(tempDir, "anh.png")
	if err := os.WriteFile(pngPath, []byte("PNG"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := ConvertOfficeToPdf([]string{pngPath}, tempDir, "fake-engine", 30); err == nil {
		t.Errorf("expected error for unsupported extension")
	}

	// 4. Engine không chạy được
	docxPath := filepath.Join(tempDir, "tai_lieu.docx")
	if err := os.WriteFile(docxPath, []byte("fake"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := ConvertOfficeToPdf(
		[]string{docxPath}, tempDir, "definitely-not-an-engine-xyz", 30,
	); err == nil {
		t.Errorf("expected error for bad engine binary")
	}

	// 5. Không có engine -> thông điệp hướng dẫn cài LibreOffice
	if FindOfficeEngine() == "" {
		_, err := ConvertOfficeToPdf([]string{docxPath}, tempDir, "", 30)
		if err == nil || !strings.Contains(err.Error(), "LibreOffice") {
			t.Errorf("expected LibreOffice guidance error, got: %v", err)
		}
	} else {
		t.Skip("LibreOffice present, skipping no-engine assertion")
	}
}

func TestConcurrentOperations(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "pdfcraft_concurrent_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	pdfBase := filepath.Join(tempDir, "base.pdf")
	createValidTestPDF(t, pdfBase, 5)

	var wg sync.WaitGroup
	errCh := make(chan error, 10)

	// Chạy 8 goroutine song song cùng thao tác và ghi file
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			outPath := filepath.Join(tempDir, fmt.Sprintf("out_%d.pdf", idx))
			// Thao tác MovePage
			if err := MovePage(pdfBase, outPath, 5, 1); err != nil {
				errCh <- fmt.Errorf("goroutine %d MovePage failed: %w", idx, err)
				return
			}
			info, err := GetInfo(outPath)
			if err != nil || info.PageCount != 5 {
				errCh <- fmt.Errorf("goroutine %d GetInfo failed: %v", idx, err)
				return
			}
		}(i)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Errorf("Concurrent operation failed: %v", err)
	}
}
