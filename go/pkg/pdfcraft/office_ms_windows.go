//go:build windows

package pdfcraft

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// msOfficeAvailable cho biết có thể thử đường Microsoft Office COM hay
// không: cần PowerPoint/Word/Excel đã cài (kiểm chứng thật diễn ra khi
// tạo COM object trong script) và powershell có sẵn trên Windows.
func msOfficeAvailable() bool {
	_, err := exec.LookPath("powershell")
	return err == nil
}

type msOfficeJob struct {
	Src string `json:"src"`
	Dst string `json:"dst"`
}

// convertBatchMSOffice chuyển một batch file Office sang PDF bằng
// Microsoft Office qua COM (PowerShell), ghi <stem>.pdf vào tmpDir —
// cùng quy ước đặt tên với đường LibreOffice để dùng chung hậu xử lý.
// Danh sách file truyền qua manifest JSON, không nội suy vào script,
// nên tên file chứa ký tự lạ không phá được script.
func convertBatchMSOffice(ctx context.Context, batch []string, tmpDir string) error {
	jobs := make([]msOfficeJob, 0, len(batch))
	for _, src := range batch {
		stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
		jobs = append(jobs, msOfficeJob{Src: src, Dst: filepath.Join(tmpDir, stem+".pdf")})
	}
	manifest, err := json.Marshal(jobs)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(tmpDir, "manifest.json")
	if err := os.WriteFile(manifestPath, manifest, 0600); err != nil {
		return err
	}
	scriptPath := filepath.Join(tmpDir, "convert.ps1")
	// BOM UTF-8 để Windows PowerShell 5.1 đọc đúng chữ tiếng Việt trong script.
	if err := os.WriteFile(scriptPath, []byte("\ufeff"+msOfficeScript), 0600); err != nil {
		return err
	}

	// #nosec G204 -- powershell là thành phần hệ thống Windows; script do
	// chương trình tự ghi, đường dẫn file truyền qua manifest JSON.
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-File", scriptPath)
	// Khi hết thời gian, CommandContext chỉ kill powershell; Office con có thể
	// sống sót và khóa file. Kill cả cây tiến trình bằng taskkill /T.
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// #nosec G204 -- taskkill là công cụ hệ thống, PID lấy từ tiến trình con do chương trình tạo.
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
		return nil
	}
	cmd.WaitDelay = 10 * time.Second
	cmd.Env = append(os.Environ(), "PDFCRAFT_MANIFEST="+manifestPath)
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("chuyển đổi quá thời gian, đã hủy")
	}
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return msOfficeFailureError(detail)
	}
	return nil
}

// Script PowerShell: mở đúng ứng dụng Office theo đuôi file và xuất PDF.
// Hằng số: Word ExportAsFixedFormat wdExportFormatPDF=17,
// Excel ExportAsFixedFormat xlTypePDF=0, PowerPoint SaveAs ppSaveAsPDF=32.
const msOfficeScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$jobs = Get-Content -Raw -LiteralPath $env:PDFCRAFT_MANIFEST -Encoding UTF8 | ConvertFrom-Json
$word = $null; $excel = $null; $ppt = $null
try {
  foreach ($job in $jobs) {
    $ext = [IO.Path]::GetExtension($job.src).ToLower()
    if ($ext -in '.doc', '.docx', '.rtf', '.odt') {
      if (-not $word) {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $word.DisplayAlerts = 0
        $word.EnableEvents = $false
        $word.AutomationSecurity = 3
      }
      $doc = $word.Documents.Open($job.src, $false, $true)
      try { $doc.ExportAsFixedFormat($job.dst, 17) } finally { $doc.Close($false) }
    } elseif ($ext -in '.xls', '.xlsx', '.csv', '.ods') {
      if (-not $excel) {
        $excel = New-Object -ComObject Excel.Application
        $excel.Visible = $false
        $excel.DisplayAlerts = $false
        $excel.EnableEvents = $false
        $excel.AutomationSecurity = 3
      }
      $wb = $excel.Workbooks.Open($job.src, 0, $true)
      try { $wb.ExportAsFixedFormat(0, $job.dst) } finally { $wb.Close($false) }
    } elseif ($ext -in '.ppt', '.pptx', '.odp') {
      if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
        try { $ppt.DisplayAlerts = 1 } catch {}
        try { $ppt.AutomationSecurity = 3 } catch {}
      }
      $pres = $ppt.Presentations.Open($job.src, $true, $false, $false)
      try { $pres.SaveAs($job.dst, 32) } finally { $pres.Close() }
    } else {
      throw "Định dạng chưa hỗ trợ qua Microsoft Office: $ext"
    }
  }
} finally {
  if ($word) { try { $word.Quit() } catch {} }
  $word = $null
  if ($excel) { try { $excel.Quit() } catch {} }
  $excel = $null
  if ($ppt) { try { $ppt.Quit() } catch {} }
  $ppt = $null
}
`
