package main

import (
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadPasswordLine(t *testing.T) {
	pw, err := readPasswordLine(strings.NewReader("secret123\r\n"))
	if err != nil || pw != "secret123" {
		t.Errorf("CRLF: pw = %q, err = %v", pw, err)
	}

	// EOF không có newline vẫn đọc được.
	pw, err = readPasswordLine(strings.NewReader("secret123"))
	if err != nil || pw != "secret123" {
		t.Errorf("EOF: pw = %q, err = %v", pw, err)
	}

	// Rỗng → lỗi.
	if _, err := readPasswordLine(strings.NewReader("\n")); err == nil {
		t.Errorf("dòng rỗng phải lỗi")
	}
	if _, err := readPasswordLine(strings.NewReader("")); err == nil {
		t.Errorf("stdin rỗng phải lỗi")
	}
}

func TestResolvePasswordFlag(t *testing.T) {
	// Cả hai cùng set → lỗi rõ ràng.
	if _, err := resolvePasswordFlag("x", true, strings.NewReader("y\n")); err == nil {
		t.Errorf("conflict phải lỗi")
	} else if !strings.Contains(err.Error(), "chỉ dùng một trong") {
		t.Errorf("lỗi conflict = %q", err.Error())
	}

	// Đọc từ stdin.
	pw, err := resolvePasswordFlag("", true, strings.NewReader("pw123\n"))
	if err != nil || pw != "pw123" {
		t.Errorf("stdin: pw = %q, err = %v", pw, err)
	}

	// Flag thường (tương thích ngược) vẫn trả về giá trị.
	pw, err = resolvePasswordFlag("abc", false, nil)
	if err != nil || pw != "abc" {
		t.Errorf("argv: pw = %q, err = %v", pw, err)
	}

	// Không có nguồn nào → "" không lỗi (mật khẩu tùy chọn).
	pw, err = resolvePasswordFlag("", false, nil)
	if err != nil || pw != "" {
		t.Errorf("không nguồn: pw = %q, err = %v", pw, err)
	}
}

func TestResolveRequiredPasswordNonTerminal(t *testing.T) {
	// Trong go test stdin không phải terminal → lỗi hướng dẫn dùng --password-stdin.
	_, err := resolveRequiredPassword("", false, strings.NewReader(""))
	if err == nil {
		t.Errorf("thiếu mật khẩu phải lỗi khi stdin không phải terminal")
	} else if !strings.Contains(err.Error(), "--password-stdin") {
		t.Errorf("lỗi = %q, muốn hướng dẫn dùng --password-stdin", err.Error())
	}
}

func TestParseFlagsAndArgsBoolFlag(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	pwStdin := fs.Bool("password-stdin", false, "")
	fs.String("o", "", "")
	tail := parseFlagsAndArgs(fs, []string{"--password-stdin", "file.pdf", "-o", "out.pdf"})
	if !*pwStdin {
		t.Errorf("bool flag --password-stdin không được set")
	}
	if len(tail) != 1 || tail[0] != "file.pdf" {
		t.Errorf("tail = %v, muốn [file.pdf] (file không được ăn làm giá trị của bool flag)", tail)
	}
	if got := fs.Lookup("o").Value.String(); got != "out.pdf" {
		t.Errorf("-o = %q, muốn out.pdf", got)
	}
}

func buildPdfcraftBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "pdfcraft-test")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go build lỗi: %v\n%s", err, out)
	}
	return bin
}

// TestPasswordStdinCLI (S12): integration thật với binary — encrypt/info/
// decrypt qua --password-stdin, flag --password cũ, conflict, help text.
func TestPasswordStdinCLI(t *testing.T) {
	bin := buildPdfcraftBinary(t)
	dir := t.TempDir()
	sample := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	data, err := os.ReadFile(sample)
	if err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(dir, "plain.pdf")
	if err := os.WriteFile(plain, data, 0600); err != nil {
		t.Fatal(err)
	}
	enc := filepath.Join(dir, "enc.pdf")
	dec := filepath.Join(dir, "dec.pdf")

	run := func(stdin string, args ...string) (string, int) {
		cmd := exec.Command(bin, args...)
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				t.Fatalf("chạy %v lỗi: %v", args, err)
			}
		}
		return string(out), code
	}

	// encrypt qua stdin (bool flag đứng trước file — kiểm tra parseFlagsAndArgs).
	if out, code := run("secret123\n", "encrypt", "--user-pw-stdin", plain, "-o", enc); code != 0 {
		t.Fatalf("encrypt --user-pw-stdin: exit %d: %s", code, out)
	}
	// info qua stdin.
	out, code := run("secret123\n", "info", enc, "--password-stdin")
	if code != 0 || !strings.Contains(out, "Tổng số trang") {
		t.Fatalf("info --password-stdin: exit %d: %s", code, out)
	}
	// decrypt qua stdin.
	if out, code := run("secret123\n", "decrypt", enc, "--password-stdin", "-o", dec); code != 0 {
		t.Fatalf("decrypt --password-stdin: exit %d: %s", code, out)
	}
	// File đã giải mã mở được không cần mật khẩu.
	if out, code := run("", "info", dec); code != 0 {
		t.Fatalf("info file đã giải mã: exit %d: %s", code, out)
	}
	// Flag --password cũ vẫn hoạt động.
	if out, code := run("", "info", enc, "--password", "secret123"); code != 0 {
		t.Fatalf("info --password cũ: exit %d: %s", code, out)
	}
	// Sai mật khẩu qua stdin → lỗi.
	if _, code := run("wrong\n", "info", enc, "--password-stdin"); code == 0 {
		t.Errorf("sai mật khẩu qua stdin phải lỗi")
	}
	// Conflict cả hai flag → lỗi, không ghi file.
	xpdf := filepath.Join(dir, "x.pdf")
	if out, code := run("secret123\n", "decrypt", enc, "--password", "secret123", "--password-stdin", "-o", xpdf); code == 0 {
		t.Errorf("conflict hai flag phải lỗi, output: %s", out)
	}
	if _, err := os.Stat(xpdf); !os.IsNotExist(err) {
		t.Errorf("conflict vẫn ghi file %s", xpdf)
	}
	// Help tổng có flag mới. (Không gọi không arg: main() không arg sẽ chạy
	// Web UI server và không thoát.)
	out, _ = run("", "--help")
	if !strings.Contains(out, "--password-stdin") || !strings.Contains(out, "--user-pw-stdin") {
		t.Errorf("help thiếu flag mới:\n%s", out)
	}
}
