package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"

	"github.com/vmcchooky/pdf-crafting/go/pkg/pdfcraft"
)

// printVersion in thông tin phiên bản từ dữ liệu build mà Go tự nhúng
// (module version + VCS revision khi build từ checkout git) — không cần
// biến phiên bản duy trì bằng tay.
func printVersion() {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		fmt.Println("pdfcraft (không rõ thông tin build)")
		return
	}
	version := info.Main.Version
	if version == "" || version == "(devel)" {
		version = "dev"
	}
	rev := ""
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" {
			rev = s.Value
		}
	}
	if rev != "" {
		fmt.Printf("pdfcraft %s (commit %s, %s)\n", version, rev[:min(12, len(rev))], info.GoVersion)
	} else {
		fmt.Printf("pdfcraft %s (%s)\n", version, info.GoVersion)
	}
}

func printUsage() {
	fmt.Println("pdfcraft (Go native) - Công cụ xử lý PDF siêu tốc và tối ưu")
	fmt.Println("\nCÁCH DÙNG:")
	fmt.Println("  pdfcraft <lệnh> [tùy chọn...]")
	fmt.Println("\nCÁC LỆNH HỖ TRỢ:")
	fmt.Println("  info    <tệp.pdf>                             Xem thông tin chi tiết, số trang, kích thước")
	fmt.Println("  split   <tệp.pdf> [-d <thư_mục_đích>]         Tách từng trang thành các tệp riêng biệt")
	fmt.Println("  extract <tệp.pdf> -pages <1,3,5-7> -o <đích>  Trích xuất dải trang ra tệp PDF mới")
	fmt.Println("  move    <tệp.pdf> -from <trang> -to <vị_trí> [-o <đích>]   Di chuyển trang tới vị trí mới")
	fmt.Println("  reorder <tệp.pdf> -order <3,1,2,4> [-o <đích>]             Đổi toàn bộ thứ tự các trang")
	fmt.Println("  insert  <đích.pdf> -source <nguồn.pdf> [-at <vị_trí>] [-pages <1,2>] [-o <kết_quả>]  Thêm trang từ tệp khác")
	fmt.Println("  delete  <tệp.pdf> -pages <2,4> [-o <đích>]    Xóa các trang chỉ định khỏi tệp PDF")
	fmt.Println("  rotate  <tệp.pdf> -pages <1,3-4> -angle <90> [-o <đích>]  Xoay trang theo bội số của 90 độ")
	fmt.Println("  merge   <a.pdf> <b.pdf> [...] -o <kết_quả.pdf>  Gộp nhiều file PDF theo đúng thứ tự")
	fmt.Println("  text    <tệp.pdf> [--page <n> | -pages <1,3>] [--password <pw>]  Trích xuất nội dung văn bản")
	fmt.Println("  bookmark <tệp.pdf> [--add <t> --page <n>] [--clear] [--export <f.json>] [--import-json <f.json>] [-o <đích>]  Xem/sửa mục lục")
	fmt.Println("  encrypt <tệp.pdf> --user-pw <pw> [--owner-pw <pw>] [-o <đích>]  Mã hóa file PDF bằng mật khẩu")
	fmt.Println("  decrypt <tệp.pdf> --password <pw> [-o <đích>]  Giải mã file PDF về bản không mật khẩu")
	fmt.Println("  meta    <tệp.pdf> [--title <t>] [--author <t>] ... [-o <đích>]  Sửa metadata tài liệu")
	fmt.Println("  watermark <tệp.pdf> --text <chữ> [--pages <1,2>] [--font-size 48] [--rotation 45] [--opacity 0.3] [-o <đích>]  Đóng dấu chìm")
	fmt.Println("  compress <tệp.pdf> [-o <đích>]  Tối ưu giảm dung lượng không mất dữ liệu")
	fmt.Println("  convert <a.docx> <b.xlsx> [...] [-d <thư_mục>] [--engine <soffice>]  Chuyển Office sang PDF hàng loạt")
	fmt.Println("  ui      [-p <cổng, mặc định 8080>] [tệp.pdf]  Khởi chạy Giao diện Web UI kéo thả mượt mà")
	fmt.Println("  open    <tệp.pdf>                             Khởi chạy Web UI và nạp ngay tệp PDF chỉ định")
	fmt.Println("  version                                       Xem phiên bản và thông tin build")
	fmt.Println("  register-menu                                 Đăng ký PDF Craft vào Menu chuột phải Windows")
	fmt.Println("  unregister-menu                               Gỡ bỏ PDF Craft khỏi Menu chuột phải Windows")
	fmt.Println("  merge-context <a.pdf> [b.pdf ...]             (Menu chuột phải) Gộp các file thành *_merged.pdf")
	fmt.Println("  compress-context <tệp.pdf>                    (Menu chuột phải) Nén nhanh ra *_small.pdf")
	fmt.Println("\nVí dụ:")
	fmt.Println("  pdfcraft info document.pdf")
	fmt.Println("  pdfcraft split document.pdf -d ./pages")
	fmt.Println("  pdfcraft move document.pdf -from 4 -to 1 -o moved.pdf")
	fmt.Println("  pdfcraft insert docA.pdf -source docB.pdf -at 2 -o merged.pdf")
	fmt.Println("  pdfcraft open invoice.pdf")
	fmt.Println("  pdfcraft register-menu")
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

// parseFlagsAndArgs phân tích cờ kể cả khi người dùng truyền file trước cờ (ví dụ: pdfcraft extract file.pdf -pages 1-3)
func parseFlagsAndArgs(fs *flag.FlagSet, args []string) []string {
	var flags []string
	var posArgs []string

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if strings.HasPrefix(arg, "-") {
			flags = append(flags, arg)
			// Nếu cờ có giá trị đi kèm
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				flags = append(flags, args[i+1])
				i++
			}
		} else {
			posArgs = append(posArgs, arg)
		}
	}

	reordered := append(flags, posArgs...)
	_ = fs.Parse(reordered)
	return fs.Args()
}

