package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

//go:embed all:web
var webFS embed.FS

// optimizeSemaphore giới hạn số lượng tác vụ nén đồng thời của Goroutine
// để tăng tốc xử lý nhưng tuyệt đối không làm treo máy hoặc ngốn tài nguyên lớn.
var optimizeSemaphore = make(chan struct{}, 3)

func handleOptimizePDF(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Chỉ chấp nhận phương thức POST", http.StatusMethodNotAllowed)
		return
	}

	// Đọc dữ liệu PDF tải lên (tối đa 150MB)
	r.Body = http.MaxBytesReader(w, r.Body, 150*1024*1024)
	pdfBytes, err := io.ReadAll(r.Body)
	if err != nil || len(pdfBytes) == 0 {
		http.Error(w, "Không thể đọc dữ liệu PDF", http.StatusBadRequest)
		return
	}

	// Chờ lấy slot trong Goroutine semaphore hoặc hủy nếu client ngắt kết nối
	select {
	case optimizeSemaphore <- struct{}{}:
		defer func() { <-optimizeSemaphore }()
	case <-r.Context().Done():
		return
	case <-time.After(5 * time.Second):
		http.Error(w, "Máy chủ đang bận xử lý tác vụ khác, vui lòng thử lại sau", http.StatusServiceUnavailable)
		return
	}

	type optimizeResult struct {
		data []byte
		err  error
	}

	resCh := make(chan optimizeResult, 1)

	// Chạy nén và tối ưu hóa luồng dữ liệu song song qua Goroutine
	go func() {
		conf := model.NewDefaultConfiguration()
		conf.ValidationMode = model.ValidationRelaxed
		conf.Optimize = true
		conf.OptimizeResourceDicts = true
		conf.OptimizeDuplicateContentStreams = true
		conf.WriteObjectStream = true
		conf.WriteXRefStream = true

		rs := bytes.NewReader(pdfBytes)
		var outBuf bytes.Buffer

		if err := api.Optimize(rs, &outBuf, conf); err != nil {
			resCh <- optimizeResult{err: err}
			return
		}

		resCh <- optimizeResult{data: outBuf.Bytes()}
	}()

	select {
	case <-r.Context().Done():
		return
	case res := <-resCh:
		if res.err != nil {
			http.Error(w, fmt.Sprintf("Lỗi tối ưu hóa PDF: %v", res.err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(res.data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(res.data)

	case <-time.After(30 * time.Second):
		http.Error(w, "Hết thời gian chờ xử lý tối ưu hóa PDF", http.StatusGatewayTimeout)
	}
}

var (
	initialFilePath string
	initialFileMu   sync.RWMutex
)

func setInitialFile(path string) {
	initialFileMu.Lock()
	defer initialFileMu.Unlock()
	if path != "" {
		if abs, err := filepath.Abs(path); err == nil {
			initialFilePath = abs
		} else {
			initialFilePath = path
		}
	} else {
		initialFilePath = ""
	}
}

func getInitialFile() string {
	initialFileMu.RLock()
	defer initialFileMu.RUnlock()
	return initialFilePath
}

func runUI(args []string, initialFile string) {
	if initialFile != "" {
		setInitialFile(initialFile)
	}

	desiredPort := 8080
	for i := 0; i < len(args); i++ {
		if args[i] == "-p" || args[i] == "--port" {
			if i+1 < len(args) {
				if p, err := strconv.Atoi(args[i+1]); err == nil && p > 0 {
					desiredPort = p
				}
			}
		}
	}

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		fmt.Printf("[LỖI] Không thể nạp tài nguyên Web: %v\n", err)
		return
	}

	// Tự động dò cổng mạng khả dụng (bắt đầu từ desiredPort)
	var listener net.Listener
	var actualPort int
	for p := desiredPort; p < desiredPort+50; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			listener = l
			actualPort = p
			break
		}
	}
	if listener == nil {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fmt.Printf("[LỖI] Không thể khởi tạo cổng mạng: %v\n", err)
			return
		}
		listener = l
		actualPort = listener.Addr().(*net.TCPAddr).Port
	}

	url := fmt.Sprintf("http://127.0.0.1:%d", actualPort)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/optimize", handleOptimizePDF)
	mux.HandleFunc("/api/shutdown", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
		go func() {
			time.Sleep(350 * time.Millisecond)
			fmt.Println("\n[INFO] Đang đóng ứng dụng theo yêu cầu từ giao diện...")
			os.Exit(0)
		}()
	})

	// Trả về thông tin tệp PDF được truyền vào khi khởi chạy (qua CLI hoặc Context Menu)
	mux.HandleFunc("/api/initial-file", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		filePath := getInitialFile()
		if filePath == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"has_file": false})
			return
		}
		fi, err := os.Stat(filePath)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"has_file": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"has_file": true,
			"filename": filepath.Base(filePath),
			"path":     filePath,
			"size":     fi.Size(),
		})
	})

	// Tải dữ liệu nhị phân của tệp PDF được chỉ định khi khởi chạy
	mux.HandleFunc("/api/initial-file/content", func(w http.ResponseWriter, r *http.Request) {
		filePath := getInitialFile()
		if filePath == "" {
			http.Error(w, "Không có tệp ban đầu", http.StatusNotFound)
			return
		}
		// #nosec G304 -- filePath từ tham số khởi chạy cục bộ (initial-file), không lấy từ HTTP request
		data, err := os.ReadFile(filePath)
		if err != nil {
			http.Error(w, fmt.Sprintf("Không thể đọc tệp: %v", err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename=%q`, filepath.Base(filePath)))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)

		// Tự động giải phóng tệp ban đầu sau khi đã nạp lần đầu, tránh bị nạp đè lại khi F5
		setInitialFile("")
	})

	// Kiểm tra trạng thái đăng ký Menu chuột phải Windows
	mux.HandleFunc("/api/context-menu/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		installed := isContextMenuInstalled()
		_ = json.NewEncoder(w).Encode(map[string]any{"installed": installed})
	})

	// Đăng ký Menu chuột phải Windows qua 1-click từ Web UI
	mux.HandleFunc("/api/context-menu/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Chỉ chấp nhận POST", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		err := installContextMenu()
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})

	// Gỡ bỏ Menu chuột phải Windows qua 1-click từ Web UI
	mux.HandleFunc("/api/context-menu/uninstall", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Chỉ chấp nhận POST", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		err := uninstallContextMenu()
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})

	type cachedAsset struct {
		gzipped []byte
		etag    string
		mime    string
	}
	var staticCache sync.Map

	getMimeType := func(p string) string {
		switch {
		case strings.HasSuffix(p, ".js"):
			return "application/javascript; charset=utf-8"
		case strings.HasSuffix(p, ".css"):
			return "text/css; charset=utf-8"
		case strings.HasSuffix(p, ".html") || p == "/" || p == "":
			return "text/html; charset=utf-8"
		case strings.HasSuffix(p, ".svg"):
			return "image/svg+xml"
		case strings.HasSuffix(p, ".json"):
			return "application/json; charset=utf-8"
		case strings.HasSuffix(p, ".ico"):
			return "image/x-icon"
		default:
			return "application/octet-stream"
		}
	}

	fileServer := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cleanPath := strings.TrimPrefix(r.URL.Path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		// Tối ưu hóa Cache-Control:
		// - Thư viện tĩnh trong vendor/ (pdf.js, pdf-lib,...) không đổi: cache dài hạn immutable
		// - Các tệp ứng dụng (app.js, app.css, index.html): cho phép cache nhưng phải revalidate với ETag (304)
		if strings.HasPrefix(r.URL.Path, "/vendor/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		}

		acceptEncoding := r.Header.Get("Accept-Encoding")
		isCompressible := r.Method != http.MethodHead && (strings.HasSuffix(cleanPath, ".js") ||
			strings.HasSuffix(cleanPath, ".css") ||
			strings.HasSuffix(cleanPath, ".html") ||
			strings.HasSuffix(cleanPath, ".svg") ||
			strings.HasSuffix(cleanPath, ".json"))

		if isCompressible && strings.Contains(acceptEncoding, "gzip") {
			// Kiểm tra bộ đệm nén In-Memory Gzip (Zero-Allocation & TTFB < 0.5ms)
			if val, ok := staticCache.Load(cleanPath); ok {
				cached := val.(*cachedAsset)
				w.Header().Set("Content-Type", cached.mime)
				w.Header().Set("Content-Encoding", "gzip")
				w.Header().Set("Vary", "Accept-Encoding")
				w.Header().Set("ETag", cached.etag)

				if match := r.Header.Get("If-None-Match"); match != "" && match == cached.etag {
					w.WriteHeader(http.StatusNotModified)
					return
				}

				w.Header().Set("Content-Length", strconv.Itoa(len(cached.gzipped)))
				w.WriteHeader(http.StatusOK)
				// #nosec G705 -- chỉ ghi bytes từ embed FS nội bộ với Content-Type whitelist, không phản chiếu input người dùng
				_, _ = w.Write(cached.gzipped)
				return
			}

			// Nạp và nén 1 lần duy nhất từ embed FS, lưu vào cache bộ nhớ cho mọi request tiếp theo
			rawBytes, err := fs.ReadFile(sub, cleanPath)
			if err == nil {
				var gzBuf bytes.Buffer
				gz, _ := gzip.NewWriterLevel(&gzBuf, gzip.BestSpeed)
				_, _ = gz.Write(rawBytes)
				_ = gz.Close()

				gzippedData := gzBuf.Bytes()
				etag := fmt.Sprintf(`"%x-%x"`, len(rawBytes), len(gzippedData))
				mime := getMimeType(cleanPath)

				cached := &cachedAsset{
					gzipped: gzippedData,
					etag:    etag,
					mime:    mime,
				}
				staticCache.Store(cleanPath, cached)

				w.Header().Set("Content-Type", mime)
				w.Header().Set("Content-Encoding", "gzip")
				w.Header().Set("Vary", "Accept-Encoding")
				w.Header().Set("ETag", etag)

				if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
					w.WriteHeader(http.StatusNotModified)
					return
				}

				w.Header().Set("Content-Length", strconv.Itoa(len(gzippedData)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(gzippedData)
				return
			}
		}

		fileServer.ServeHTTP(w, r)
	})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	fmt.Println("========================================================================")
	fmt.Println("  PDF Craft - Bộ công cụ Quản lý & Tối ưu hóa PDF Chuyên nghiệp")
	fmt.Println("========================================================================")
	fmt.Printf("  [✓] Máy chủ ứng dụng đang chạy tại: %s\n", url)
	if filePath := getInitialFile(); filePath != "" {
		fmt.Printf("  [✓] Đang nạp tệp PDF: %s\n", filepath.Base(filePath))
	}
	fmt.Println("  [✓] Đang tự động mở trình duyệt web của bạn...")
	fmt.Println("")
	fmt.Println("  • Lưu ý: Hãy giữ cửa sổ này trong khi bạn đang sử dụng phần mềm.")
	fmt.Println("  • Bạn có thể thu nhỏ (minimize) cửa sổ này xuống thanh Taskbar.")
	fmt.Println("  • Để thoát phần mềm: Nhấn Enter, hoặc phím Q, hoặc Ctrl+C.")
	fmt.Println("  • (Xem hướng dẫn CLI: Mở CMD và gõ 'pdfcraft.exe help')")
	fmt.Println("========================================================================")

	// Lắng nghe tín hiệu dừng (Ctrl+C, SIGINT, SIGTERM)
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\nĐã nhận lệnh thoát. Cảm ơn bạn đã dùng PDF Craft!")
		_ = server.Close()
		os.Exit(0)
	}()

	// Lắng nghe phím Enter hoặc Q từ console để thoát tiện lợi
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			text := strings.TrimSpace(scanner.Text())
			if strings.EqualFold(text, "q") || strings.EqualFold(text, "exit") || strings.EqualFold(text, "quit") || text == "" {
				fmt.Println("\nĐã nhận lệnh thoát từ bàn phím. Cảm ơn bạn đã dùng PDF Craft!")
				_ = server.Close()
				os.Exit(0)
			}
		}
		if err := scanner.Err(); err != nil {
			return
		}
	}()

	// Tự động mở trình duyệt sau khi server khởi động
	go func() {
		time.Sleep(400 * time.Millisecond)
		openBrowser(url)
	}()

	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		fmt.Printf("[LỖI] Máy chủ dừng: %v\n", err)
	}
}

func openBrowser(url string) {
	// Kiểm tra nghiêm ngặt URL nội bộ loopback để chống command injection
	if !strings.HasPrefix(url, "http://127.0.0.1:") {
		return
	}
	for _, ch := range url {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'z') && (ch < 'A' || ch > 'Z') && ch != ':' && ch != '/' && ch != '.' {
			return
		}
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// #nosec G204,G702 -- validated loopback URL
		cmd = exec.Command("cmd", "/c", "start", "", url)
	case "darwin":
		// #nosec G204,G702 -- validated loopback URL
		cmd = exec.Command("open", url)
	default:
		// #nosec G204,G702 -- validated loopback URL
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

type gzipResponseWriter struct {
	io.Writer
	http.ResponseWriter
	wroteHeader bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	w.wroteHeader = true
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.Writer.Write(b)
}
