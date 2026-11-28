package pdfcraft

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	ledongpdf "github.com/ledongthuc/pdf"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// PageInfo chứa thông tin kích thước và số trang.
type PageInfo struct {
	PageNumber int     `json:"page_number"`
	Width      float64 `json:"width"`
	Height     float64 `json:"height"`
}

// DocInfo chứa thông tin tổng quát về tài liệu PDF.
type DocInfo struct {
	FilePath  string     `json:"file_path"`
	PageCount int        `json:"page_count"`
	FileSize  int64      `json:"file_size_bytes"`
	Title     string     `json:"title,omitempty"`
	Author    string     `json:"author,omitempty"`
	Pages     []PageInfo `json:"pages"`
}

// ParsePageSelection phân tích chuỗi đặc tả trang (ví dụ "1, 3, 5-7") thành danh sách các số trang (1-based, đã sắp xếp).
func ParsePageSelection(spec string, maxPages int) ([]int, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, fmt.Errorf("đặc tả trang không được để trống")
	}

	seen := make(map[int]bool)
	var pages []int

	parts := strings.Split(spec, ",")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		if strings.Contains(part, "-") {
			rangeTokens := strings.SplitN(part, "-", 2)
			startStr := strings.TrimSpace(rangeTokens[0])
			endStr := strings.TrimSpace(rangeTokens[1])

			start := 1
			var err error
			if startStr != "" {
				start, err = strconv.Atoi(startStr)
				if err != nil {
					return nil, fmt.Errorf("số trang bắt đầu không hợp lệ trong '%s': %w", part, err)
				}
			}

			end := maxPages
			if endStr != "" {
				end, err = strconv.Atoi(endStr)
				if err != nil {
					return nil, fmt.Errorf("số trang kết thúc không hợp lệ trong '%s': %w", part, err)
				}
			}

			if start > end {
				return nil, fmt.Errorf("dải trang không hợp lệ: %d-%d (bắt đầu lớn hơn kết thúc)", start, end)
			}

			for i := start; i <= end; i++ {
				if i < 1 || i > maxPages {
					return nil, fmt.Errorf("trang %d nằm ngoài phạm vi tài liệu (1..%d)", i, maxPages)
				}
				if !seen[i] {
					seen[i] = true
					pages = append(pages, i)
				}
			}
		} else {
			p, err := strconv.Atoi(part)
			if err != nil {
				return nil, fmt.Errorf("số trang không hợp lệ '%s': %w", part, err)
			}
			if p < 1 || p > maxPages {
				return nil, fmt.Errorf("trang %d nằm ngoài phạm vi tài liệu (1..%d)", p, maxPages)
			}
			if !seen[p] {
				seen[p] = true
				pages = append(pages, p)
			}
		}
	}

	sort.Ints(pages)
	return pages, nil
}

// GetInfo nạp và đọc thông tin cấu trúc, số trang, kích thước, metadata của file PDF.
func GetInfo(pdfPath string) (*DocInfo, error) {
	absPath, err := filepath.Abs(pdfPath)
	if err != nil {
		return nil, err
	}

	fileStat, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("không thể truy cập tệp PDF: %w", err)
	}

	ctx, err := api.ReadContextFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("lỗi đọc PDF: %w", err)
	}

	if err := ctx.EnsurePageCount(); err != nil {
		return nil, fmt.Errorf("lỗi tính số trang: %w", err)
	}

	dims, err := ctx.PageDims()
	if err != nil {
		return nil, fmt.Errorf("lỗi đọc kích thước trang: %w", err)
	}

	var pages []PageInfo
	for i, d := range dims {
		pages = append(pages, PageInfo{
			PageNumber: i + 1,
			Width:      d.Width,
			Height:     d.Height,
		})
	}

	return &DocInfo{
		FilePath:  absPath,
		PageCount: ctx.PageCount,
		FileSize:  fileStat.Size(),
		Title:     ctx.Title,
		Author:    ctx.Author,
		Pages:     pages,
	}, nil
}

