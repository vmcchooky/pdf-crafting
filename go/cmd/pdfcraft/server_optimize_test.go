package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// drainOptimizeSemaphore xả mọi slot còn giữ (dọn dẹp sau test).
func drainOptimizeSemaphore() {
	for {
		select {
		case <-optimizeSemaphore:
		default:
			return
		}
	}
}

func waitSemaphoreLen(t *testing.T, want int, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(optimizeSemaphore) == want {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return len(optimizeSemaphore) == want
}

// TestOptimizeSemaphoreHeldAfterClientDisconnect (S8): client ngắt giữa chừng
// → handler return, nhưng slot vẫn giữ đến khi optimizer xong mới nhả.
func TestOptimizeSemaphoreHeldAfterClientDisconnect(t *testing.T) {
	orig := optimizePDFFunc
	// slowDone đóng khi optimizer chạy xong — test chờ nó trước khi restore
	// optimizePDFFunc để có happens-before với goroutine (tránh data race).
	slowDone := make(chan struct{})
	optimizePDFFunc = func(rs io.ReadSeeker, w io.Writer, conf *model.Configuration) error {
		defer close(slowDone)
		time.Sleep(2 * time.Second)
		_, err := io.Copy(w, rs)
		return err
	}
	defer func() { optimizePDFFunc = orig; drainOptimizeSemaphore() }()

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/optimize", strings.NewReader("%PDF-1.4 fake"))
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		handleOptimizePDF(rec, req)
		close(done)
	}()
	// Chờ handler lấy slot rồi mới ngắt — tránh race cancel trước khi acquire.
	if !waitSemaphoreLen(t, 1, 5*time.Second) {
		t.Fatalf("handler không lấy slot trong 5s")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("handler không return sau khi client ngắt")
	}

	// Slot PHẢI còn giữ ngay sau khi handler return (goroutine còn chạy).
	if n := len(optimizeSemaphore); n != 1 {
		t.Fatalf("sau khi handler return: len(semaphore) = %d, muốn 1 (goroutine còn chạy)", n)
	}
	// Optimizer xong (~2s) → slot được nhả.
	if !waitSemaphoreLen(t, 0, 5*time.Second) {
		t.Fatalf("sau khi optimizer xong: len(semaphore) = %d, muốn 0", len(optimizeSemaphore))
	}
	// Chờ goroutine báo xong hẳn rồi mới restore hook (xem slowDone).
	select {
	case <-slowDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("optimizer không báo xong trong 5s")
	}
}

// TestOptimizePanicRecovery (S8): optimizer panic → response 500, process
// sống, slot được nhả.
func TestOptimizePanicRecovery(t *testing.T) {
	orig := optimizePDFFunc
	optimizePDFFunc = func(rs io.ReadSeeker, w io.Writer, conf *model.Configuration) error {
		panic("pdfcpu boom")
	}
	defer func() { optimizePDFFunc = orig; drainOptimizeSemaphore() }()

	req := httptest.NewRequest(http.MethodPost, "/api/optimize", strings.NewReader("%PDF-1.4 fake"))
	rec := httptest.NewRecorder()
	handleOptimizePDF(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("panic optimizer: status = %d, muốn 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "optimize panic") {
		t.Errorf("panic optimizer: body = %q, muốn chứa \"optimize panic\"", rec.Body.String())
	}
	if !waitSemaphoreLen(t, 0, 5*time.Second) {
		t.Errorf("sau panic: len(semaphore) = %d, muốn 0", len(optimizeSemaphore))
	}
}

// TestOptimizeMaxThreeConcurrent (S8): tối đa 3 optimize đồng thời;
// request thứ 4 chờ 5s rồi nhận 503 (chưa đọc body vì chưa có slot).
func TestOptimizeMaxThreeConcurrent(t *testing.T) {
	drainOptimizeSemaphore()
	for i := 0; i < 3; i++ {
		optimizeSemaphore <- struct{}{}
	}
	defer drainOptimizeSemaphore()

	start := time.Now()
	req := httptest.NewRequest(http.MethodPost, "/api/optimize", strings.NewReader("%PDF-1.4 fake"))
	rec := httptest.NewRecorder()
	handleOptimizePDF(rec, req)
	elapsed := time.Since(start)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("slot đầy: status = %d, muốn 503", rec.Code)
	}
	if elapsed < 4*time.Second || elapsed > 8*time.Second {
		t.Errorf("slot đầy: chờ %v, muốn ~5s", elapsed)
	}
}