func isPdfOrExistingFile(path string) bool {
	if strings.HasPrefix(path, "-") {
		return false
	}
	if strings.HasSuffix(strings.ToLower(path), ".pdf") {
		return true
	}
	// #nosec G703 -- CLI cục bộ: path do chính người dùng nhập, không phải dữ liệu từ mạng
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir()
}

func main() {
	if len(os.Args) < 2 {
		// Tự động khởi chạy giao diện Web UI khi người dùng double-click tệp .exe
		runUI(nil, "")
		return
	}

	command := os.Args[1]

	// Kiểm tra nếu tham số đầu tiên là một tệp (chuột phải Open with hoặc kéo thả file vào icon exe)
	if isPdfOrExistingFile(command) {
		runUI(os.Args[2:], command)
		return
	}

	switch command {
	case "version", "--version", "-v":
		printVersion()
	case "open":
		fileArg := ""
		var uiArgs []string
		for _, arg := range os.Args[2:] {
			if fileArg == "" && isPdfOrExistingFile(arg) {
				fileArg = arg
			} else {
				uiArgs = append(uiArgs, arg)
			}
		}
		runUI(uiArgs, fileArg)
	case "register-menu", "install-menu", "menu-install":
		runRegisterMenu()
	case "unregister-menu", "uninstall-menu", "menu-remove":
		runUnregisterMenu()
	case "info":
		runInfo(os.Args[2:])
	case "split":
		runSplit(os.Args[2:])
	case "extract":
		runExtract(os.Args[2:])
	case "move":
		runMove(os.Args[2:])
	case "reorder":
		runReorder(os.Args[2:])
	case "insert":
		runInsert(os.Args[2:])
	case "delete":
		runDelete(os.Args[2:])
	case "rotate":
		runRotate(os.Args[2:])
	case "merge":
		runMerge(os.Args[2:])
	case "text":
		runText(os.Args[2:])
	case "bookmark":
		runBookmark(os.Args[2:])
	case "encrypt":
		runEncrypt(os.Args[2:])
	case "decrypt":
		runDecrypt(os.Args[2:])
	case "meta":
		runMeta(os.Args[2:])
	case "watermark":
		runWatermark(os.Args[2:])
	case "compress":
		runCompress(os.Args[2:])
	case "convert":
		runConvert(os.Args[2:])
	case "merge-context":
		runMergeContext(os.Args[2:])
	case "compress-context":
		runCompressContext(os.Args[2:])
	case "ui":
		fileArg := ""
		var uiArgs []string
		for _, arg := range os.Args[2:] {
			if fileArg == "" && isPdfOrExistingFile(arg) {
				fileArg = arg
			} else {
				uiArgs = append(uiArgs, arg)
			}
		}
		runUI(uiArgs, fileArg)
	case "-p", "--port":
		runUI(os.Args[1:], "")
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Lỗi: Lệnh không xác định '%s'\n\n", command)
		printUsage()
		os.Exit(1)
	}
}