// SplitAll tách tất cả các trang của PDF thành từng file đơn lẻ trong thư mục outDir.
func SplitAll(pdfPath, outDir string) ([]string, error) {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return nil, err
	}
	absOut, err := filepath.Abs(outDir)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(absOut, 0750); err != nil {
		return nil, fmt.Errorf("không thể tạo thư mục đầu ra: %w", err)
	}

	count, err := api.PageCountFile(absIn)
	if err != nil {
		return nil, fmt.Errorf("lỗi đọc số trang: %w", err)
	}

	// Tách bằng SplitFile của pdfcpu: đọc/phân tích tệp nguồn đúng MỘT lần
	// rồi ghi mọi trang (bản cũ gọi CollectFile cho từng trang — phân tích
	// lại toàn bộ tệp N lần; thử nghiệm worker-pool song song còn chậm hơn
	// trên máy ít nhân và tốn RAM hơn, đã loại bỏ — xem benchmark).
	// SplitFile đặt tên <base>_<trang>.pdf trong thư mục tạm riêng, sau đó
	// từng tệp được chuyển về tên đích <base>_page_<trang>.pdf qua
	// saveSafely để giữ nguyên tắc ghi nguyên tử.
	baseName := strings.TrimSuffix(filepath.Base(absIn), filepath.Ext(absIn))
	splitBase := strings.TrimSuffix(filepath.Base(absIn), ".pdf")

	tmpDir, err := os.MkdirTemp(absOut, ".split_*")
	if err != nil {
		return nil, fmt.Errorf("không thể tạo thư mục tạm để tách trang: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	if err := api.SplitFile(absIn, tmpDir, 1, nil); err != nil {
		return nil, fmt.Errorf("lỗi tách trang: %w", err)
	}

	createdFiles := make([]string, count)
	for i := 1; i <= count; i++ {
		part := filepath.Join(tmpDir, fmt.Sprintf("%s_%d.pdf", splitBase, i))
		targetFile := filepath.Join(absOut, fmt.Sprintf("%s_page_%d.pdf", baseName, i))
		err := saveSafely(absIn, targetFile, func(tempTarget string) error {
			return copyFile(part, tempTarget)
		})
		if err != nil {
			return nil, fmt.Errorf("lỗi trích xuất trang %d: %w", i, err)
		}
		createdFiles[i-1] = targetFile
	}

	return createdFiles, nil
}

// ExtractPages trích xuất các trang chỉ định ra file PDF mới.
func ExtractPages(pdfPath, outPath string, pageSelection []string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	absOut, err := filepath.Abs(outPath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(absOut), 0750); err != nil {
		return err
	}

	return saveSafely(absIn, absOut, func(tempTarget string) error {
		return api.CollectFile(absIn, tempTarget, pageSelection, nil)
	})
}

// MovePage di chuyển trang từ fromPage sang toPage (1-based).
func MovePage(pdfPath, outPath string, fromPage, toPage int) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}

	total, err := api.PageCountFile(absIn)
	if err != nil {
		return err
	}

	if fromPage < 1 || fromPage > total {
		return fmt.Errorf("fromPage %d nằm ngoài phạm vi (1..%d)", fromPage, total)
	}
	if toPage < 1 || toPage > total {
		return fmt.Errorf("toPage %d nằm ngoài phạm vi (1..%d)", toPage, total)
	}

	if fromPage == toPage {
		// Di chuyển một trang về đúng vị trí của nó là no-op khi đích là
		// chính file nguồn — dù outPath viết theo kiểu tuyệt đối, tương
		// đối hay "./". So sánh chuỗi trần (absIn != outPath) là sai vì
		// absIn luôn tuyệt đối còn outPath mặc định là chuỗi input.
		absOut, err := filepath.Abs(outPath)
		if err != nil {
			return err
		}
		if sameFile(absIn, absOut) {
			return nil
		}
		return saveSafely(absIn, absOut, func(tempTarget string) error {
			return copyFile(absIn, tempTarget)
		})
	}

	// Tạo thứ tự trang sau khi di chuyển
	pages := make([]int, total)
	for i := 0; i < total; i++ {
		pages[i] = i + 1
	}

	// 0-based move
	fromIdx := fromPage - 1
	toIdx := toPage - 1

	val := pages[fromIdx]
	pages = append(pages[:fromIdx], pages[fromIdx+1:]...)
	// Insert at toIdx
	pages = append(pages[:toIdx], append([]int{val}, pages[toIdx:]...)...)

	var pageStrs []string
	for _, p := range pages {
		pageStrs = append(pageStrs, strconv.Itoa(p))
	}

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.CollectFile(absIn, tempTarget, pageStrs, nil)
	})
}

