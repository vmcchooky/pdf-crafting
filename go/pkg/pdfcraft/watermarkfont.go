package pdfcraft

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unicode"

	"github.com/pdfcpu/pdfcpu/pkg/font"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// watermarkFontName là tên family của font subset nhúng kèm.
// Font gốc: Noto Sans Regular (SIL Open Font License 1.1), subset giữ
// Latin + Latin Extended + Latin Extended Additional + dấu tổ hợp —
// đủ cho tiếng Việt và các ngôn ngữ châu Âu phổ biến, chỉ ~39 KB
// sau giải mã. Dữ liệu font nằm ở fontdata.go (base64).
const watermarkFontName = "PDFCraftSans"

var (
	ensureFontOnce sync.Once
	ensureFontErr  error
)

// textNeedsUnicodeFont cho biết văn bản có ký tự nằm ngoài bảng mã
// WinAnsi của font lõi Helvetica hay không (mọi ký tự tiếng Việt đặc
// trưng — ă â đ ê ô ơ ư và các chữ mang dấu thanh — đều nằm ngoài).
func textNeedsUnicodeFont(s string) bool {
	for _, r := range s {
		if r > unicode.MaxLatin1 {
			return true
		}
	}
	return false
}

// ensureWatermarkFont cài font subset nhúng vào thư mục font của
// pdfcpu (một lần duy nhất cho mỗi tiến trình và mỗi máy: các lần sau
// nhận diện qua tệp .gob đã cài). Phải được gọi sau khi pdfcpu đã nạp
// cấu hình mặc định (mọi lời gọi api.* đều kích hoạt việc này).
func ensureWatermarkFont() error {
	ensureFontOnce.Do(func() {
		_ = model.NewDefaultConfiguration()
		dir := font.UserFontDir
		if dir == "" {
			ensureFontErr = fmt.Errorf("pdfcpu chưa xác định được thư mục font người dùng")
			return
		}
		if err := os.MkdirAll(dir, 0750); err != nil {
			ensureFontErr = err
			return
		}
		if _, err := os.Stat(filepath.Join(dir, watermarkFontName+".gob")); err == nil {
			return // đã cài từ lần chạy trước
		}
		ttf, err := base64.StdEncoding.DecodeString(pdfCraftSansTTFB64)
		if err != nil {
			ensureFontErr = fmt.Errorf("giải mã font nhúng: %w", err)
			return
		}
		ensureFontErr = font.InstallFontFromBytes(dir, watermarkFontName, ttf)
	})
	return ensureFontErr
}
