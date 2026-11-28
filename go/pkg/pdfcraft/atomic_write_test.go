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

func TestSaveSafelySyncsBeforeRename(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "out.pdf")
	if err := os.WriteFile(dest, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}

	// Ghi lại mọi lần sync: phải sync đúng file tạm trước khi rename.
	var synced []string
	old := fileSync
	fileSync = func(f *os.File) error {
		synced = append(synced, f.Name())
		return f.Sync()
	}
	defer func() { fileSync = old }()

	if err := saveSafely(dest, dest, func(tmp string) error {
		return os.WriteFile(tmp, []byte("new"), 0600)
	}); err != nil {
		t.Fatal(err)
	}
	if len(synced) == 0 {
		t.Fatal("saveSafely không gọi sync trước rename")
	}
	for _, name := range synced {
		if !strings.Contains(filepath.Base(name), ".tmp_") {
			t.Errorf("sync gọi trên file không phải temp: %s", name)
		}
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("destination = %q, muốn new", data)
	}
	assertNoTempFiles(t, dir)
}

func TestSaveSafelySyncErrorPreservesDestination(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "out.pdf")
	if err := os.WriteFile(dest, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}

	old := fileSync
	fileSync = func(*os.File) error { return errSimulatedWrite }
	defer func() { fileSync = old }()

	err := saveSafely(dest, dest, func(tmp string) error {
		return os.WriteFile(tmp, []byte("new"), 0600)
	})
	if err == nil {
		t.Fatal("sync lỗi nhưng saveSafely không báo lỗi")
	}
	data, readErr := os.ReadFile(dest)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "original" {
		t.Fatalf("destination thay đổi sau lỗi sync: %q", data)
	}
	assertNoTempFiles(t, dir)
}

func TestCopyFileSyncsDestination(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	content := []byte("hello sync world")
	if err := os.WriteFile(src, content, 0600); err != nil {
		t.Fatal(err)
	}

	calls := 0
	old := fileSync
	fileSync = func(f *os.File) error {
		calls++
		return f.Sync()
	}
	defer func() { fileSync = old }()

	if err := copyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Errorf("copyFile gọi sync %d lần, muốn 1", calls)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(content) {
		t.Fatalf("dst = %q, muốn %q", got, content)
	}
}

func TestCopyFileSyncError(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	if err := os.WriteFile(src, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}

	old := fileSync
	fileSync = func(*os.File) error { return errSimulatedWrite }
	defer func() { fileSync = old }()

	if err := copyFile(src, dst); err == nil {
		t.Fatal("sync lỗi nhưng copyFile không báo lỗi")
	}
}

func TestSyncFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.bin")
	if err := os.WriteFile(p, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := syncFile(p); err != nil {
		t.Errorf("syncFile file thật lỗi: %v", err)
	}
	if err := syncFile(filepath.Join(dir, "missing.bin")); err == nil {
		t.Errorf("syncFile file không tồn tại phải lỗi")
	}
	// Thư mục sync là best-effort, không được panic.
	syncDir(dir)
	syncDir(filepath.Join(dir, "missing-dir"))
}

func TestMoveResultFileReplacesDestination(t *testing.T) {
	dir := t.TempDir()
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "converted.pdf")
	dest := filepath.Join(dir, "target.pdf")
	if err := os.WriteFile(src, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := moveResultFile(src, dest); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("destination = %q, want new", data)
	}
	assertNoTempFiles(t, dir)
}

func TestMoveResultFileFailurePreservesDestination(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "target.pdf")
	if err := os.WriteFile(dest, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := moveResultFile(filepath.Join(dir, "missing.pdf"), dest); err == nil {
		t.Fatal("expected error for missing source")
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "old" {
		t.Fatalf("destination changed after failure: %q", data)
	}
	assertNoTempFiles(t, dir)
}