// ReorderPages sắp xếp lại toàn bộ thứ tự trang theo danh sách hoán vị mới.
func ReorderPages(pdfPath, outPath string, newOrder []int) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}

	total, err := api.PageCountFile(absIn)
	if err != nil {
		return err
	}

	if len(newOrder) != total {
		return fmt.Errorf("thứ tự mới phải chứa đúng %d trang (nhận được %d)", total, len(newOrder))
	}

	seen := make(map[int]bool)
	var pageStrs []string
	for _, p := range newOrder {
		if p < 1 || p > total {
			return fmt.Errorf("trang %d không hợp lệ (phải từ 1..%d)", p, total)
		}
		if seen[p] {
			return fmt.Errorf("trang %d bị lặp lại trong thứ tự mới", p)
		}
		seen[p] = true
		pageStrs = append(pageStrs, strconv.Itoa(p))
	}

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.CollectFile(absIn, tempTarget, pageStrs, nil)
	})
}

// InsertFromFile thêm các trang từ file nguồn sourcePath vào vị trí atPosition (1-based) của targetPath.
// Nếu sourcePages rỗng, chèn toàn bộ trang của sourcePath.
func InsertFromFile(targetPath, sourcePath, outPath string, atPosition int, sourcePages []string) error {
	absTarget, err := filepath.Abs(targetPath)
	if err != nil {
		return err
	}
	absSource, err := filepath.Abs(sourcePath)
	if err != nil {
		return err
	}

	targetTotal, err := api.PageCountFile(absTarget)
	if err != nil {
		return fmt.Errorf("lỗi đọc số trang tệp đích: %w", err)
	}

	if atPosition < 1 || atPosition > targetTotal+1 {
		return fmt.Errorf("vị trí chèn %d không hợp lệ (phải từ 1..%d)", atPosition, targetTotal+1)
	}

	sourceTotal, err := api.PageCountFile(absSource)
	if err != nil {
		return fmt.Errorf("lỗi đọc số trang tệp nguồn: %w", err)
	}
	if sourceTotal == 0 {
		return fmt.Errorf("tệp nguồn không có trang nào")
	}

	// Tạo thư mục tạm để lưu các phần trước khi ghép
	tempDir, err := os.MkdirTemp("", "pdfcraft_insert_*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempDir)

	// Chuẩn bị file các trang từ source
	srcSubsetFile := absSource
	if len(sourcePages) > 0 {
		srcSubsetFile = filepath.Join(tempDir, "source_subset.pdf")
		if err := api.CollectFile(absSource, srcSubsetFile, sourcePages, nil); err != nil {
			return fmt.Errorf("lỗi trích xuất trang nguồn: %w", err)
		}
	}

	var mergeList []string

	// Phần trước điểm chèn: 1 .. atPosition-1
	if atPosition > 1 {
		part1File := filepath.Join(tempDir, "part1.pdf")
		var p1Pages []string
		for i := 1; i < atPosition; i++ {
			p1Pages = append(p1Pages, strconv.Itoa(i))
		}
		if err := api.CollectFile(absTarget, part1File, p1Pages, nil); err != nil {
			return fmt.Errorf("lỗi tách phần đầu tệp đích: %w", err)
		}
		mergeList = append(mergeList, part1File)
	}

	// Trang cần chèn
	mergeList = append(mergeList, srcSubsetFile)

	// Phần sau điểm chèn: atPosition .. targetTotal
	if atPosition <= targetTotal {
		part2File := filepath.Join(tempDir, "part2.pdf")
		var p2Pages []string
		for i := atPosition; i <= targetTotal; i++ {
			p2Pages = append(p2Pages, strconv.Itoa(i))
		}
		if err := api.CollectFile(absTarget, part2File, p2Pages, nil); err != nil {
			return fmt.Errorf("lỗi tách phần sau tệp đích: %w", err)
		}
		mergeList = append(mergeList, part2File)
	}

	return saveSafely(absTarget, outPath, func(tempTarget string) error {
		return api.MergeCreateFile(mergeList, tempTarget, false, nil)
	})
}

// DeletePages xóa các trang chỉ định khỏi tài liệu.
func DeletePages(pdfPath, outPath string, pagesToDelete []string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}

	total, err := api.PageCountFile(absIn)
	if err != nil {
		return err
	}

	// Lập tập hợp các trang xóa
	deleteSpec := strings.Join(pagesToDelete, ",")
	delList, err := ParsePageSelection(deleteSpec, total)
	if err != nil {
		return err
	}

	if len(delList) >= total {
		return fmt.Errorf("không thể xóa toàn bộ các trang trong tài liệu")
	}

	delSet := make(map[int]bool)
	for _, p := range delList {
		delSet[p] = true
	}

	// Lấy danh sách các trang giữ lại
	var keepStrs []string
	for i := 1; i <= total; i++ {
		if !delSet[i] {
			keepStrs = append(keepStrs, strconv.Itoa(i))
		}
	}

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.CollectFile(absIn, tempTarget, keepStrs, nil)
	})
}

