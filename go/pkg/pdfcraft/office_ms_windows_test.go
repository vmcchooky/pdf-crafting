//go:build windows

package pdfcraft

import (
	"strings"
	"testing"
)

// TestMSOfficeScriptHardening (S13): script COM phải đặt các chế độ an toàn.
// Chỉ chạy trên Windows CI (file này có build tag windows).
func TestMSOfficeScriptHardening(t *testing.T) {
	for _, want := range []string{
		"AskToUpdateLinks = $false",
		"AutomationSecurity = 3",
		"DisplayAlerts = 0",
		"EnableEvents = $false",
		"Visible = $false",
		"$doc.Close($false)",
		"$wb.Close($false)",
		"$pres.Close()",
		"$word.Quit()",
		"$excel.Quit()",
		"$ppt.Quit()",
	} {
		if !strings.Contains(msOfficeScript, want) {
			t.Errorf("msOfficeScript thiếu %q", want)
		}
	}
}
