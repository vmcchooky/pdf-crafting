package pdfcraft

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// SupportedOfficeExtensions là các định dạng Office chuyển được sang PDF (qua LibreOffice).
var SupportedOfficeExtensions = map[string]bool{
	".docx": true, ".doc": true, ".odt": true, ".rtf": true,
	".xlsx": true, ".xls": true, ".ods": true, ".csv": true,
	".pptx": true, ".ppt": true, ".odp": true,
}

var knownSofficePaths = []string{
	`C:\Program Files\LibreOffice\program\soffice.exe`,
	`C:\Program Files (x86)\LibreOffice\program\soffice.exe`,
	"/usr/bin/soffice",
	"/usr/bin/libreoffice",
	"/opt/libreoffice/program/soffice",
	"/Applications/LibreOffice.app/Contents/MacOS/soffice",
}

// FindOfficeEngine tìm binary `soffice`/`libreoffice`, trả về "" nếu không có.
func FindOfficeEngine() string {
	for _, name := range []string{"soffice", "libreoffice"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	for _, c := range knownSofficePaths {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}

func uniqueOfficeOutput(outDir, stem string, reserved map[string]bool) string {
	candidate := filepath.Join(outDir, stem+".pdf")
	counter := 2
	for {
		if _, err := os.Stat(candidate); os.IsNotExist(err) && !reserved[candidate] {
			break
		}
		candidate = filepath.Join(outDir, fmt.Sprintf("%s_%d.pdf", stem, counter))
		counter++
	}
	reserved[candidate] = true
	return candidate
}

// ConvertOfficeToPdf chuyển hàng loạt file Office sang PDF, giữ đúng thứ tự đầu vào.
// outDir trống = cùng thư mục file gốc. enginePath trống = tự tìm LibreOffice.
// Trả về danh sách file PDF đã tạo theo đúng thứ tự input.
func ConvertOfficeToPdf(inputPaths []string, outDir, enginePath string, timeoutSec int) ([]string, error) {
	if len(inputPaths) == 0 {
		return nil, fmt.Errorf("cần ít nhất 1 file Office đầu vào để chuyển đổi")
	}

	var valid []string
	byDir := make(map[string][]string)
	var dirOrder []string
	for _, p := range inputPaths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return nil, err
		}
		fi, err := os.Stat(abs)
		if err != nil || fi.IsDir() {
			return nil, fmt.Errorf("không tìm thấy file đầu vào: %s", p)
		}
		ext := strings.ToLower(filepath.Ext(abs))
		if !SupportedOfficeExtensions[ext] {
			return nil, fmt.Errorf("định dạng chưa hỗ trợ: %s", filepath.Base(p))
		}
		valid = append(valid, abs)

		targetDir := outDir
		if targetDir == "" {
			targetDir = filepath.Dir(abs)
		} else {
			absOut, err := filepath.Abs(outDir)
			if err != nil {
				return nil, err
			}
			targetDir = absOut
		}
		if err := os.MkdirAll(targetDir, 0750); err != nil {
			return nil, fmt.Errorf("không thể tạo thư mục đích: %w", err)
		}
		if _, ok := byDir[targetDir]; !ok {
			dirOrder = append(dirOrder, targetDir)
		}
		byDir[targetDir] = append(byDir[targetDir], abs)
	}
	if len(valid) == 0 {
		return nil, fmt.Errorf("cần ít nhất 1 file Office đầu vào để chuyển đổi")
	}

	engine := enginePath
	if engine == "" {
		engine = FindOfficeEngine()
	}
	if engine == "" {
		return nil, fmt.Errorf("không tìm thấy LibreOffice để chuyển đổi. Hãy cài LibreOffice (https://libreoffice.org) rồi thử lại, hoặc truyền -engine <đường_dẫn_soffice>")
	}
	if timeoutSec <= 0 {
		timeoutSec = 180
	}

	produced := make(map[string]string, len(valid))
	for _, targetDir := range dirOrder {
		sources := byDir[targetDir]

		reserved := make(map[string]bool)
		wanted := make(map[string]string, len(sources))
		for _, src := range sources {
			stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
			wanted[src] = uniqueOfficeOutput(targetDir, stem, reserved)
		}

		// Chia lượt con nếu trùng stem (converter luôn ghi <stem>.pdf).
		remaining := append([]string(nil), sources...)
		for len(remaining) > 0 {
			var batch []string
			seen := make(map[string]bool)
			var rest []string
			for _, src := range remaining {
				stem := strings.ToLower(strings.TrimSuffix(filepath.Base(src), filepath.Ext(src)))
				if seen[stem] {
					rest = append(rest, src)
				} else {
					seen[stem] = true
					batch = append(batch, src)
				}
			}
			remaining = rest

			tmpDir, err := os.MkdirTemp("", "pdfcraft_convert_*")
			if err != nil {
				return nil, err
			}
			runErr := func() error {
				defer os.RemoveAll(tmpDir)
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
				defer cancel()

				args := []string{"--headless", "--convert-to", "pdf", "--outdir", tmpDir}
				args = append(args, batch...)
				cmd := exec.CommandContext(ctx, engine, args...)
				out, err := cmd.CombinedOutput()
				if ctx.Err() == context.DeadlineExceeded {
					return fmt.Errorf("chuyển đổi quá thời gian (%ds), đã hủy", timeoutSec)
				}
				if err != nil {
					detail := strings.TrimSpace(string(out))
					if detail == "" {
						detail = err.Error()
					}
					return fmt.Errorf("không chạy được converter: %s", detail)
				}
				for _, src := range batch {
					stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
					produced_tmp := filepath.Join(tmpDir, stem+".pdf")
					if _, err := os.Stat(produced_tmp); err != nil {
						return fmt.Errorf("converter không tạo ra file: %s.pdf", stem)
					}
					if err := os.Rename(produced_tmp, wanted[src]); err != nil {
						_ = os.Remove(wanted[src])
						if err2 := os.Rename(produced_tmp, wanted[src]); err2 != nil {
							return fmt.Errorf("không thể dời file kết quả: %w", err2)
						}
					}
					produced[src] = wanted[src]
				}
				return nil
			}()
			if runErr != nil {
				return nil, runErr
			}
		}
	}

	result := make([]string, 0, len(valid))
	for _, src := range valid {
		result = append(result, produced[src])
	}
	return result, nil
}