// RotatePages xoay các trang chỉ định theo chiều kim đồng hồ thêm `rotation` độ.
// `rotation` phải là bội số của 90 (ví dụ 90, 180, 270 hoặc -90).
// `pagesToRotate` theo cú pháp pdfcpu (ví dụ []string{"1", "3-5"}); rỗng = xoay toàn bộ tài liệu.
func RotatePages(pdfPath, outPath string, pagesToRotate []string, rotation int) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}

	if rotation%90 != 0 {
		return fmt.Errorf("góc xoay phải là bội số của 90 độ (nhận được %d)", rotation)
	}

	total, err := api.PageCountFile(absIn)
	if err != nil {
		return fmt.Errorf("lỗi đọc số trang: %w", err)
	}

	// Validate phạm vi trang để báo lỗi thân thiện kiểu 1-based trước khi gọi pdfcpu
	if len(pagesToRotate) > 0 {
		joined := strings.Join(pagesToRotate, ",")
		if _, err := ParsePageSelection(joined, total); err != nil {
			return err
		}
	}

	var selected []string
	for _, p := range pagesToRotate {
		p = strings.TrimSpace(p)
		if p != "" {
			selected = append(selected, p)
		}
	}
	// nil = toàn bộ trang (quy ước của pdfcpu)

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.RotateFile(absIn, tempTarget, rotation, selected, nil)
	})
}

// MergeFiles gộp nhiều tệp PDF thành một tệp duy nhất, giữ đúng thứ tự đầu vào.
// Mỗi tệp đóng góp toàn bộ các trang theo thứ tự gốc.
func MergeFiles(inputPaths []string, outPath string) error {
	if len(inputPaths) == 0 {
		return fmt.Errorf("cần ít nhất 1 tệp PDF đầu vào để gộp")
	}

	absInputs := make([]string, 0, len(inputPaths))
	seen := make(map[string]bool)
	for _, p := range inputPaths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return err
		}
		fi, err := os.Stat(abs)
		if err != nil || fi.IsDir() {
			return fmt.Errorf("không tìm thấy tệp PDF để gộp: %s", p)
		}
		absInputs = append(absInputs, abs)
		seen[abs] = true
	}
	if len(absInputs) == 0 {
		return fmt.Errorf("cần ít nhất 1 tệp PDF đầu vào để gộp")
	}

	absOut, err := filepath.Abs(outPath)
	if err != nil {
		return err
	}
	// Trường hợp output trùng 1 file input: vẫn an toàn nhờ ghi file tạm rồi rename
	_ = seen

	return saveSafely(absInputs[0], absOut, func(tempTarget string) error {
		return api.MergeCreateFile(absInputs, tempTarget, false, nil)
	})
}

// ExtractText trích xuất nội dung văn bản theo trang.
// `pageSelection` theo cú pháp "1,3,5-7"; rỗng = toàn bộ trang.
// Trả về map {số_trang_1_based: nội_dung_text}.
func ExtractText(pdfPath string, pageSelection []string) (map[int]string, error) {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(absIn); err != nil {
		return nil, fmt.Errorf("không thể truy cập tệp PDF: %w", err)
	}

	f, r, err := ledongpdf.Open(absIn)
	if err != nil {
		return nil, fmt.Errorf("lỗi đọc PDF: %w", err)
	}
	defer f.Close()

	total := r.NumPage()
	if total == 0 {
		return map[int]string{}, nil
	}

	var wanted []int
	if len(pageSelection) == 0 {
		wanted = make([]int, total)
		for i := 1; i <= total; i++ {
			wanted[i-1] = i
		}
	} else {
		joined := strings.Join(pageSelection, ",")
		wanted, err = ParsePageSelection(joined, total)
		if err != nil {
			return nil, err
		}
	}

	return extractTextFromReader(r, wanted), nil
}

