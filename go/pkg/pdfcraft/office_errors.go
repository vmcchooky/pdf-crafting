package pdfcraft

import "fmt"

// engineMissingError: không tìm thấy engine chuyển đổi nào.
func engineMissingError() error {
	return fmt.Errorf("không tìm thấy LibreOffice hoặc Microsoft Office để chuyển đổi. Hãy cài LibreOffice (https://libreoffice.org) rồi thử lại, hoặc truyền -engine <đường_dẫn_soffice>")
}

// msOfficeFailureError: Office COM có mặt nhưng chuyển đổi thất bại — luôn
// kèm hướng dẫn để người dùng tự xử lý thay vì chỉ thấy lỗi kỹ thuật.
func msOfficeFailureError(detail string) error {
	return fmt.Errorf("chuyển đổi bằng Microsoft Office thất bại: %s. Hãy cài LibreOffice (https://libreoffice.org) hoặc kiểm tra bộ Microsoft Office (Word/Excel/PowerPoint) đã cài đặt đầy đủ", detail)
}
