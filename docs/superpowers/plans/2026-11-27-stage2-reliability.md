# Chặng 2 — Độ tin cậy & tốc độ lõi: kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vá lỗi ghi/convert, thêm kiểm chứng PDF đầu ra (corpus + qpdf), đo hiệu năng vi sai trong CI, và xử lý hàng loạt song song có số đo — tất cả trên nhánh `stage2-reliability`.

**Architecture:** Sửa lỗi tại chỗ trong `go/pkg/pdfcraft` (thông điệp convert, fallback ghi nguyên tử), thêm test corpus sinh tổng hợp + job qpdf độc lập, thêm benchmark Go (cục bộ) và script CLI so sánh `main` vs nhánh trong cùng CI job (non-blocking), mở rộng CLI `compress`/`split` cho nhiều file với worker pool giới hạn. Không thêm dependency, không đổi Web UI.

**Tech Stack:** Go 1.26, pdfcpu v0.15.0, GitHub Actions (ubuntu-latest, qpdf), Python 3 stdlib (script đo), Node/Playwright (không đổi).

**Spec:** `docs/superpowers/specs/2026-11-27-stage2-reliability-design.md`

## Global Constraints

- Không thêm dependency Go mới; chỉ dùng stdlib + pdfcpu hiện có.
- Không đổi Web UI (`web/`, `go/cmd/pdfcraft/web/`), không thêm tính năng ngoài spec.
- Worker pool mặc định `min(GOMAXPROCS, 4)`; được phép hạ nếu số đo cho thấy không có lợi (ghi lý do vào roadmap).
- Ngưỡng cảnh báo benchmark: chậm hơn **20%**; job benchmark **non-blocking** (`continue-on-error: true`).
- Biến môi trường xuất output cho qpdf: `PDFCRAFT_QPDF_OUTDIR` (test chỉ ghi khi biến này được đặt).
- Thông điệp người dùng bằng tiếng Việt, giữ văn phong hiện có.
- **Không tự commit/push**: các bước "Commit" chỉ chạy khi người dùng đồng ý (quy ước repo). Không push/PR khi chưa được duyệt.
- Chạy lệnh Go trong thư mục `go/` (module root).

---

### Task 1: Sửa thông điệp lỗi convert Office (TDD)

**Files:**
- Create: `go/pkg/pdfcraft/office_errors.go`
- Create: `go/pkg/pdfcraft/office_errors_test.go`
- Modify: `go/pkg/pdfcraft/office.go:122` (thay lỗi inline)
- Modify: `go/pkg/pdfcraft/office_ms_windows.go:61-67` (dùng hàm thông điệp mới)

**Interfaces:**
- Produces: `engineMissingError() error`, `msOfficeFailureError(detail string) error` (dùng ở Task 1 và các test convert hiện có).

- [ ] **Step 1: Viết test thất bại**

Tạo `go/pkg/pdfcraft/office_errors_test.go`:

```go
package pdfcraft

import (
	"strings"
	"testing"
)

func TestEngineMissingErrorHasGuidance(t *testing.T) {
	err := engineMissingError()
	if err == nil {
		t.Fatal("expected non-nil error")
	}
	if !strings.Contains(err.Error(), "LibreOffice") {
		t.Fatalf("missing LibreOffice guidance: %v", err)
	}
}

func TestMSOfficeFailureErrorKeepsDetailAndGuidance(t *testing.T) {
	err := msOfficeFailureError("RPC server is unavailable")
	if err == nil {
		t.Fatal("expected non-nil error")
	}
	msg := err.Error()
	for _, want := range []string{"RPC server is unavailable", "LibreOffice", "Microsoft Office"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q missing %q", msg, want)
		}
	}
}
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `go test ./pkg/pdfcraft -run 'TestEngineMissingErrorHasGuidance|TestMSOfficeFailureErrorKeepsDetailAndGuidance' -v`
Expected: FAIL — `undefined: engineMissingError`, `undefined: msOfficeFailureError`.

- [ ] **Step 3: Viết implementation tối thiểu**

Tạo `go/pkg/pdfcraft/office_errors.go`:

```go
package pdfcraft

import "fmt"

// engineMissingError: không tìm thấy engine chuyển đổi nào.
func engineMissingError() error {
	return fmt.Errorf("không tìm thấy LibreOffice hoặc Microsoft Office để chuyển đổi. Hãy cài LibreOffice (https://libreoffice.org) rồi thử lại, hoặc truyền -engine <đường_dẫn_soffice>")
}

// msOfficeFailureError: Office COM có mặt nhưng chuyển đổi thất bại — luôn
// kèm hướng dẫn để người dùng tự xử lý thay vì chỉ thấy lỗi kỹ thuật.
func msOfficeFailureError(detail string) error {
	return fmt.Errorf("chuyển đổi bằng Microsoft Office thất bại: %s. Hãy cài LibreOffice (https://libreoffice.org) hoặc kiểm tra bộ Microsoft Office (Word/Excel/PowerPoint) đã cài đặt đầy đủ", detail)
}
```

Sửa `go/pkg/pdfcraft/office.go` dòng 122: thay `return nil, fmt.Errorf("không tìm thấy LibreOffice hoặc Microsoft Office ...")` bằng `return nil, engineMissingError()`.

Sửa `go/pkg/pdfcraft/office_ms_windows.go` khối `if err != nil` cuối `convertBatchMSOffice` thành:

```go
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return msOfficeFailureError(detail)
	}