// EncryptPdf mã hóa file PDF bằng mật khẩu (cần userPW mới mở được).
// ownerPW trống = dùng userPW. Ghi an toàn kể cả khi outPath trùng input.
func EncryptPdf(pdfPath, outPath, userPW, ownerPW string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(userPW) == "" {
		return fmt.Errorf("mật khẩu người dùng (user password) không được để trống")
	}
	if ownerPW == "" {
		ownerPW = userPW
	}

	conf := model.NewDefaultConfiguration()
	conf.UserPW = userPW
	conf.OwnerPW = ownerPW

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.EncryptFile(absIn, tempTarget, conf)
	})
}

// DecryptPdf giải mã file PDF bằng `password` và lưu bản không mật khẩu.
func DecryptPdf(pdfPath, outPath, password string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(password) == "" {
		return fmt.Errorf("mật khẩu giải mã không được để trống")
	}

	conf := model.NewDefaultConfiguration()
	conf.UserPW = password

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.DecryptFile(absIn, tempTarget, conf)
	})
}

// GetInfoWithPassword đọc thông tin file PDF đã mã hóa bằng `password`.
func GetInfoWithPassword(pdfPath, password string) (*DocInfo, error) {
	absPath, err := filepath.Abs(pdfPath)
	if err != nil {
		return nil, err
	}

	fileStat, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("không thể truy cập tệp PDF: %w", err)
	}

	// #nosec G304 -- mở đúng file người dùng yêu cầu, đây là chức năng cốt lõi của công cụ xử lý PDF cục bộ
	f, err := os.Open(absPath)
	if err != nil {
		return nil, fmt.Errorf("không thể mở tệp PDF: %w", err)
	}
	defer f.Close()

	conf := model.NewDefaultConfiguration()
	conf.UserPW = password

	ctx, err := api.ReadValidateAndOptimize(f, conf)
	if err != nil {
		return nil, fmt.Errorf("lỗi đọc PDF (sai mật khẩu?): %w", err)
	}

	if err := ctx.EnsurePageCount(); err != nil {
		return nil, fmt.Errorf("lỗi tính số trang: %w", err)
	}

	dims, err := ctx.PageDims()
	if err != nil {
		return nil, fmt.Errorf("lỗi đọc kích thước trang: %w", err)
	}

	var pages []PageInfo
	for i, d := range dims {
		pages = append(pages, PageInfo{
			PageNumber: i + 1,
			Width:      d.Width,
			Height:     d.Height,
		})
	}

	return &DocInfo{
		FilePath:  absPath,
		PageCount: ctx.PageCount,
		FileSize:  fileStat.Size(),
		Title:     ctx.Title,
		Author:    ctx.Author,
		Pages:     pages,
	}, nil
}

// SetMetadata cập nhật các trường metadata (Title, Author, Subject, Keywords,
// Creator, Producer). Chỉ các key có trong `props` được thay đổi.
func SetMetadata(pdfPath, outPath string, props map[string]string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	if len(props) == 0 {
		return fmt.Errorf("cần ít nhất 1 trường metadata để cập nhật (--title, --author, ...)")
	}

	clean := make(map[string]string, len(props))
	for k, v := range props {
		k = strings.TrimSpace(k)
		if k != "" {
			clean[k] = v
		}
	}
	if len(clean) == 0 {
		return fmt.Errorf("cần ít nhất 1 trường metadata để cập nhật (--title, --author, ...)")
	}

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.AddPropertiesFile(absIn, tempTarget, clean, model.NewDefaultConfiguration())
	})
}

