package pdfcraft

import (
	"context"
	"fmt"
	"net/url"
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

// libreOfficeHardeningXCU là registrymodifications.xcu gieo vào profile tạm
// của mỗi batch convert (S13). Key đã xác minh theo docling/hardentools và
// LibreOffice 24.2:
//   - MacroSecurityLevel=3 (Very High) + DisableMacrosExecution=true:
//     macro trong tài liệu không chạy khi convert.
//   - Writer/Content/Update Link=0 và Calc/Content/Update Link=0: không cập
//     nhật link ngoài/DDE khi mở file (chống SSRF/file-inclusion qua link).
//
// DDE/OLE-object/remote-image không có key chung đáng tin cậy cho mọi phiên
// bản LibreOffice nên không đặt ở đây — ghi residual risk trong report.
const libreOfficeHardeningXCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
  <prop oor:name="MacroSecurityLevel" oor:op="fuse">
   <value>3</value>
  </prop>
 </item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
  <prop oor:name="DisableMacrosExecution" oor:op="fuse">
   <value>true</value>
  </prop>
 </item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update">
  <prop oor:name="Link" oor:op="fuse">
   <value>0</value>
  </prop>
 </item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update">
  <prop oor:name="Link" oor:op="fuse">
   <value>0</value>
  </prop>
 </item>
</oor:items>
`

// writeLibreOfficeProfile tạo profile tạm (dir/user/registrymodifications.xcu)
// với cấu hình hardening. LibreOffice tự tạo phần còn lại khi chạy lần đầu.
func writeLibreOfficeProfile(profileDir string) error {
	userDir := filepath.Join(profileDir, "user")
	if err := os.MkdirAll(userDir, 0750); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(userDir, "registrymodifications.xcu"), []byte(libreOfficeHardeningXCU), 0600)
}

// libreOfficeProfileArg trả về -env:UserInstallation=file:///<profile>
// (URL-encode đúng trên Windows nhờ net/url).
func libreOfficeProfileArg(profileDir string) string {
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(profileDir)}
	return "-env:UserInstallation=" + u.String()
}

// libreOfficeArgs dựng argv cho soffice: profile tạm + flag hardening
// (checklist S13) + convert. Hàm thuần để unit test assert được mà không cần
// binary LibreOffice.
func libreOfficeArgs(profileDir, outDir string, batch []string) []string {
	args := []string{
		libreOfficeProfileArg(profileDir),
		"--headless", "--norestore", "--nolockcheck", "--nodefault",
		"--nofirststartwizard", "--nologo",
		"--convert-to", "pdf", "--outdir", outDir,
	}
	return append(args, batch...)
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

// ConvertOfficeToPdfContext chuyển hàng loạt file Office sang PDF, giữ đúng thứ tự đầu vào.
// ctx của caller (vd: request HTTP) được tôn trọng: hủy/timeout sẽ dừng converter.
// outDir trống = cùng thư mục file gốc. enginePath trống = tự tìm LibreOffice;
// không có LibreOffice thì trên Windows tự dùng Microsoft Office (COM) nếu có.
// Trả về danh sách file PDF đã tạo theo đúng thứ tự input.
func ConvertOfficeToPdfContext(ctx context.Context, inputPaths []string, outDir, enginePath string, timeoutSec int) ([]string, error) {
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
	// Không có LibreOffice: trên Windows thử đường Microsoft Office COM
	// (đa số máy cá nhân có sẵn MS Office); nơi khác thì báo rõ ràng.
	useMSOffice := false
	if engine == "" {
		if msOfficeAvailable() {
			useMSOffice = true
		} else {
			return nil, engineMissingError()
		}
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
				// Timeout của lượt convert tính từ ctx của caller: client ngắt
				// hoặc hết timeoutSec đều dừng converter (S9).
				ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
				defer cancel()

				if useMSOffice {
					if err := convertBatchMSOffice(ctx, batch, tmpDir); err != nil {
						if ctx.Err() == context.DeadlineExceeded {
							return fmt.Errorf("chuyển đổi quá thời gian (%ds), đã hủy", timeoutSec)
						}
						return err
					}
				} else {
					// S13: profile LibreOffice tạm cho mỗi batch — không dùng
					// profile người dùng, macro tắt mức cao nhất, không cập nhật
					// link ngoài. Profile nằm trong tmpDir của batch nên được
					// dọn cùng (defer RemoveAll). Lỗi tạo profile → fail closed,
					// không convert bằng profile mặc định.
					profileDir := filepath.Join(tmpDir, "profile")
					if err := writeLibreOfficeProfile(profileDir); err != nil {
						return fmt.Errorf("không tạo được profile LibreOffice tạm: %w", err)
					}
					args := libreOfficeArgs(profileDir, tmpDir, batch)
					// #nosec G204 -- engine là LibreOffice đã kiểm chứng tồn tại, batch là file do người dùng chỉ định cho CLI cục bộ
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
				}
				for _, src := range batch {
					stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
					produced_tmp := filepath.Join(tmpDir, stem+".pdf")
					if _, err := os.Stat(produced_tmp); err != nil {
						return fmt.Errorf("converter không tạo ra file: %s.pdf", stem)
					}
					if err := moveResultFile(produced_tmp, wanted[src]); err != nil {
						return fmt.Errorf("không thể dời file kết quả: %w", err)
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

// ConvertOfficeToPdf là wrapper cũ cho CLI (không có ctx của request).
func ConvertOfficeToPdf(inputPaths []string, outDir, enginePath string, timeoutSec int) ([]string, error) {
	return ConvertOfficeToPdfContext(context.Background(), inputPaths, outDir, enginePath, timeoutSec)
}