```

- [ ] **Step 4: Chạy test để xác nhận pass (gồm test convert hiện có)**

Run: `go test ./pkg/pdfcraft -run 'TestEngineMissingErrorHasGuidance|TestMSOfficeFailureErrorKeepsDetailAndGuidance|TestConvertOfficeErrors' -v`
Expected: PASS. `TestConvertOfficeErrors` phải xanh trên máy Windows này (lỗi COM giờ chứa "LibreOffice") và trên Linux (đường engineMissingError).

- [ ] **Step 5: Commit (khi được duyệt)**

```bash
git add go/pkg/pdfcraft/office_errors.go go/pkg/pdfcraft/office_errors_test.go go/pkg/pdfcraft/office.go go/pkg/pdfcraft/office_ms_windows.go
git commit -m "fix(convert): hướng dẫn rõ ràng khi Microsoft Office COM thất bại"
```

---

### Task 2: Vá fallback ghi nguyên tử trong saveSafely (TDD)

**Files:**
- Modify: `go/pkg/pdfcraft/document.go:814-845` (`saveSafely`)
- Create: `go/pkg/pdfcraft/atomic_write_test.go`

**Interfaces:**
- Consumes: `saveSafely(inPath, outPath string, writerFunc func(string) error) error` (giữ nguyên chữ ký; 14 call site không đổi).
- Produces: hành vi mới — không bao giờ xóa/ghi đè đích trước khi thay thế thành công.

- [ ] **Step 1: Viết test thất bại**

Tạo `go/pkg/pdfcraft/atomic_write_test.go`:

```go
package pdfcraft

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var errSimulatedWrite = errors.New("simulated write failure")

func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp_") || strings.HasPrefix(e.Name(), ".tmp_replace_") {
			t.Errorf("leftover temp file: %s", e.Name())
		}
	}
}

func TestSaveSafelyWriterFailurePreservesDestination(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "out.pdf")
	if err := os.WriteFile(dest, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}

	err := saveSafely(dest, dest, func(tmp string) error {
		if err := os.WriteFile(tmp, []byte("partial"), 0600); err != nil {
			return err
		}
		return errSimulatedWrite
	})
	if err == nil {
		t.Fatal("expected error")
	}
	data, readErr := os.ReadFile(dest)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "original" {
		t.Fatalf("destination changed after failure: %q", data)
	}
	assertNoTempFiles(t, dir)
}

func TestSaveSafelyDoesNotDeleteDirectoryDestination(t *testing.T) {
	dir := t.TempDir()
	destDir := filepath.Join(dir, "target-as-dir")
	if err := os.Mkdir(destDir, 0750); err != nil {
		t.Fatal(err)
	}

	err := saveSafely(filepath.Join(dir, "in.pdf"), destDir, func(tmp string) error {
		return os.WriteFile(tmp, []byte("%PDF-1.4"), 0600)
	})
	if err == nil {
		t.Fatal("expected error when destination is a directory")
	}
	fi, statErr := os.Stat(destDir)
	if statErr != nil || !fi.IsDir() {
		t.Fatalf("destination directory was removed or replaced: %v", statErr)
	}
	assertNoTempFiles(t, dir)
}

func TestSaveSafelyReplacesExistingFile(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "out.pdf")
	if err := os.WriteFile(dest, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := saveSafely(dest, dest, func(tmp string) error {
		return os.WriteFile(tmp, []byte("new"), 0600)
	}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("destination not replaced: %q", data)
	}
	assertNoTempFiles(t, dir)
}
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `go test ./pkg/pdfcraft -run 'TestSaveSafely' -v`
Expected: `TestSaveSafelyDoesNotDeleteDirectoryDestination` FAIL (implementation cũ xóa thư mục rỗng rồi rename thành công → err == nil). Hai test còn lại PASS (bảo vệ hành vi sẵn có).

- [ ] **Step 3: Sửa saveSafely**

Thay toàn bộ hàm `saveSafely` trong `go/pkg/pdfcraft/document.go` bằng:

```go
// saveSafely ghi qua file tạm cùng thư mục rồi hoán đổi. Nếu rename thất bại
// (ví dụ đích đang bị khóa) thì copy sang temp phụ rồi rename lại — không bao
// giờ xóa hay ghi trực tiếp lên file đích trước khi thay thế thành công.
func saveSafely(inPath, outPath string, writerFunc func(tempTarget string) error) error {
	absOut, err := filepath.Abs(outPath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(absOut), 0750); err != nil {
		return err
	}

	c := atomic.AddUint64(&tempCounter, 1)
	tempFile := filepath.Join(filepath.Dir(absOut), fmt.Sprintf(".tmp_%d_%d_%d.pdf", os.Getpid(), time.Now().UnixNano(), c))
	defer os.Remove(tempFile)

	if err := writerFunc(tempFile); err != nil {
		return err
	}

	if err := os.Rename(tempFile, absOut); err == nil {
		return nil
	}

	c2 := atomic.AddUint64(&tempCounter, 1)
	replaceTemp := filepath.Join(filepath.Dir(absOut), fmt.Sprintf(".tmp_replace_%d_%d_%d.pdf", os.Getpid(), time.Now().UnixNano(), c2))
	defer os.Remove(replaceTemp)
	if err := copyFile(tempFile, replaceTemp); err != nil {
		return fmt.Errorf("không thể thay thế tệp đích: %w", err)
	}
	if err := os.Rename(replaceTemp, absOut); err != nil {
		return fmt.Errorf("không thể thay thế tệp đích: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Chạy test để xác nhận pass + toàn bộ package**

Run: `go test ./pkg/pdfcraft -run 'TestSaveSafely' -v`
Expected: PASS cả 3 test.
Run: `go test ./pkg/pdfcraft`
Expected: PASS (không hồi quy).

- [ ] **Step 5: Commit (khi được duyệt)**

```bash
git add go/pkg/pdfcraft/document.go go/pkg/pdfcraft/atomic_write_test.go
git commit -m "fix(io): fallback ghi nguyên tử không xóa file đích trước khi thay thế"
```

---

### Task 3: Sửa CI nền (bỏ job Python, thêm cross-build Windows)

**Files:**
- Modify: `.github/workflows/ci.yml:17-29` (xóa job `python`)
- Modify: `.github/workflows/ci.yml:31-43` (thêm bước cross-build trong job `go`)

**Interfaces:**
- Produces: CI không còn job đỏ do `python/` đã move sang `legacy/python/`; job `go` bắt lỗi biên dịch Windows (build tag) trên runner Linux.

- [ ] **Step 1: Xóa job `python`**

Trong `.github/workflows/ci.yml`, xóa nguyên khối:

```yaml
  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install pypdf pillow pytest ruff mypy pyright
      - run: python -m ruff check python/
      - run: python -m ruff format --check python/
      - run: python -m mypy python/pdfcraft/
      - run: python -m pyright
      - run: python -m pytest python/tests -q
