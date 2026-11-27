//go:build !windows

package pdfcraft

import (
	"context"
	"fmt"
)

// msOfficeAvailable: đường Microsoft Office COM chỉ tồn tại trên Windows.
func msOfficeAvailable() bool { return false }

// convertBatchMSOffice: không bao giờ được gọi ngoài Windows vì
// msOfficeAvailable luôn trả false; giữ stub để mã chung biên dịch được.
func convertBatchMSOffice(_ context.Context, _ []string, _ string) error {
	return fmt.Errorf("Microsoft Office COM chỉ khả dụng trên Windows")
}