// AddTextWatermark đóng dấu chìm chữ (ví dụ "DRAFT") lên các trang chỉ định
// (rỗng = tất cả). `fontSize` > 0, `rotation` trong -180..180 độ,
// `opacity` trong 0..1. Dấu nằm DƯỚI nội dung trang (watermark).
// Lưu ý: dùng font Helvetica built-in nên chữ có dấu tiếng Việt có thể
// không hiển thị đúng trên backend này.
func AddTextWatermark(pdfPath, outPath, text string, pages []string, fontSize int, rotation float64, opacity float64) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("nội dung watermark không được để trống")
	}
	if fontSize <= 0 {
		return fmt.Errorf("cỡ chữ phải > 0 (nhận được %d)", fontSize)
	}
	if rotation < -180 || rotation > 180 {
		return fmt.Errorf("góc xoay phải trong khoảng -180..180 độ (nhận được %v)", rotation)
	}
	if opacity < 0 || opacity > 1 {
		return fmt.Errorf("độ mờ phải trong khoảng 0..1 (nhận được %v)", opacity)
	}

	total, err := api.PageCountFile(absIn)
	if err != nil {
		return fmt.Errorf("lỗi đọc số trang: %w", err)
	}

	var selected []string
	if len(pages) > 0 {
		joined := strings.Join(pages, ",")
		if _, err := ParsePageSelection(joined, total); err != nil {
			return err
		}
		for _, p := range pages {
			p = strings.TrimSpace(p)
			if p != "" {
				selected = append(selected, p)
			}
		}
	}
	// nil = tất cả các trang (quy ước của pdfcpu)

	// Helvetica (font lõi) chỉ phủ bảng mã WinAnsi — văn bản có ký tự
	// ngoài Latin-1 (điển hình: tiếng Việt) phải dùng font Unicode nhúng,
	// nếu không dấu sẽ mất hoặc hiển thị sai.
	fontName := "Helvetica"
	if textNeedsUnicodeFont(text) {
		if err := ensureWatermarkFont(); err != nil {
			return fmt.Errorf("không cài được font Unicode cho watermark: %w", err)
		}
		fontName = watermarkFontName
	}

	desc := fmt.Sprintf("fontname:%s, points:%d, rotation:%g, opacity:%g",
		fontName, fontSize, rotation, opacity)

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.AddTextWatermarksFile(absIn, tempTarget, selected, false, text, desc, nil)
	})
}

// CompressPdf tối ưu giảm dung lượng không mất dữ liệu (khử trùng lặp object,
// nén lại content stream). Với ảnh scan nặng cần giảm mạnh, dùng panel
// Nén & Xuất file của Web UI thay vì hàm này.
func CompressPdf(pdfPath, outPath string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(absIn); err != nil {
		return fmt.Errorf("không thể truy cập tệp PDF: %w", err)
	}

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.OptimizeFile(absIn, tempTarget, model.NewDefaultConfiguration())
	})
}

// extractTextFromReader là phần chung trích xuất text theo danh sách trang 1-based.
func extractTextFromReader(r *ledongpdf.Reader, wanted []int) map[int]string {
	result := make(map[int]string, len(wanted))
	for _, pnum := range wanted {
		page := r.Page(pnum)
		if page.V.IsNull() {
			result[pnum] = ""
			continue
		}
		rows, err := page.GetTextByRow()
		if err != nil {
			result[pnum] = ""
			continue
		}
		var buf bytes.Buffer
		for _, row := range rows {
			for _, word := range row.Content {
				buf.WriteString(word.S)
				buf.WriteString(" ")
			}
			buf.WriteString("\n")
		}
		result[pnum] = strings.TrimSpace(buf.String())
	}
	return result
}

