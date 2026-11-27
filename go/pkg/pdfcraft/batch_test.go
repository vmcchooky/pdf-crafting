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