func runInfo(args []string) {
	fs := flag.NewFlagSet("info", flag.ExitOnError)
	password := fs.String("password", "", "Mật khẩu mở file (nếu file mã hóa)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft info <tệp.pdf> [--password <mật_khẩu>]")
		os.Exit(1)
	}
	inputFile := tail[0]

	var info *pdfcraft.DocInfo
	var err error
	if *password != "" {
		info, err = pdfcraft.GetInfoWithPassword(inputFile, *password)
	} else {
		info, err = pdfcraft.GetInfo(inputFile)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	fmt.Println(strings.Repeat("=", 60))
	fmt.Printf(" THÔNG TIN TÀI LIỆU PDF: %s\n", filepath.Base(info.FilePath))
	fmt.Println(strings.Repeat("=", 60))
	fmt.Printf("  - Đường dẫn:     %s\n", info.FilePath)
	fmt.Printf("  - Kích thước:    %s\n", formatBytes(info.FileSize))
	fmt.Printf("  - Tổng số trang: %d\n", info.PageCount)
	if info.Title != "" {
		fmt.Printf("  - Tiêu đề:       %s\n", info.Title)
	}
	if info.Author != "" {
		fmt.Printf("  - Tác giả:       %s\n", info.Author)
	}

	fmt.Println("\n  [Danh sách các trang]")
	fmt.Printf("  %-8s %-24s\n", "Trang", "Kích thước (pt)")
	fmt.Println("  " + strings.Repeat("-", 34))
	for _, p := range info.Pages {
		dimStr := fmt.Sprintf("%.2f x %.2f", p.Width, p.Height)
		fmt.Printf("  %-8d %-24s\n", p.PageNumber, dimStr)
	}
	fmt.Println(strings.Repeat("=", 60))
}

