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
	for reserved[strings.ToLower(candidate)] {
		candidate = filepath.Join(dir, fmt.Sprintf("%s_%d.pdf", stem, counter))
		counter++
	}
	reserved[strings.ToLower(candidate)] = true
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
		key := strings.ToLower(candidate)
		for n := 2; reserved[key]; n++ {
			candidate = filepath.Join(absOut, fmt.Sprintf("%s_split_%d", base, n))
			key = strings.ToLower(candidate)
		}
		reserved[key] = true
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
