package pdfcraft

import (
	"strings"
	"testing"
)

func TestEngineMissingErrorHasGuidance(t *testing.T) {
	err := engineMissingError()
	if err == nil {
		t.Fatal("expected non-nil error")
	}
	if !strings.Contains(err.Error(), "LibreOffice") {
		t.Fatalf("missing LibreOffice guidance: %v", err)
	}
}

func TestMSOfficeFailureErrorKeepsDetailAndGuidance(t *testing.T) {
	err := msOfficeFailureError("RPC server is unavailable")
	if err == nil {
		t.Fatal("expected non-nil error")
	}
	msg := err.Error()
	for _, want := range []string{"RPC server is unavailable", "LibreOffice", "Microsoft Office"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q missing %q", msg, want)
		}
	}
}
