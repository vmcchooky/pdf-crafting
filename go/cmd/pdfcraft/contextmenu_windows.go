//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func getExecutablePath() string {
	exePath, err := os.Executable()
	if err != nil {
		exePath, _ = filepath.Abs(os.Args[0])
	}
	return filepath.Clean(exePath)
}

func getTargetRegistryKeys() []string {
	// Trả về các khóa `shell` (mỗi verb sẽ là subkey: shell\PDFCraft, shell\PDFCraftMerge, ...)
	keys := []string{
		`HKCU\Software\Classes\SystemFileAssociations\.pdf\shell`,
		`HKCU\Software\Classes\.pdf\shell`,
	}

	// Lấy ProgID hiện tại của định dạng .pdf (ví dụ: FoxitReader.Document, ChromeHTML, MSEdgePDF)
	out, err := exec.Command("reg", "query", `HKCR\.pdf`, "/ve").Output()
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.Contains(line, "REG_SZ") {
				parts := strings.Split(line, "REG_SZ")
				if len(parts) >= 2 {
					p := strings.TrimSpace(parts[1])
					if p != "" {
						keys = append(keys, fmt.Sprintf(`HKCU\Software\Classes\%s\shell`, p))
					}
				}
			}
		}
	}
	return keys
}

// contextMenuVerbKeys trả về toàn bộ khóa verb đã đăng ký (để gỡ bỏ sạch sẽ,
// kể cả các khóa của phiên bản cũ chỉ có "Open with PDF Craft").
func contextMenuVerbKeys() []string {
	var verbs []string
	for _, shellKey := range getTargetRegistryKeys() {
		for _, name := range []string{"PDFCraft", "PDFCraftMerge", "PDFCraftCompress"} {
			verbs = append(verbs, shellKey+`\`+name)
		}
	}
	return verbs
}

// installContextMenu đăng ký các mục PDF Craft vào Windows Explorer Context Menu
// cho người dùng hiện tại (không cần quyền Admin):
//   - "Open with PDF Craft" (mở 1 hoặc nhiều file)
//   - "Gộp PDF với PDF Craft" (chọn nhiều file -> gộp 1 lần duy nhất)
//   - "Nén nhanh với PDF Craft" (tối ưu lossless ra file *_small.pdf)
func installContextMenu() error {
	exePath := getExecutablePath()
	keys := getTargetRegistryKeys()

	verbs := []struct {
		name        string
		label       string
		args        string
		multiSelect bool // true = 1 lần gọi duy nhất cho cả nhóm file đã chọn
	}{
		{"PDFCraft", "Open with PDF Craft", `"%s" "%%1"`, true},
		{"PDFCraftMerge", "Gộp PDF với PDF Craft", `"%s" merge-context "%%1"`, true},
		{"PDFCraftCompress", "Nén nhanh với PDF Craft", `"%s" compress-context "%%1"`, false},
	}

	for _, key := range keys {
		for _, v := range verbs {
			vKey := key + `\` + v.name
			// 1. Tên hiển thị trong menu chuột phải
			// #nosec G204 -- binary cố định "reg", tham số dựng từ hằng nội bộ + label tĩnh
			_ = exec.Command("reg", "add", vKey, "/ve", "/t", "REG_SZ", "/d", v.label, "/f").Run()
			// 2. Biểu tượng ứng dụng PDF Craft
			// #nosec G204 -- binary cố định "reg", exePath là đường dẫn của chính ứng dụng đang chạy
			_ = exec.Command("reg", "add", vKey, "/v", "Icon", "/t", "REG_SZ", "/d", fmt.Sprintf(`"%s",0`, exePath), "/f").Run()
			// 3. Gộp nhiều file trong 1 tiến trình duy nhất (thay vì mở N cửa sổ)
			if v.multiSelect {
				// #nosec G204 -- binary cố định "reg", toàn bộ tham số là hằng tĩnh
				_ = exec.Command("reg", "add", vKey, "/v", "MultiSelectModel", "/t", "REG_SZ", "/d", "Player", "/f").Run()
			}
			// 4. Lệnh thực thi khi nhấp chuột
			cmdKey := vKey + `\command`
			// #nosec G204 -- binary cố định "reg", command ghi vào registry chính là exe của app
			_ = exec.Command("reg", "add", cmdKey, "/ve", "/t", "REG_SZ", "/d", fmt.Sprintf(v.args, exePath), "/f").Run()
		}
	}
	return nil
}

// uninstallContextMenu gỡ bỏ sạch sẽ các khóa menu chuột phải
func uninstallContextMenu() error {
	for _, key := range contextMenuVerbKeys() {
		// #nosec G204 -- binary cố định "reg", key dựng từ hằng nội bộ, không chứa input người dùng
		_ = exec.Command("reg", "delete", key, "/f").Run()
	}
	return nil
}

// isContextMenuInstalled kiểm tra xem menu chuột phải đã được cài đặt chưa
func isContextMenuInstalled() bool {
	err := exec.Command("reg", "query", `HKCU\Software\Classes\SystemFileAssociations\.pdf\shell\PDFCraft`).Run()
	return err == nil
}

func runRegisterMenu() {
	exePath := getExecutablePath()
	fmt.Println("========================================================================")
	fmt.Println("  Đăng Ký Menu Chuột Phải Windows: 'Open with PDF Craft'")
	fmt.Println("========================================================================")
	fmt.Printf("  • Tệp thực thi: %s\n", exePath)

	if err := installContextMenu(); err != nil {
		fmt.Printf("  [LỖI] Không thể đăng ký: %v\n", err)
		return
	}

	fmt.Println("  [✓] THÀNH CÔNG! Đã đăng ký 3 mục PDF Craft vào Menu chuột phải Windows:")
	fmt.Println("      • Open with PDF Craft   (mở 1 hoặc nhiều file trong Web UI)")
	fmt.Println("      • Gộp PDF với PDF Craft (chọn nhiều file -> gộp thành 1 file *_merged.pdf)")
	fmt.Println("      • Nén nhanh với PDF Craft (tối ưu ra file *_small.pdf)")
	fmt.Println("")
	fmt.Println("  Cách sử dụng:")
	fmt.Println("  1. Mở File Explorer trên máy tính.")
	fmt.Println("  2. Nhấp chuột phải vào (các) tệp .pdf.")
	fmt.Println("  3. Chọn mục PDF Craft mong muốn.")
	fmt.Println("========================================================================")
}

func runUnregisterMenu() {
	fmt.Println("========================================================================")
	fmt.Println("  Gỡ Bỏ Menu Chuột Phải Windows: 'Open with PDF Craft'")
	fmt.Println("========================================================================")
	if err := uninstallContextMenu(); err != nil {
		fmt.Printf("  [LỖI] Không thể gỡ bỏ: %v\n", err)
		return
	}
	fmt.Println("  [✓] Đã gỡ bỏ sạch sẽ 'Open with PDF Craft' khỏi Menu chuột phải Windows.")
	fmt.Println("========================================================================")
}