```

- [ ] **Step 2: Thêm cross-build vào cuối job `go`**

Sau bước `go test ./...` trong job `go`, thêm:

```yaml
      - name: Cross-build Windows (amd64, arm64)
        working-directory: go
        env:
          CGO_ENABLED: "0"
        run: |
          GOOS=windows GOARCH=amd64 go build ./...
          GOOS=windows GOARCH=arm64 go build ./...
```

- [ ] **Step 3: Xác minh YAML và cross-build tại local**

Run (repo root): `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml', encoding='utf-8')); print('yaml ok')"`
Expected: `yaml ok` (nếu máy không có PyYAML, ghi nhận và bỏ qua bước này — CI sẽ tự parse).
Run: `cd go && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./... && CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build ./...`
Expected: exit 0.

- [ ] **Step 4: Commit (khi được duyệt)**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: bỏ job Python đã chuyển legacy; cross-build Windows trong job go"
```

---

### Task 4: Corpus hồi quy sinh tổng hợp + xuất output cho qpdf

**Files:**
- Create: `go/pkg/pdfcraft/corpus_test.go`

**Interfaces:**
- Consumes: `GetInfo`, `GetInfoWithPassword`, `ExtractPages`, `SplitAll`, `CompressPdf`, `RotatePages`, `AddTextWatermark`, `EncryptPdf` (public sẵn có); `createValidTestPDF(t, path, pages)` (trong `document_test.go`); pdfcpu `api.ImportImagesFile`, `api.ValidateFile`.
- Produces: `writeTestPNG(t *testing.T, path string, w, h int)`; `qpdfOutDir(t *testing.T) string`; test `TestCorpusOperationsDoNotPanic` (Task 5 chạy với `PDFCRAFT_QPDF_OUTDIR`).

- [ ] **Step 1: Viết test (sẽ fail vì thiếu helper/import)**

Tạo `go/pkg/pdfcraft/corpus_test.go`:

```go
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
func writeTestPNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 7), G: uint8(y * 3), B: 180, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
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
	copy(data[i+len(marker):], []byte("999999"))
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
			// Không ràng buộc thành công/thất bại: pdfcpu có thể sửa xref.
			// Yêu cầu duy nhất: không panic, mọi output tạo được phải hợp lệ.
			if _, err := GetInfo(path); err == nil {
				// đọc được là chấp nhận
			}
			ext := filepath.Join(out, "extract.pdf")
			if err := ExtractPages(path, ext, []string{"1"}); err == nil {
				requireValid(t, ext)
			}
			comp := filepath.Join(out, "compress.pdf")
			if err := CompressPdf(path, comp); err == nil {
				requireValid(t, comp)
			}
			splitDir := filepath.Join(out, "split")
			if files, err := SplitAll(path, splitDir); err == nil {
				for _, f := range files {
					requireValid(t, f)
				}
			}
		})
	}
}
```

- [ ] **Step 2: Chạy test**

Run: `go test ./pkg/pdfcraft -run TestCorpusOperationsDoNotPanic -v`
Expected: PASS. Nếu panic/hang xảy ra, đây là bug thật cần điều tra trước khi tiếp tục.

- [ ] **Step 3: Kiểm tra xuất qpdf tại local**

Run (từ `go/`):

```bash
export PDFCRAFT_QPDF_OUTDIR="$(mktemp -d)"
go test ./pkg/pdfcraft -run TestCorpusOperationsDoNotPanic -v
find "$PDFCRAFT_QPDF_OUTDIR" -name '*.pdf' | head
```

Expected: các file PDF xuất hiện (local không cần qpdf; CI sẽ check).

- [ ] **Step 4: Commit (khi được duyệt)**

```bash
git add go/pkg/pdfcraft/corpus_test.go
git commit -m "test: corpus PDF khó sinh tổng hợp, không panic, output hợp lệ"
```

---

### Task 5: Job CI qpdf --check

**Files:**
- Modify: `.github/workflows/ci.yml` (thêm job `qpdf` sau job `go`)

**Interfaces:**
- Consumes: biến `PDFCRAFT_QPDF_OUTDIR` + test `TestCorpus` từ Task 4; binary không cần build.

- [ ] **Step 1: Thêm job**

Thêm vào `.github/workflows/ci.yml`:

```yaml
  qpdf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go/go.mod
      - run: sudo apt-get update && sudo apt-get install -y qpdf
      - name: Generate corpus outputs
        working-directory: go
        env:
          PDFCRAFT_QPDF_OUTDIR: ${{ runner.temp }}/qpdf-out
        run: go test ./pkg/pdfcraft -run TestCorpus -v
      - name: qpdf --check generated outputs and examples
        run: |
          set -euo pipefail
          status=0
          while IFS= read -r -d '' f; do
            echo "-- $f"
            qpdf --check "$f" || status=1
          done < <(find "$RUNNER_TEMP/qpdf-out" examples -name '*.pdf' -print0)
          exit $status
```

- [ ] **Step 2: Xác minh YAML tại local**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml', encoding='utf-8')); print('yaml ok')"`
Expected: `yaml ok`. Không chạy được qpdf local (chưa cài) — ghi nhận trung thực; CI sẽ kiểm chứng.

- [ ] **Step 3: Commit (khi được duyệt)**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: kiểm chứng đầu ra PDF bằng qpdf trên corpus + examples"
```

---

### Task 6: Benchmark Go (cục bộ)

**Files:**
- Create: `go/pkg/pdfcraft/bench_test.go`

**Interfaces:**
- Consumes: `createBenchPDF(b *testing.B, path string, pages int)` (trong `split_bench_test.go`), `writeTestPNG` (Task 4), `GetInfo`, `ExtractPages`, `SplitAll`, `CompressPdf`, `MergeFiles`, `AddTextWatermark`, pdfcpu `api.ImportImagesFile`.
- Produces: các benchmark chạy bằng `go test -bench .`.

- [ ] **Step 1: Viết benchmark**

Tạo `go/pkg/pdfcraft/bench_test.go`:

```go
package pdfcraft

