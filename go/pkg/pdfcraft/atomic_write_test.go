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