// ExtractTextWithPassword trích xuất text từ file PDF đã mã hóa.
// Giải mã ra file tạm rồi đọc (hỗ trợ mọi chuẩn mã hóa, kể cả AES-256).
func ExtractTextWithPassword(pdfPath, password string, pageSelection []string) (map[int]string, error) {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(absIn); err != nil {
		return nil, fmt.Errorf("không thể truy cập tệp PDF: %w", err)
	}

	tmpDir, err := os.MkdirTemp("", "pdfcraft_textpw_*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	plain := filepath.Join(tmpDir, "decrypted.pdf")
	conf := model.NewDefaultConfiguration()
	conf.UserPW = password
	if err := api.DecryptFile(absIn, plain, conf); err != nil {
		return nil, fmt.Errorf("lỗi giải mã (sai mật khẩu?): %w", err)
	}

	return ExtractText(plain, pageSelection)
}

var tempCounter uint64

// saveSafely ghi qua file tạm cùng thư mục rồi hoán đổi. Nếu rename thất bại
// (ví dụ đích đang bị khóa) thì copy sang temp phụ rồi rename lại — không bao
// giờ xóa hay ghi trực tiếp lên file đích trước khi thay thế thành công.
// fileSync là điểm nối để test lỗi sync (mặc định = f.Sync() thật).
// Đổi trong test để giả lập sync thất bại (S14).
var fileSync = func(f *os.File) error { return f.Sync() }

// syncFile fsync một file đã tồn tại xuống đĩa: mở O_RDWR, Sync, đóng.
// Trả lỗi nếu mở/sync/đóng thất bại.
func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	if err := fileSync(f); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// syncDir sync thư mục chứa file (best-effort): đảm bảo bản ghi rename được
// ghi bền xuống đĩa. Trên Windows mở thư mục để Sync không hỗ trợ → bỏ qua.
// Lỗi sync thư mục không chặn ghi file (ghi chú trong report, S14 mục 4).
func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	f, err := os.Open(dir)
	if err != nil {
		return
	}
	defer f.Close()
	_ = f.Sync()
}

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

	// S14: fsync dữ liệu xuống đĩa TRƯỚC khi rename — nếu không, mất điện
	// có thể để lại file đích 0 byte/hỏng dù rename đã xảy ra.
	if err := syncFile(tempFile); err != nil {
		return fmt.Errorf("không thể sync file tạm: %w", err)
	}

	if err := os.Rename(tempFile, absOut); err == nil {
		syncDir(filepath.Dir(absOut))
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
	syncDir(filepath.Dir(absOut))
	return nil
}

// sameFile cho biết hai đường dẫn có trỏ tới cùng một file hay không.
// Nếu cả hai tồn tại, dùng os.SameFile (bắt cả symlink/hardlink và khác
// hoa/thường trên Windows). Nếu một bên không tồn tại, so sánh chuỗi path
// đã Clean (EqualFold trên Windows).
func sameFile(a, b string) bool {
	aInfo, aErr := os.Stat(a)
	bInfo, bErr := os.Stat(b)
	if aErr == nil && bErr == nil {
		return os.SameFile(aInfo, bInfo)
	}
	aClean := filepath.Clean(a)
	bClean := filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(aClean, bClean)
	}
	return aClean == bClean
}

func copyFile(src, dst string) error {
	cleanSrc := filepath.Clean(src)
	cleanDst := filepath.Clean(dst)

	// Defense-in-depth: không bao giờ mở đích bằng O_TRUNC khi đích chính
	// là nguồn — nếu không file sẽ bị truncate còn 0 byte trước khi copy.
	if sameFile(cleanSrc, cleanDst) {
		return fmt.Errorf("copyFile: nguồn và đích là cùng một file (%s)", cleanSrc)
	}

	inF, err := os.Open(cleanSrc)
	if err != nil {
		return err
	}
	defer inF.Close()

	outF, err := os.OpenFile(cleanDst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}

	buf := make([]byte, 32*1024)
	if _, err := io.CopyBuffer(outF, inF, buf); err != nil {
		outF.Close()
		return err
	}
	// S14: fsync đích trước khi đóng — nếu không dữ liệu có thể chưa xuống
	// đĩa dù Close thành công.
	if err := fileSync(outF); err != nil {
		outF.Close()
		return err
	}
	if err := outF.Close(); err != nil {
		return err
	}
	return nil
}

// moveResultFile chuyển kết quả từ thư mục tạm (có thể khác ổ đĩa) về đích
// qua file tạm cùng thư mục đích — không xóa đích trước khi thay thế thành
// công, nên lỗi giữa chừng không làm mất file cũ.
func moveResultFile(src, dst string) error {
	return saveSafely(src, dst, func(tempTarget string) error {
		return copyFile(src, tempTarget)
	})
}

func init() {
	// Ẩn log verbose của pdfcpu mặc định để CLI sạch sẽ
	_ = model.ConfigPath

	// pdfcpu khởi tạo cấu hình dùng chung một cách lười biếng và không khóa.
	// Gọi sớm một lần để các thao tác PDF chạy song song (batch, Web UI) không
	// đua nhau ghi config/font/cert vào thư mục người dùng.
	func() {
		defer func() { _ = recover() }()
		_ = model.NewDefaultConfiguration()
	}()
}