func runSplit(args []string) {
	fs := flag.NewFlagSet("split", flag.ExitOnError)
	outDir := fs.String("d", "", "Thư mục lưu các file sau khi tách")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft split <tệp.pdf> [-d <thư_mục_đích>]")
		os.Exit(1)
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

func runExtract(args []string) {
	fs := flag.NewFlagSet("extract", flag.ExitOnError)
	pages := fs.String("pages", "", "Dải trang trích xuất (ví dụ: '1,3,5-7')")
	outFile := fs.String("o", "", "Đường dẫn file kết quả")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *pages == "" || *outFile == "" {
		fmt.Println("Cách dùng: pdfcraft extract <tệp.pdf> -pages <1,3,5> -o <kết_quả.pdf>")
		os.Exit(1)
	}
	inFile := tail[0]

	pageStrs := strings.Split(*pages, ",")
	for i := range pageStrs {
		pageStrs[i] = strings.TrimSpace(pageStrs[i])
	}

	fmt.Printf("[*] Đang trích xuất các trang [%s] từ '%s'...\n", *pages, filepath.Base(inFile))
	if err := pdfcraft.ExtractPages(inFile, *outFile, pageStrs); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã lưu tệp tại: %s\n", *outFile)
}

func runMove(args []string) {
	fs := flag.NewFlagSet("move", flag.ExitOnError)
	fromPage := fs.Int("from", 0, "Trang cần di chuyển (1-based)")
	toPage := fs.Int("to", 0, "Vị trí đích mới (1-based)")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *fromPage <= 0 || *toPage <= 0 {
		fmt.Println("Cách dùng: pdfcraft move <tệp.pdf> -from <trang> -to <vị_trí> [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	fmt.Printf("[*] Đang di chuyển trang %d tới vị trí %d trong '%s'...\n", *fromPage, *toPage, filepath.Base(inFile))
	if err := pdfcraft.MovePage(inFile, targetOut, *fromPage, *toPage); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã lưu tệp tại: %s\n", targetOut)
}

func runReorder(args []string) {
	fs := flag.NewFlagSet("reorder", flag.ExitOnError)
	orderStr := fs.String("order", "", "Thứ tự trang mới, ví dụ: '3,1,2,4'")
	outFile := fs.String("o", "", "Đường dẫn file kết quả")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *orderStr == "" {
		fmt.Println("Cách dùng: pdfcraft reorder <tệp.pdf> -order <3,1,2> [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	tokens := strings.Split(*orderStr, ",")
	var order []int
	for _, tok := range tokens {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		p, err := strconv.Atoi(tok)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] Trang không hợp lệ trong order: %s\n", tok)
			os.Exit(1)
		}
		order = append(order, p)
	}

	fmt.Printf("[*] Đang sắp xếp lại thứ tự trang theo: %v...\n", order)
	if err := pdfcraft.ReorderPages(inFile, targetOut, order); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã lưu tệp tại: %s\n", targetOut)
}

func runInsert(args []string) {
	fs := flag.NewFlagSet("insert", flag.ExitOnError)
	sourceFile := fs.String("source", "", "Đường dẫn file nguồn chứa trang cần chèn")
	atPos := fs.Int("at", 0, "Vị trí chèn (1-based, mặc định: chèn vào cuối)")
	pages := fs.String("pages", "", "Các trang chọn từ file nguồn (ví dụ: '1,2')")
	outFile := fs.String("o", "", "Đường dẫn file kết quả")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *sourceFile == "" {
		fmt.Println("Cách dùng: pdfcraft insert <đích.pdf> -source <nguồn.pdf> [-at <vị_trí>] [-pages <1,2>] [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	targetFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = targetFile
	}

	targetInfo, err := pdfcraft.GetInfo(targetFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	insertAt := *atPos
	if insertAt <= 0 {
		insertAt = targetInfo.PageCount + 1
	}

	var srcPages []string
	if *pages != "" {
		parts := strings.Split(*pages, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" {
				srcPages = append(srcPages, p)
			}
		}
	}

	fmt.Printf("[*] Đang chèn từ '%s' vào vị trí %d của '%s'...\n", filepath.Base(*sourceFile), insertAt, filepath.Base(targetFile))
	if err := pdfcraft.InsertFromFile(targetFile, *sourceFile, targetOut, insertAt, srcPages); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	resInfo, _ := pdfcraft.GetInfo(targetOut)
	newTotal := 0
	if resInfo != nil {
		newTotal = resInfo.PageCount
	}
	fmt.Printf("[+] Thành công! Tổng số trang hiện tại: %d. Đã lưu tại: %s\n", newTotal, targetOut)
}

func runDelete(args []string) {
	fs := flag.NewFlagSet("delete", flag.ExitOnError)
	pages := fs.String("pages", "", "Các trang cần xóa (ví dụ: '2' hoặc '1,3-4')")
	outFile := fs.String("o", "", "Đường dẫn file kết quả")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *pages == "" {
		fmt.Println("Cách dùng: pdfcraft delete <tệp.pdf> -pages <1,3> [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	parts := strings.Split(*pages, ",")
	var delPages []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			delPages = append(delPages, p)
		}
	}

	fmt.Printf("[*] Đang xóa các trang [%s] khỏi '%s'...\n", *pages, filepath.Base(inFile))
	if err := pdfcraft.DeletePages(inFile, targetOut, delPages); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	resInfo, _ := pdfcraft.GetInfo(targetOut)
	remaining := 0
	if resInfo != nil {
		remaining = resInfo.PageCount
	}
	fmt.Printf("[+] Thành công! Tổng số trang còn lại: %d. Đã lưu tại: %s\n", remaining, targetOut)
}

func runRotate(args []string) {
	fs := flag.NewFlagSet("rotate", flag.ExitOnError)
	pages := fs.String("pages", "", "Các trang cần xoay (ví dụ: '1' hoặc '1,3-4')")
	angle := fs.Int("angle", 0, "Góc xoay theo chiều kim đồng hồ: 90, 180, 270 (hoặc -90, -180)")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *pages == "" || *angle == 0 {
		fmt.Println("Cách dùng: pdfcraft rotate <tệp.pdf> -pages <1,3-4> -angle <90|180|270|-90> [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	if *angle%90 != 0 {
		fmt.Fprintf(os.Stderr, "[LỖI] Góc xoay phải là bội số của 90 độ (nhận được %d)\n", *angle)
		os.Exit(1)
	}

	var rotPages []string
	for _, p := range strings.Split(*pages, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			rotPages = append(rotPages, p)
		}
	}

	fmt.Printf("[*] Đang xoay các trang [%s] một góc %d° trong '%s'...\n", *pages, *angle, filepath.Base(inFile))
	if err := pdfcraft.RotatePages(inFile, targetOut, rotPages, *angle); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã lưu tệp tại: %s\n", targetOut)
}

func runMerge(args []string) {
	fs := flag.NewFlagSet("merge", flag.ExitOnError)
	outFile := fs.String("o", "", "Đường dẫn file PDF kết quả sau khi gộp")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *outFile == "" {
		fmt.Println("Cách dùng: pdfcraft merge <a.pdf> <b.pdf> [...] -o <kết_quả.pdf>")
		os.Exit(1)
	}

	fmt.Printf("[*] Đang gộp %d tệp PDF theo thứ tự...\n", len(tail))
	if err := pdfcraft.MergeFiles(tail, *outFile); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	resInfo, _ := pdfcraft.GetInfo(*outFile)
	total := 0
	if resInfo != nil {
		total = resInfo.PageCount
	}
	fmt.Printf("[+] Thành công! Tổng số trang: %d. Đã lưu tại: %s\n", total, *outFile)
}

func runText(args []string) {
	fs := flag.NewFlagSet("text", flag.ExitOnError)
	page := fs.Int("page", 0, "Chỉ trích xuất 1 trang (1-based, 0 = tất cả)")
	pages := fs.String("pages", "", "Dải trang cần trích xuất (ví dụ: '1,3,5-7', mặc định: tất cả)")
	password := fs.String("password", "", "Mật khẩu mở file (nếu file mã hóa)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft text <tệp.pdf> [--page <n> | -pages <1,3>] [--password <mật_khẩu>]")
		os.Exit(1)
	}
	inFile := tail[0]

	var sel []string
	if *page > 0 {
		sel = []string{strconv.Itoa(*page)}
	} else if *pages != "" {
		for _, p := range strings.Split(*pages, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				sel = append(sel, p)
			}
		}
	}

	var texts map[int]string
	var err error
	if *password != "" {
		texts, err = pdfcraft.ExtractTextWithPassword(inFile, *password, sel)
	} else {
		texts, err = pdfcraft.ExtractText(inFile, sel)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	// In theo thứ tự trang tăng dần, cùng format với bản Python
	ordered := make([]int, 0, len(texts))
	for k := range texts {
		ordered = append(ordered, k)
	}
	sortInts(ordered)
	for _, pnum := range ordered {
		fmt.Printf("--- [Trang %d] ---\n", pnum)
		fmt.Println(texts[pnum])
	}
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

func printBookmarkTree(marks []pdfcraft.Bookmark, level int) {
	for _, m := range marks {
		fmt.Printf("%s- %s (trang %d)\n", strings.Repeat("  ", level), m.Title, m.Page)
		printBookmarkTree(m.Kids, level+1)
	}
}

func runBookmark(args []string) {
	fs := flag.NewFlagSet("bookmark", flag.ExitOnError)
	addTitle := fs.String("add", "", "Thêm bookmark cấp cao nhất với tiêu đề này")
	page := fs.Int("page", 0, "Trang đích cho --add (1-based)")
	clear := fs.Bool("clear", false, "Xóa toàn bộ bookmark")
	exportJSON := fs.String("export", "", "Xuất bookmark ra file JSON")
	importJSON := fs.String("import-json", "", "Nhập bookmark từ file JSON (thay thế)")
	password := fs.String("password", "", "Mật khẩu mở file (nếu file mã hóa)")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft bookmark <tệp.pdf> [--add <tiêu_đề> --page <n>] [--clear] [--export <f.json>] [--import-json <f.json>] [--password <mật_khẩu>] [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	if *exportJSON != "" {
		data, err := pdfcraft.ExportBookmarks(inFile, *password)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(*exportJSON, data, 0600); err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[+] Đã xuất bookmark ra: %s\n", *exportJSON)
		return
	}

	if *importJSON != "" {
		// #nosec G304 -- đọc file JSON do người dùng chỉ định
		data, err := os.ReadFile(*importJSON)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		if err := pdfcraft.ImportBookmarks(inFile, targetOut, data, *password); err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[+] Thành công! Đã nhập bookmark tại: %s\n", targetOut)
		return
	}
	if *clear {
		if err := pdfcraft.ClearBookmarks(inFile, targetOut, *password); err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[+] Thành công! Đã xóa bookmark tại: %s\n", targetOut)
		return
	}
	if *addTitle != "" {
		if *page <= 0 {
			fmt.Fprintln(os.Stderr, "[LỖI] --add cần kèm --page (số trang 1-based)")
			os.Exit(1)
		}
		if err := pdfcraft.AddBookmark(inFile, targetOut, *addTitle, *page, *password); err != nil {
			fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[+] Thành công! Đã cập nhật bookmark tại: %s\n", targetOut)
		return
	}

	marks, err := pdfcraft.ListBookmarks(inFile, *password)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	if len(marks) == 0 {
		fmt.Println("(không có bookmark)")
		return
	}
	printBookmarkTree(marks, 0)
}

func runEncrypt(args []string) {
	fs := flag.NewFlagSet("encrypt", flag.ExitOnError)
	userPW := fs.String("user-pw", "", "Mật khẩu người dùng (bắt buộc để mở file)")
	ownerPW := fs.String("owner-pw", "", "Mật khẩu chủ sở hữu toàn quyền (mặc định: giống user-pw)")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *userPW == "" {
		fmt.Println("Cách dùng: pdfcraft encrypt <tệp.pdf> --user-pw <mật_khẩu> [--owner-pw <mật_khẩu>] [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	fmt.Printf("[*] Đang mã hóa '%s' bằng mật khẩu...\n", filepath.Base(inFile))
	if err := pdfcraft.EncryptPdf(inFile, targetOut, *userPW, *ownerPW); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! File đã mã hóa tại: %s\n", targetOut)
}

func runDecrypt(args []string) {
	fs := flag.NewFlagSet("decrypt", flag.ExitOnError)
	password := fs.String("password", "", "Mật khẩu mở file")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *password == "" {
		fmt.Println("Cách dùng: pdfcraft decrypt <tệp.pdf> --password <mật_khẩu> [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	fmt.Printf("[*] Đang giải mã '%s'...\n", filepath.Base(inFile))
	if err := pdfcraft.DecryptPdf(inFile, targetOut, *password); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! File đã giải mã tại: %s\n", targetOut)
}

func runMeta(args []string) {
	fs := flag.NewFlagSet("meta", flag.ExitOnError)
	title := fs.String("title", "", "Tiêu đề tài liệu")
	author := fs.String("author", "", "Tác giả")
	subject := fs.String("subject", "", "Chủ đề")
	keywords := fs.String("keywords", "", "Từ khóa")
	creator := fs.String("creator", "", "Ứng dụng tạo file")
	producer := fs.String("producer", "", "Ứng dụng xuất file")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft meta <tệp.pdf> [--title <t>] [--author <t>] [--subject <t>] [--keywords <t>] [--creator <t>] [--producer <t>] [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	props := make(map[string]string)
	if *title != "" {
		props["Title"] = *title
	}
	if *author != "" {
		props["Author"] = *author
	}
	if *subject != "" {
		props["Subject"] = *subject
	}
	if *keywords != "" {
		props["Keywords"] = *keywords
	}
	if *creator != "" {
		props["Creator"] = *creator
	}
	if *producer != "" {
		props["Producer"] = *producer
	}
	if len(props) == 0 {
		fmt.Println("Cách dùng: pdfcraft meta <tệp.pdf> [--title <t>] [--author <t>] [--subject <t>] [--keywords <t>] [--creator <t>] [--producer <t>] [-o <kết_quả.pdf>]")
		fmt.Fprintln(os.Stderr, "[LỖI] Cần ít nhất 1 trường metadata để cập nhật")
		os.Exit(1)
	}

	fmt.Printf("[*] Đang cập nhật metadata của '%s'...\n", filepath.Base(inFile))
	if err := pdfcraft.SetMetadata(inFile, targetOut, props); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã cập nhật metadata tại: %s\n", targetOut)
}

func runWatermark(args []string) {
	fs := flag.NewFlagSet("watermark", flag.ExitOnError)
	text := fs.String("text", "", "Nội dung dấu (khuyên dùng chữ Latin không dấu)")
	pages := fs.String("pages", "", "Các trang cần đóng dấu (ví dụ: '1,3-4', mặc định: tất cả)")
	fontSize := fs.Int("font-size", 48, "Cỡ chữ (mặc định: 48)")
	rotation := fs.Float64("rotation", 45, "Góc xoay độ -180..180 (mặc định: 45)")
	opacity := fs.Float64("opacity", 0.3, "Độ đậm 0..1 (mặc định: 0.3)")
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 || *text == "" {
		fmt.Println("Cách dùng: pdfcraft watermark <tệp.pdf> --text <nội_dung> [--pages <1,3>] [--font-size 48] [--rotation 45] [--opacity 0.3] [-o <kết_quả.pdf>]")
		os.Exit(1)
	}
	inFile := tail[0]
	targetOut := *outFile
	if targetOut == "" {
		targetOut = inFile
	}

	var wmPages []string
	if *pages != "" {
		for _, p := range strings.Split(*pages, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				wmPages = append(wmPages, p)
			}
		}
	}

	fmt.Printf("[*] Đang đóng dấu '%s' lên '%s'...\n", *text, filepath.Base(inFile))
	if err := pdfcraft.AddTextWatermark(inFile, targetOut, *text, wmPages, *fontSize, *rotation, *opacity); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã lưu tệp tại: %s\n", targetOut)
}

func runCompress(args []string) {
	fs := flag.NewFlagSet("compress", flag.ExitOnError)
	outFile := fs.String("o", "", "Đường dẫn file kết quả (ghi đè file gốc nếu để trống)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft compress <tệp.pdf> [-o <kết_quả.pdf>]")
		os.Exit(1)
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

func runConvert(args []string) {
	fs := flag.NewFlagSet("convert", flag.ExitOnError)
	outDir := fs.String("d", "", "Thư mục chứa PDF kết quả (mặc định: cùng thư mục file gốc)")
	engine := fs.String("engine", "", "Đường dẫn soffice (mặc định: tự tìm LibreOffice)")
	timeoutSec := fs.Int("timeout", 180, "Thời gian chờ tối đa mỗi lượt (giây)")
	tail := parseFlagsAndArgs(fs, args)

	if len(tail) < 1 {
		fmt.Println("Cách dùng: pdfcraft convert <a.docx> <b.xlsx> [...] [-d <thư_mục_đích>] [--engine <soffice>]")
		os.Exit(1)
	}

	fmt.Printf("[*] Đang chuyển %d file Office sang PDF...\n", len(tail))
	created, err := pdfcraft.ConvertOfficeToPdf(tail, *outDir, *engine, *timeoutSec)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}

	dest := fmt.Sprintf("'%s'", *outDir)
	if *outDir == "" {
		dest = "cùng thư mục file gốc"
	}
	fmt.Printf("[+] Thành công! Đã tạo %d file PDF vào %s:\n", len(created), dest)
	for _, f := range created {
		fmt.Printf("    • %s\n", f)
	}
}

// runMergeContext phục vụ menu chuột phải "Gộp PDF": nhận N file do Explorer
// truyền vào, gộp thành <file_đầu>_merged.pdf ngay cạnh file đầu tiên.
func runMergeContext(args []string) {
	var files []string
	for _, a := range args {
		a = strings.TrimSpace(a)
		if a == "" || strings.HasPrefix(a, "-") {
			continue
		}
		if strings.HasSuffix(strings.ToLower(a), ".pdf") {
			files = append(files, a)
		}
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "[LỖI] Không nhận được file PDF nào để gộp")
		os.Exit(1)
	}

	first := files[0]
	out := filepath.Join(
		filepath.Dir(first),
		strings.TrimSuffix(filepath.Base(first), filepath.Ext(first))+"_merged.pdf",
	)
	fmt.Printf("[*] Đang gộp %d file PDF...\n", len(files))
	if err := pdfcraft.MergeFiles(files, out); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[+] Thành công! Đã lưu tại: %s\n", out)
}

// runCompressContext phục vụ menu chuột phải "Nén nhanh": tối ưu lossless
// ra file <tên>_small.pdf ngay cạnh file gốc (không ghi đè file gốc).
func runCompressContext(args []string) {
	var inFile string
	for _, a := range args {
		a = strings.TrimSpace(a)
		if a != "" && !strings.HasPrefix(a, "-") {
			inFile = a
			break
		}
	}
	if inFile == "" {
		fmt.Fprintln(os.Stderr, "[LỖI] Không nhận được file PDF nào để nén")
		os.Exit(1)
	}

	out := filepath.Join(
		filepath.Dir(inFile),
		strings.TrimSuffix(filepath.Base(inFile), filepath.Ext(inFile))+"_small.pdf",
	)
	before := fileSizeOf(inFile)
	fmt.Printf("[*] Đang nén nhanh '%s'...\n", filepath.Base(inFile))
	if err := pdfcraft.CompressPdf(inFile, out); err != nil {
		fmt.Fprintf(os.Stderr, "[LỖI] %v\n", err)
		os.Exit(1)
	}
	after := fileSizeOf(out)
	savedPct := 0.0
	if before > 0 {
		savedPct = (1 - float64(after)/float64(before)) * 100
	}
	fmt.Printf("[+] Thành công! %s -> %s (giảm %.1f%%). Lưu tại: %s\n",
		formatBytes(before), formatBytes(after), savedPct, out)
}

func fileSizeOf(path string) int64 {
	// #nosec G703 -- CLI cục bộ: path là file input/output do người dùng chỉ định
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}
