package pdfcraft

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// Bookmark là mục lục gọn, độc lập với struct nội bộ của pdfcpu.
// Page theo 1-based như mọi API hướng người dùng của PdfDocument.
type Bookmark struct {
	Title string     `json:"title"`
	Page  int        `json:"page"`
	Kids  []Bookmark `json:"kids,omitempty"`
}

func bookmarkConf(password string) *model.Configuration {
	conf := model.NewDefaultConfiguration()
	if password != "" {
		conf.UserPW = password
	}
	return conf
}

func toPublicBookmarks(in []pdfcpu.Bookmark) []Bookmark {
	out := make([]Bookmark, 0, len(in))
	for _, b := range in {
		out = append(out, Bookmark{
			Title: b.Title,
			Page:  b.PageFrom,
			Kids:  toPublicBookmarks(b.Kids),
		})
	}
	return out
}

func toPdfcpuBookmarks(in []Bookmark) []pdfcpu.Bookmark {
	out := make([]pdfcpu.Bookmark, 0, len(in))
	for _, b := range in {
		out = append(out, pdfcpu.Bookmark{
			Title:    b.Title,
			PageFrom: b.Page,
			Kids:     toPdfcpuBookmarks(b.Kids),
		})
	}
	return out
}

func validateBookmarkPages(marks []Bookmark, pageCount int) error {
	for _, m := range marks {
		if strings.TrimSpace(m.Title) == "" {
			return fmt.Errorf("bookmark thiếu tiêu đề")
		}
		if m.Page < 1 || m.Page > pageCount {
			return fmt.Errorf("bookmark '%s' trỏ tới trang %d ngoài phạm vi 1..%d", m.Title, m.Page, pageCount)
		}
		if err := validateBookmarkPages(m.Kids, pageCount); err != nil {
			return err
		}
	}
	return nil
}

func openPdfReader(pdfPath string) (*os.File, error) {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return nil, err
	}
	// #nosec G304 -- mở đúng file người dùng yêu cầu, chức năng cốt lõi của công cụ
	f, err := os.Open(absIn)
	if err != nil {
		return nil, fmt.Errorf("không thể mở tệp PDF: %w", err)
	}
	return f, nil
}

func pdfPageCount(pdfPath, password string) (int, error) {
	f, err := openPdfReader(pdfPath)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	count, err := api.PageCount(f, bookmarkConf(password))
	if err != nil {
		return 0, fmt.Errorf("không đọc được tệp PDF: %w", err)
	}
	return count, nil
}

// ListBookmarks đọc mục lục của file PDF (rỗng khi không có).
func ListBookmarks(pdfPath, password string) ([]Bookmark, error) {
	f, err := openPdfReader(pdfPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	bms, err := api.Bookmarks(f, bookmarkConf(password))
	if err != nil {
		// Không có bookmark không phải lỗi: pdfcpu trả ErrNoBookmarks
		if strings.Contains(err.Error(), "no bookmarks") {
			return []Bookmark{}, nil
		}
		return nil, err
	}
	return toPublicBookmarks(bms), nil
}

// AddBookmark thêm 1 bookmark cấp cao nhất rồi lưu ra outPath.
func AddBookmark(pdfPath, outPath, title string, page int, password string) error {
	if strings.TrimSpace(title) == "" {
		return fmt.Errorf("thiếu tiêu đề bookmark")
	}
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	count, err := pdfPageCount(pdfPath, password)
	if err != nil {
		return err
	}
	if page < 1 || page > count {
		return fmt.Errorf("trang %d ngoài phạm vi 1..%d", page, count)
	}

	existing, err := ListBookmarks(pdfPath, password)
	if err != nil {
		return err
	}
	existing = append(existing, Bookmark{Title: title, Page: page})

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.AddBookmarksFile(absIn, tempTarget, toPdfcpuBookmarks(existing), true, bookmarkConf(password))
	})
}

// ClearBookmarks xóa toàn bộ mục lục rồi lưu ra outPath.
func ClearBookmarks(pdfPath, outPath, password string) error {
	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(absIn); err != nil {
		return fmt.Errorf("không tìm thấy tệp PDF: %s", pdfPath)
	}
	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.RemoveBookmarksFile(absIn, tempTarget, bookmarkConf(password))
	})
}

// ExportBookmarks trả về JSON mục lục (định dạng BookmarkTree của pdfcpu).
func ExportBookmarks(pdfPath, password string) ([]byte, error) {
	f, err := openPdfReader(pdfPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var buf bytes.Buffer
	if err := api.ExportBookmarksJSON(f, &buf, pdfPath, bookmarkConf(password)); err != nil {
		if strings.Contains(err.Error(), "no bookmarks") {
			return []byte(`{"bookmarks":[]}`), nil
		}
		return nil, err
	}
	return buf.Bytes(), nil
}

// ImportBookmarks thay thế mục lục từ JSON [{title, page, kids}] (hoặc BookmarkTree) rồi lưu ra outPath.
func ImportBookmarks(pdfPath, outPath string, data []byte, password string) error {
	var marks []Bookmark
	if err := json.Unmarshal(data, &marks); err != nil {
		var tree pdfcpu.BookmarkTree
		if err2 := json.Unmarshal(data, &tree); err2 != nil {
			return fmt.Errorf("JSON bookmark không hợp lệ: %w", err)
		}
		marks = toPublicBookmarks(tree.Bookmarks)
	}

	absIn, err := filepath.Abs(pdfPath)
	if err != nil {
		return err
	}
	count, err := pdfPageCount(pdfPath, password)
	if err != nil {
		return err
	}
	if err := validateBookmarkPages(marks, count); err != nil {
		return err
	}

	tree := pdfcpu.BookmarkTree{Bookmarks: toPdfcpuBookmarks(marks)}
	treeJSON, err := json.Marshal(tree)
	if err != nil {
		return err
	}
	jsonFile, err := os.CreateTemp("", "pdfcraft_bookmarks_*.json")
	if err != nil {
		return err
	}
	jsonPath := jsonFile.Name()
	if _, err := jsonFile.Write(treeJSON); err != nil {
		_ = jsonFile.Close()
		_ = os.Remove(jsonPath)
		return err
	}
	_ = jsonFile.Close()
	defer os.Remove(jsonPath)

	return saveSafely(absIn, outPath, func(tempTarget string) error {
		return api.ImportBookmarksFile(absIn, jsonPath, tempTarget, true, bookmarkConf(password))
	})
}