import (
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
		inputs[i] = filepath.Join(dir, "part.pdf")
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
```

Lưu ý: `writeTestPNG` nhận `*testing.T`; đổi chữ ký Task 4 thành interface chung để dùng cho cả `*testing.B`:

Trong `corpus_test.go`, đổi thành:

```go
func writeTestPNG(tb testing.TB, path string, w, h int) {
	tb.Helper()
	...
}
```

(và thay `t.Fatal` bằng `tb.Fatal`). Không đổi call site khác.

- [ ] **Step 2: Chạy thử một benchmark**

Run: `go test ./pkg/pdfcraft -run '^$' -bench 'BenchmarkGetInfo50|BenchmarkCompressScan' -benchtime=2x -v`
Expected: PASS, in số `ns/op` cho 2 benchmark.

- [ ] **Step 3: Commit (khi được duyệt)**

```bash
git add go/pkg/pdfcraft/bench_test.go go/pkg/pdfcraft/corpus_test.go
git commit -m "test(bench): benchmark info/extract/split/compress/merge/watermark/scan"
```

---

### Task 7: Script đo CLI vi sai + job CI non-blocking

**Files:**
- Create: `scripts/bench_compare.py`
- Modify: `.github/workflows/ci.yml` (thêm job `bench`)

**Interfaces:**
- Produces: `python3 scripts/bench_compare.py --base <exe> --head <exe> [--runs 5] [--threshold 20] [--json path]` — exit 0 luôn (chỉ cảnh báo), in bảng + annotation `::warning::` khi hồi quy > ngưỡng.

- [ ] **Step 1: Viết script**

Tạo `scripts/bench_compare.py`:

```python
#!/usr/bin/env python3
"""So sánh hiệu năng CLI pdfcraft: bản base (main) vs head (nhánh).

Chỉ dùng stdlib. Đo xen kẽ base/head trên cùng máy để giảm nhiễu phần cứng.
Không chặn CI: luôn exit 0, chỉ in cảnh báo khi chậm hơn ngưỡng.
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path


def _build_pdf(objs: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


def write_text_pdf(path: Path, pages: int = 50) -> None:
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(pages))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode(),
    ]
    for i in range(pages):
        content = f"BT /F1 24 Tf 72 720 Td (Trang {i + 1}) Tj ET".encode("latin-1")
        objs.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                "/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 "
                f"/BaseFont /Helvetica >> >> >> /Contents {4 + i * 2} 0 R >>"
            ).encode()
        )
        objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    path.write_bytes(_build_pdf(objs))


def write_scan_pdf(path: Path, w: int = 620, h: int = 877) -> None:
    rng = random.Random(42)
    raw = rng.randbytes(w * h * 3)
    image = zlib.compress(raw, 6)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
            + f"{w} {h}".encode()
            + b"] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
        ),
    ]
    content = f"q {w} 0 0 {h} 0 0 cm /Im0 Do Q".encode()
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    objs.append(
        (
            f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
            "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
            f"/Length {len(image)} >>\nstream\n"
        ).encode()
        + image
        + b"\nendstream"
    )
    path.write_bytes(_build_pdf(objs))


def run_once(cmd: list[str]) -> float:
    start = time.perf_counter()
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"{proc.stderr.decode(errors='replace')}"
        )
    return elapsed


def measure(exe: Path, work: Path, runs: int) -> dict[str, list[float]]:
    pdf50 = work / "bench_50p.pdf"
    scan = work / "bench_scan.pdf"
    timings: dict[str, list[float]] = {k: [] for k in ("info50", "extract20", "split50", "compress50", "info_scan", "compress_scan")}
    for _ in range(runs):
        out = Path(tempfile.mkdtemp(dir=work, prefix="out_"))
        timings["info50"].append(run_once([str(exe), "info", str(pdf50)]))
        timings["info_scan"].append(run_once([str(exe), "info", str(scan)]))
        timings["extract20"].append(
            run_once([str(exe), "extract", str(pdf50), "-pages", "1-20", "-o", str(out / "extract.pdf")])
        )
        timings["split50"].append(run_once([str(exe), "split", str(pdf50), "-d", str(out / "split")]))
        timings["compress50"].append(
            run_once([str(exe), "compress", str(pdf50), "-o", str(out / "compress.pdf")])
        )
        timings["compress_scan"].append(
            run_once([str(exe), "compress", str(scan), "-o", str(out / "compress_scan.pdf")])
        )
    return timings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--head", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--threshold", type=float, default=20.0)
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="pdfcraft_bench_") as tmp:
        work = Path(tmp)
        write_text_pdf(work / "bench_50p.pdf")
        write_scan_pdf(work / "bench_scan.pdf")

        base = measure(args.base, work, args.runs)
        head = measure(args.head, work, args.runs)

    report = {}
    regressions = 0
    print(f"{'metric':<14} {'base(min)':>10} {'head(min)':>10} {'delta':>9}")
    for name in base:
        b = min(base[name])
        h = min(head[name])
        delta = (h / b - 1.0) * 100.0 if b > 0 else 0.0
        report[name] = {
            "base_min_s": b,
            "head_min_s": h,
            "base_median_s": statistics.median(base[name]),
            "head_median_s": statistics.median(head[name]),
            "delta_pct": delta,
        }
        flag = ""
        if delta > args.threshold:
            regressions += 1
            flag = "  <== WARN"
            print(f"::warning title=Benchmark regression::{name} chậm hơn {delta:.1f}% so với base")
        print(f"{name:<14} {b:>10.4f} {h:>10.4f} {delta:>8.1f}%{flag}")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nNgưỡng: {args.threshold:.0f}% — {regressions} chỉ số vượt ngưỡng (không chặn CI).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Thêm job `bench` (non-blocking)**

Thêm vào `.github/workflows/ci.yml`:

```yaml
  bench:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go/go.mod
      - name: Build baseline binary (origin/main)
        run: |
          git fetch --depth=1 origin main
          git worktree add "$RUNNER_TEMP/main-tree" FETCH_HEAD
          (cd "$RUNNER_TEMP/main-tree/go" && CGO_ENABLED=0 go build -trimpath -o "$RUNNER_TEMP/pdfcraft-main" ./cmd/pdfcraft)
      - name: Build branch binary
        working-directory: go
        run: CGO_ENABLED=0 go build -trimpath -o "$RUNNER_TEMP/pdfcraft-head" ./cmd/pdfcraft
      - name: Compare CLI performance (warn only)
        run: |
          python3 scripts/bench_compare.py \
            --base "$RUNNER_TEMP/pdfcraft-main" \
            --head "$RUNNER_TEMP/pdfcraft-head" \
            --runs 5 --threshold 20
```

- [ ] **Step 3: Chạy thử tại local (Windows) với 2 bản build**

Run (từ repo root, Git Bash):

```bash
cd go
CGO_ENABLED=0 go build -trimpath -o ../pdfcraft-base.exe ./cmd/pdfcraft
CGO_ENABLED=0 go build -trimpath -o ../pdfcraft-head.exe ./cmd/pdfcraft
cd ..
python scripts/bench_compare.py --base ./pdfcraft-base.exe --head ./pdfcraft-head.exe --runs 3 --threshold 20
rm -f pdfcraft-base.exe pdfcraft-head.exe
```

Expected: bảng 6 chỉ số, delta ~0%, exit 0.

- [ ] **Step 4: Commit (khi được duyệt)**

```bash
git add scripts/bench_compare.py .github/workflows/ci.yml
git commit -m "ci: benchmark CLI vi sai main vs nhánh (cảnh báo, không chặn)"
```

---

### Task 8: Xử lý hàng loạt song song cho compress/split (TDD)

**Files:**
- Create: `go/pkg/pdfcraft/batch.go`
- Create: `go/pkg/pdfcraft/batch_test.go`
- Modify: `go/cmd/pdfcraft/main.go` (`printUsage`, `runSplit`, `runCompress`)

**Interfaces:**
- Produces:
  - `type BatchResult struct { Input, Output string; Err error }`
  - `func ProcessBatch(count, workers int, task func(i int) (string, error)) []BatchResult`
  - `func BatchCompress(inputs []string, outDir string) ([]BatchResult, error)`
  - `func BatchSplit(inputs []string, outRoot string) ([]BatchResult, error)`
  - `var batchConcurrency = func() int` (test seam, mặc định `min(GOMAXPROCS,4)`)
  - CLI: `compress <a.pdf> [b.pdf ...] (-o <đích> | -d <thư_mục>)`; `split <a.pdf> [b.pdf ...] -d <thư_mục>`.

- [ ] **Step 1: Viết test thất bại**

Tạo `go/pkg/pdfcraft/batch_test.go`:

```go
package pdfcraft

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestProcessBatchRunsAllInOrder(t *testing.T) {
	results := ProcessBatch(6, 3, func(i int) (string, error) {
		return fmt.Sprintf("out-%d", i), nil
	})
	if len(results) != 6 {
		t.Fatalf("got %d results, want 6", len(results))
	}
	for i, r := range results {
		if r.Output != fmt.Sprintf("out-%d", i) {
			t.Errorf("result %d = %q", i, r.Output)
		}
	}
}

func TestProcessBatchLimitsConcurrency(t *testing.T) {
	var active, maxActive int32
	results := ProcessBatch(8, 2, func(i int) (string, error) {
		n := atomic.AddInt32(&active, 1)
		for {
			old := atomic.LoadInt32(&maxActive)
			if n <= old || atomic.CompareAndSwapInt32(&maxActive, old, n) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		atomic.AddInt32(&active, -1)
		return "", nil
	})
	if len(results) != 8 {
		t.Fatalf("got %d results", len(results))
	}
	if maxActive > 2 {
		t.Fatalf("max concurrency = %d, want <= 2", maxActive)
	}
}

func TestBatchCompressOutputs(t *testing.T) {
	dir := t.TempDir()
	var inputs []string
	for i := 0; i < 3; i++ {
		p := filepath.Join(dir, fmt.Sprintf("in_%d.pdf", i))
		createValidTestPDF(t, p, 2)
		inputs = append(inputs, p)
	}
	outDir := filepath.Join(dir, "out")
	results, err := BatchCompress(inputs, outDir)
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range results {
		if r.Err != nil {
			t.Fatalf("result %d: %v", i, r.Err)
		}
		if _, statErr := os.Stat(r.Output); statErr != nil {
			t.Fatalf("missing output %s", r.Output)
		}
		requireValid(t, r.Output)
	}
}

func TestBatchCompressDuplicateStems(t *testing.T) {
	dir := t.TempDir()
	aDir := filepath.Join(dir, "a")
	bDir := filepath.Join(dir, "b")
	if err := os.MkdirAll(aDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(bDir, 0750); err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(aDir, "doc.pdf")
	b := filepath.Join(bDir, "doc.pdf")
	createValidTestPDF(t, a, 1)
	createValidTestPDF(t, b, 1)
	outDir := filepath.Join(dir, "out")
	results, err := BatchCompress([]string{a, b}, outDir)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, r := range results {
		if r.Err != nil {
			t.Fatalf("unexpected error: %v", r.Err)
		}
		names[filepath.Base(r.Output)] = true
	}
	if !names["doc.pdf"] || !names["doc_2.pdf"] {
		t.Fatalf("got outputs %v, want doc.pdf + doc_2.pdf", names)
	}
}

func TestBatchCompressPartialFailure(t *testing.T) {
	dir := t.TempDir()
	ok := filepath.Join(dir, "ok.pdf")
	createValidTestPDF(t, ok, 1)
	missing := filepath.Join(dir, "missing.pdf")
	outDir := filepath.Join(dir, "out")
	results, err := BatchCompress([]string{ok, missing}, outDir)
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Err != nil {
		t.Fatalf("ok file failed: %v", results[0].Err)
	}
	if results[1].Err == nil {
		t.Fatal("missing file should fail")
	}
}

func TestBatchSplitCreatesFolders(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.pdf")
	b := filepath.Join(dir, "b.pdf")
	createValidTestPDF(t, a, 3)
	createValidTestPDF(t, b, 2)
	outRoot := filepath.Join(dir, "out")
	results, err := BatchSplit([]string{a, b}, outRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if r.Err != nil {
			t.Fatalf("split error: %v", r.Err)
		}
		files, readErr := os.ReadDir(r.Output)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if len(files) == 0 {
			t.Fatalf("empty split folder %s", r.Output)
		}
	}
}
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `go test ./pkg/pdfcraft -run 'TestProcessBatch|TestBatch' -v`
Expected: FAIL — `undefined: ProcessBatch`, `undefined: BatchCompress`, `undefined: BatchSplit`.

- [ ] **Step 3: Viết batch.go**

Tạo `go/pkg/pdfcraft/batch.go`:

```go
package pdfcraft

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// BatchResult là kết quả xử lý một file trong lô.
type BatchResult struct {
	Input  string
	Output string
	Err    error
}

// batchConcurrency là số worker tối đa; biến để test/đo có thể đổi.
var batchConcurrency = func() int {
	n := runtime.GOMAXPROCS(0)
	if n > 4 {
		n = 4
	}
	if n < 1 {
		n = 1
	}
	return n
}

// ProcessBatch chạy task(i) với worker pool giới hạn, kết quả giữ đúng thứ tự index.
func ProcessBatch(count, workers int, task func(i int) (string, error)) []BatchResult {
	results := make([]BatchResult, count)
	if count == 0 {
		return results
	}
	if workers < 1 {
		workers = 1
	}
	if workers > count {
		workers = count
	}

	indexes := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indexes {
				out, err := task(i)
				results[i] = BatchResult{Output: out, Err: err}
			}
		}()
	}
	for i := 0; i < count; i++ {
		indexes <- i
	}
	close(indexes)
	wg.Wait()
	return results
}

func uniqueBatchPath(dir, stem string, reserved map[string]bool) string {
	candidate := filepath.Join(dir, stem+".pdf")
	counter := 2
	for {
		if _, err := os.Stat(candidate); os.IsNotExist(err) && !reserved[candidate] {
			break
		}
		candidate = filepath.Join(dir, fmt.Sprintf("%s_%d.pdf", stem, counter))
		counter++
	}
	reserved[candidate] = true
	return candidate
}

// BatchCompress nén nhiều file PDF vào outDir, giữ đúng thứ tự đầu vào.
// Một file lỗi không chặn các file khác; lỗi nằm trong BatchResult.Err.
func BatchCompress(inputs []string, outDir string) ([]BatchResult, error) {
	if len(inputs) == 0 {
		return nil, fmt.Errorf("cần ít nhất 1 file PDF để nén")
	}
	absOut, err := filepath.Abs(outDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absOut, 0750); err != nil {
		return nil, fmt.Errorf("không thể tạo thư mục đích: %w", err)
	}

	targets := make([]string, len(inputs))
	reserved := make(map[string]bool, len(inputs))
	for i, in := range inputs {
		absIn, err := filepath.Abs(in)
		if err != nil {
			return nil, err
		}
		stem := strings.TrimSuffix(filepath.Base(absIn), filepath.Ext(absIn))
		targets[i] = uniqueBatchPath(absOut, stem, reserved)
	}

	results := ProcessBatch(len(inputs), batchConcurrency(), func(i int) (string, error) {
		return targets[i], CompressPdf(inputs[i], targets[i])
	})
	for i := range results {
		results[i].Input = inputs[i]
	}
	return results, nil
}

// BatchSplit tách từng file vào thư mục con <outRoot>/<base>_split.
func BatchSplit(inputs []string, outRoot string) ([]BatchResult, error) {
	if len(inputs) == 0 {
		return nil, fmt.Errorf("cần ít nhất 1 file PDF để tách")
	}
	absOut, err := filepath.Abs(outRoot)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absOut, 0750); err != nil {
		return nil, fmt.Errorf("không thể tạo thư mục đích: %w", err)
	}

	dirs := make([]string, len(inputs))
	reserved := make(map[string]bool, len(inputs))
	for i, in := range inputs {
		absIn, err := filepath.Abs(in)
		if err != nil {
			return nil, err
		}
		base := strings.TrimSuffix(filepath.Base(absIn), filepath.Ext(absIn))
		candidate := filepath.Join(absOut, base+"_split")
		for n := 2; reserved[candidate]; n++ {
			candidate = filepath.Join(absOut, fmt.Sprintf("%s_split_%d", base, n))
		}
		reserved[candidate] = true
		dirs[i] = candidate
	}

	results := ProcessBatch(len(inputs), batchConcurrency(), func(i int) (string, error) {
		_, err := SplitAll(inputs[i], dirs[i])
		return dirs[i], err
	})
	for i := range results {
		results[i].Input = inputs[i]
	}
	return results, nil
}
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `go test ./pkg/pdfcraft -run 'TestProcessBatch|TestBatch' -v`
Expected: PASS toàn bộ.

- [ ] **Step 5: Cập nhật CLI**

Trong `go/cmd/pdfcraft/main.go`:

1. Sửa 2 dòng usage:

```go
	fmt.Println("  split   <tệp.pdf> [<tệp2.pdf> ...] [-d <thư_mục_đích>]  Tách từng trang thành các tệp riêng biệt")
	fmt.Println("  compress <tệp.pdf> [<tệp2.pdf> ...] [-o <đích> | -d <thư_mục>]  Tối ưu giảm dung lượng không mất dữ liệu")
```

2. Thay `runSplit` bằng:

```go
func runSplit(args []string) {
	fs := flag.NewFlagSet("split", flag.ExitOnError)
	outDir := fs.String("d", "", "Thư mục lưu các file sau khi tách")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft split <tệp.pdf> [<tệp2.pdf> ...] [-d <thư_mục_đích>]")
		os.Exit(1)
	}

	if len(tail) > 1 {
		if *outDir == "" {
			fmt.Println("[LỖI] Cần -d <thư_mục> khi tách nhiều file")
			os.Exit(1)
		}
		results, err := pdfcraft.BatchSplit(tail, *outDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		failures := 0
		for _, r := range results {
			if r.Err != nil {
				failures++
				fmt.Fprintf(os.Stderr, "[LỖI] %s: %v\n", filepath.Base(r.Input), r.Err)
				continue
			}
			fmt.Printf("[+] %s -> %s\n", filepath.Base(r.Input), r.Output)
		}
		if failures > 0 {
			fmt.Fprintf(os.Stderr, "[LỖI] %d/%d file thất bại\n", failures, len(results))
			os.Exit(1)
		}
		return
	}

	inFile := tail[0]
	targetDir := *outDir
	if targetDir == "" {
		base := strings.TrimSuffix(filepath.Base(inFile), filepath.Ext(inFile))
		targetDir = filepath.Join(filepath.Dir(inFile), base+"_split")
	}

	fmt.Printf("[*] Đang tách các trang từ '%s' vào thư mục '%s'...\n", filepath.Base(inFile), targetDir)
	files, err := pdfcraft.SplitAll(inFile, targetDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("[+] Thành công! Đã tạo %d tệp PDF:\n", len(files))
	for _, f := range files {
		fmt.Printf("    • %s\n", filepath.Base(f))
	}
}
```

3. Thay `runCompress` bằng:

```go
func runCompress(args []string) {
	fs := flag.NewFlagSet("compress", flag.ExitOnError)
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	outDir := fs.String("d", "", "Thư mục đích khi nén nhiều file")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft compress <tệp.pdf> [<tệp2.pdf> ...] [-o <kết_quả.pdf> | -d <thư_mục>]")
		os.Exit(1)
	}
	if *outFile != "" && *outDir != "" {
		fmt.Println("[LỖI] Chỉ dùng một trong -o hoặc -d")
		os.Exit(1)
	}

	if len(tail) > 1 || *outDir != "" {
		if *outDir == "" {
			fmt.Println("[LỖI] Cần -d <thư_mục> khi nén nhiều file")
			os.Exit(1)
		}
		results, err := pdfcraft.BatchCompress(tail, *outDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		failures := 0
		for _, r := range results {
			if r.Err != nil {
				failures++
				fmt.Fprintf(os.Stderr, "[LỖI] %s: %v\n", filepath.Base(r.Input), r.Err)
				continue
			}
			fmt.Printf("[+] %s -> %s\n", filepath.Base(r.Input), r.Output)
		}
		if failures > 0 {
			fmt.Fprintf(os.Stderr, "[LỖI] %d/%d file thất bại\n", failures, len(results))
			os.Exit(1)
		}
		return
	}

	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	before := fileSizeOf(inFile)
	fmt.Printf("[*] Đang tối ưu không mất dữ liệu '%s'...\n", filepath.Base(inFile))
	if err := pdfcraft.CompressPdf(inFile, targetOut); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	after := fileSizeOf(targetOut)
	savedPct := 0.0
	if before > 0 {
		savedPct = (1 - float64(after)/float64(before)) * 100
	}
	fmt.Printf("[+] Thành công! %s -> %s (giảm %.1f%%). Lưu tại: %s\n",
		formatBytes(before), formatBytes(after), savedPct, targetOut)
}
```

- [ ] **Step 6: Build + test CLI thực tế**

Run: `go build ./... && go test ./...`
Expected: PASS.
Run (từ `go/`):

```bash
go build -o ../PDFCraft.exe ./cmd/pdfcraft
cd ..
cp examples/sample_doc.pdf /tmp/a.pdf && cp examples/sample_doc.pdf /tmp/b.pdf
./PDFCraft.exe compress /tmp/a.pdf /tmp/b.pdf -d /tmp/pdfcraft_out
./PDFCraft.exe split /tmp/a.pdf /tmp/b.pdf -d /tmp/pdfcraft_split
```

Expected: `compress` tạo `/tmp/pdfcraft_out/a.pdf`, `b.pdf`; `split` tạo `/tmp/pdfcraft_split/a_split/`, `b_split/`.

- [ ] **Step 7: Commit (khi được duyệt)**

```bash
git add go/pkg/pdfcraft/batch.go go/pkg/pdfcraft/batch_test.go go/cmd/pdfcraft/main.go
git commit -m "feat(cli): compress/split hàng loạt với worker pool giới hạn"
```

---

### Task 9: Đo batch song song và chốt mặc định

**Files:**
- Modify: `go/pkg/pdfcraft/batch_test.go` (thêm benchmark)
- Modify: `ENGINEERING-ROADMAP.md` (ghi số đo + quyết định)

**Interfaces:**
- Consumes: `ProcessBatch`, `batchConcurrency`, `CompressPdf`, `createBenchPDF`.

- [ ] **Step 1: Thêm benchmark so sánh số worker**

Thêm vào cuối `go/pkg/pdfcraft/batch_test.go`:

```go
func BenchmarkBatchCompressWorkers(b *testing.B) {
	for _, workers := range []int{1, 2, 4} {
		b.Run(fmt.Sprintf("workers-%d", workers), func(b *testing.B) {
			dir := b.TempDir()
			inputs := make([]string, 10)
			for i := range inputs {
				inputs[i] = filepath.Join(dir, fmt.Sprintf("in_%d.pdf", i))
				createBenchPDF(b, inputs[i], 20)
			}
			outDir := filepath.Join(dir, "out")
			if err := os.MkdirAll(outDir, 0750); err != nil {
				b.Fatal(err)
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				ProcessBatch(len(inputs), workers, func(idx int) (string, error) {
					target := filepath.Join(outDir, fmt.Sprintf("out_%d_%d.pdf", idx, i))
					return target, CompressPdf(inputs[idx], target)
				})
			}
		})
	}
}
```

- [ ] **Step 2: Chạy benchmark, ghi số**

Run: `go test ./pkg/pdfcraft -run '^$' -bench BenchmarkBatchCompressWorkers -benchtime=5x -v`
Expected: in `ns/op` cho workers-1/2/4. Ghi lại số vào báo cáo cuối.

- [ ] **Step 3: Chốt mặc định theo số đo**

Quy tắc:
- Nếu workers = min(GOMAXPROCS,4) **không nhanh hơn** workers-1 quá 5% trên máy này → đặt mặc định về 1 worker (vẫn giữ code pool + test concurrency), kèm comment lý do và số đo trong `batch.go`.
- Ngược lại giữ `min(GOMAXPROCS,4)`.

Nếu phải đổi, sửa `batchConcurrency`:

```go
// Số đo 2026-11-27 (bench BenchmarkBatchCompressWorkers, 10 file × 20 trang):
// workers-1: X ns/op, workers-2: Y, workers-4: Z — song song không có lợi
// trên máy đo (ưu tiên RAM/ổn định), nên mặc định tuần tự.
var batchConcurrency = func() int { return 1 }
```

(Thay X/Y/Z bằng số thật.)

- [ ] **Step 4: Ghi kết quả vào roadmap**

Trong `ENGINEERING-ROADMAP.md`, mục Chặng 2 → "Xử lý hàng loạt song song": ghi số đo + quyết định thật (workers mặc định, lý do). Nếu giữ song song, nêu rõ cap và máy đo.

- [ ] **Step 5: Commit (khi được duyệt)**

```bash
git add go/pkg/pdfcraft/batch.go go/pkg/pdfcraft/batch_test.go ENGINEERING-ROADMAP.md
git commit -m "perf(batch): chốt mức song song theo số đo thực"
```

---

### Task 10: Spike incremental save + cập nhật roadmap

**Files:**
- Modify: `ENGINEERING-ROADMAP.md` (Chặng 2 + ghi chú quyết định)

**Interfaces:**
- Không sản xuất code; kết quả là kết luận có bằng chứng.

- [ ] **Step 1: Kiểm chứng pdfcpu**

Run (từ `go/`):

```bash
grep -rn "TODO enable incremental writing" "$(go env GOMODCACHE)/github.com/pdfcpu/pdfcpu@v0.15.0/pkg/pdfcpu/model/xreftable.go"
grep -rn "no incremental updates" "$(go env GOMODCACHE)/github.com/pdfcpu/pdfcpu@v0.15.0/pkg/pdfcpu/read.go"
go doc github.com/pdfcpu/pdfcpu/pkg/api | grep -i "incremental"
```

Expected: xác nhận chỉ có TODO/ghi chú đọc, không có API ghi incremental.

- [ ] **Step 2: Ghi kết luận + trạng thái Chặng 2 vào roadmap**

Trong `ENGINEERING-ROADMAP.md`:
- Đánh dấu `[x]` các mục Chặng 2 đã làm: ghi nguyên tử (test lỗi ghi), qpdf CI, corpus, benchmark CI (non-blocking), xử lý hàng loạt (kèm số đo + quyết định), spike incremental.
- Với spike: ghi kết luận **không làm** — pdfcpu v0.15.0 chỉ đọc file incremental (`read.go:1683` giả định một xref section) và có TODO "enable incremental writing" (`model/xreftable.go:3308`); không tự viết append layer.
- Ghi chú `merge` không song song (một đầu ra).

- [ ] **Step 3: Commit (khi được duyệt)**

```bash
git add ENGINEERING-ROADMAP.md
git commit -m "docs(roadmap): cập nhật trạng thái Chặng 2 + kết luận incremental save"
```

---

### Task 11: Xác minh cuối

**Files:** không sửa; chỉ chạy kiểm chứng.

- [ ] **Step 1: Định dạng + vet + test + build**

Run (từ `go/`):

```bash
test -z "$(gofmt -l .)" && echo "gofmt ok"
go vet ./...
go test ./...
go build ./...
```

Expected: tất cả PASS (gồm `TestConvertOfficeErrors` trên Windows).

- [ ] **Step 2: Cross-build Windows + Linux**

Run:

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...
```

Expected: exit 0.

- [ ] **Step 3: Đồng bộ Web embed + test web (không đổi UI nhưng CI chạy)**

Run (từ repo root):

```bash
python scripts/sync_web.py --check
node --test web/tests/utils.test.js
```

Expected: `--check` không báo drift; test Node PASS. (Nếu máy thiếu Node/Playwright, ghi nhận trung thực.)

- [ ] **Step 4: Kiểm tra git status**

Run: `git status -sb`
Expected: chỉ các file thuộc phạm vi; không file rác (không commit `PDFCraft.exe`, `bench_work/`, `web/node_modules/`).

- [ ] **Step 5: Báo cáo**

Tổng hợp: số đo benchmark batch, kết quả test local, việc qpdf chỉ kiểm chứng được trên CI, và đề xuất bước tiếp theo (commit/push/PR cần người dùng duyệt).

---

## Self-Review

- **Spec coverage:** 7 mục spec ↔ Task 1 (convert), Task 2 (saveSafely), Task 3 (CI nền), Task 4–5 (corpus + qpdf), Task 6–7 (benchmark), Task 8–9 (batch), Task 10 (spike + docs), Task 11 (xác minh). Đủ.
- **Placeholder scan:** không có TODO/TBD; mọi code step có code thật. Task 9 có X/Y/Z chờ số đo — đây là số liệu cần thu thập, không phải placeholder thiết kế.
- **Type consistency:** `ProcessBatch(count, workers, task func(i int) (string, error))`, `BatchResult{Input, Output, Err}`, `qpdfOutDir`, `writeTestPNG(tb testing.TB, ...)` dùng nhất quán giữa Task 4, 6, 8.
- **Ràng buộc:** không thêm dependency; commit/push cần duyệt.
