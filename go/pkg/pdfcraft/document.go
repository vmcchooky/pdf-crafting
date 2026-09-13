package pdfcraft

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

	// Tách từng trang bằng CollectFile để kiểm soát chính xác tên file
	var createdFiles []string
	baseName := strings.TrimSuffix(filepath.Base(absIn), filepath.Ext(absIn))

	for i := 1; i <= count; i++ {
		targetFile := filepath.Join(absOut, fmt.Sprintf("%s_page_%d.pdf", baseName, i))
		pageStr := strconv.Itoa(i)
		if err := api.CollectFile(absIn, targetFile, []string{pageStr}, nil); err != nil {
			return nil, fmt.Errorf("lỗi trích xuất trang %d: %w", i, err)
		}
		createdFiles = append(createdFiles, targetFile)
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

	return api.CollectFile(absIn, absOut, pageSelection, nil)
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
		// Chỉ cần sao chép nếu input != output
		if absIn != outPath {
			return copyFile(absIn, outPath)
		}
		return nil
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

	desc := fmt.Sprintf("fontname:Helvetica, points:%d, rotation:%g, opacity:%g",
		fontSize, rotation, opacity)

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

// saveSafely hỗ trợ ghi an toàn (kể cả khi inPath trùng với outPath).
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

	// Đổi tên tệp tạm thành đích (hỗ trợ ghi đè an toàn trên Windows)
	if err := os.Rename(tempFile, absOut); err != nil {
		// Trên Windows, Rename có thể lỗi nếu absOut đã tồn tại -> xóa trước rồi rename
		_ = os.Remove(absOut)
		if err2 := os.Rename(tempFile, absOut); err2 != nil {
			return copyFile(tempFile, absOut)
		}
	}

	return nil
}

func copyFile(src, dst string) error {
	cleanSrc := filepath.Clean(src)
	cleanDst := filepath.Clean(dst)

	inF, err := os.Open(cleanSrc)
	if err != nil {
		return err
	}
	defer inF.Close()

	outF, err := os.OpenFile(cleanDst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer outF.Close()

	buf := make([]byte, 32*1024)
	_, err = io.CopyBuffer(outF, inF, buf)
	return err
}

func init() {
	// Ẩn log verbose của pdfcpu mặc định để CLI sạch sẽ
	_ = model.ConfigPath
}
