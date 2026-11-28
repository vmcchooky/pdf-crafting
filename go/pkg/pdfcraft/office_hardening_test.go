package pdfcraft

import (
	"archive/zip"
	"context"
	"encoding/xml"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLibreOfficeArgsHardened(t *testing.T) {
	args := libreOfficeArgs("/tmp/prof ile", "/tmp/out", []string{"a.docx", "b.xlsx"})
	joined := strings.Join(args, " ")

	// Profile tạm, URL-encode đúng (dấu cách → %20).
	if !strings.Contains(joined, "-env:UserInstallation=file:///tmp/prof%20ile") {
		t.Errorf("thiếu -env:UserInstallation URL-encode: %v", args)
	}
	// Flag hardening theo checklist S13.
	for _, f := range []string{"--headless", "--norestore", "--nolockcheck",
		"--nodefault", "--nofirststartwizard"} {
		if !strings.Contains(joined, f) {
			t.Errorf("thiếu flag %s: %v", f, args)
		}
	}
	// Không dùng profile người dùng: profile arg phải là /tmp/prof ile đã cho,
	// không chứa thư mục home.
	if home, _ := os.UserHomeDir(); home != "" && strings.Contains(joined, home) {
		t.Errorf("args chứa home dir (profile người dùng?): %v", args)
	}
	if !strings.Contains(joined, "--convert-to pdf --outdir /tmp/out a.docx b.xlsx") {
		t.Errorf("convert args sai thứ tự/nội dung: %v", args)
	}
}

func TestLibreOfficeProfileArgEncoding(t *testing.T) {
	arg := libreOfficeProfileArg("/tmp/a b/c")
	if arg != "-env:UserInstallation=file:///tmp/a%20b/c" {
		t.Errorf("arg = %q", arg)
	}
}

func TestWriteLibreOfficeProfile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "profile")
	if err := writeLibreOfficeProfile(dir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "user", "registrymodifications.xcu"))
	if err != nil {
		t.Fatal(err)
	}
	// XML hợp lệ.
	var v struct {
		XMLName xml.Name `xml:"items"`
	}
	if err := xml.Unmarshal(data, &v); err != nil {
		t.Fatalf("xcu không phải XML hợp lệ: %v\n%s", err, data)
	}
	// Key đã xác minh (docling/hardentools, LibreOffice 24.2).
	for _, want := range []string{
		`oor:name="MacroSecurityLevel"`, "<value>3</value>",
		`oor:name="DisableMacrosExecution"`, "<value>true</value>",
		`oor:path="/org.openoffice.Office.Writer/Content/Update"`,
		`oor:path="/org.openoffice.Office.Calc/Content/Update"`,
		`oor:name="Link"`, "<value>0</value>",
	} {
		if !strings.Contains(string(data), want) {
			t.Errorf("xcu thiếu %q:\n%s", want, data)
		}
	}
}

// minimalOfficeParts trả về các part (đường dẫn trong zip → nội dung XML)
// cho file Office tối thiểu mà LibreOffice convert được (docx/xlsx/pptx).
// Fixture được sinh trong test thay vì commit file nhị phân: push-files chỉ
// nhận file UTF-8 nên file zip không đẩy lên được qua GitHub MCP.
func minimalOfficeParts(format string) map[string]string {
	ctDocx := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
	relsDocx := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello PDF Craft docx</w:t></w:r></w:p></w:body></w:document>`

	ctXlsx := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
	relsXlsx := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
	wb := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
	wbRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
	sheet := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello xlsx</t></is></c></row></sheetData></worksheet>`
	styles := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts><font><sz val="11"/><name val="Calibri"/></font></fonts><fills><fill><patternFill patternType="none"/></fill></fills><borders><border/></borders><cellStyleXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

	ctPptx := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`
	relsPptx := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
	pres := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
	presRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`
	slide := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Hello pptx</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
	slideRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
	layout := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
	layoutRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
	master := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`
	masterRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
	theme := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst/><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

	switch format {
	case "docx":
		return map[string]string{
			"[Content_Types].xml": ctDocx, "_rels/.rels": relsDocx, "word/document.xml": doc,
		}
	case "xlsx":
		return map[string]string{
			"[Content_Types].xml": ctXlsx, "_rels/.rels": relsXlsx, "xl/workbook.xml": wb,
			"xl/_rels/workbook.xml.rels": wbRels, "xl/worksheets/sheet1.xml": sheet, "xl/styles.xml": styles,
		}
	case "pptx":
		return map[string]string{
			"[Content_Types].xml": ctPptx, "_rels/.rels": relsPptx, "ppt/presentation.xml": pres,
			"ppt/_rels/presentation.xml.rels": presRels, "ppt/slides/slide1.xml": slide,
			"ppt/slides/_rels/slide1.xml.rels": slideRels, "ppt/slideLayouts/slideLayout1.xml": layout,
			"ppt/slideLayouts/_rels/slideLayout1.xml.rels": layoutRels,
			"ppt/slideMasters/slideMaster1.xml":            master, "ppt/slideMasters/_rels/slideMaster1.xml.rels": masterRels,
			"ppt/theme/theme1.xml": theme,
		}
	default:
		return nil
	}
}

// writeMinimalOfficeFixtures sinh 3 file Office tối thiểu (sample.docx/xlsx/
// pptx) vào thư mục tạm và trả về đường dẫn của chúng.
func writeMinimalOfficeFixtures(t *testing.T) []string {
	t.Helper()
	dir := t.TempDir()
	var paths []string
	for _, format := range []string{"docx", "xlsx", "pptx"} {
		p := filepath.Join(dir, "sample."+format)
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		zw := zip.NewWriter(f)
		for name, content := range minimalOfficeParts(format) {
			w, err := zw.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := w.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	return paths
}

// fakeOfficeEngine ghi một engine Go giả: log argv, copy xcu của profile
// tạm ra ngoài để test assert, và tạo PDF giả cho mỗi file input.
// Cross-platform (Windows + Unix).
func writeFakeOfficeEngine(t *testing.T, argsLog, xcuCopy, samplePDF string) string {
	t.Helper()
	// Write Go source for fake engine.
	goSrc := `package main

import (
	"os"
	"path/filepath"
	"strings"
)

func main() {
	argsLog := os.Getenv("FAKE_ARGS_LOG")
	xcuCopy := os.Getenv("FAKE_XCU_COPY")
	samplePDF := os.Getenv("FAKE_SAMPLE_PDF")

	// Log all arguments.
	if err := os.WriteFile(argsLog, []byte(strings.Join(os.Args[1:], " ")), 0644); err != nil {
		os.Exit(1)
	}

	outdir := ""
	profile := ""
	for i, a := range os.Args[1:] {
		if a == "--outdir" && i+1 < len(os.Args[1:]) {
			outdir = os.Args[i+2]
		}
		if strings.HasPrefix(a, "-env:UserInstallation=") {
			profile = strings.TrimPrefix(a, "-env:UserInstallation=")
			profile = strings.TrimPrefix(profile, "file://")
		}
	}

	if profile != "" {
		xcuPath := filepath.Join(profile, "user", "registrymodifications.xcu")
		if _, err := os.Stat(xcuPath); err == nil {
			data, _ := os.ReadFile(xcuPath)
			os.WriteFile(xcuCopy, data, 0644)
		}
	}

	exts := map[string]bool{
		".docx": true, ".xlsx": true, ".pptx": true,
		".doc": true, ".xls": true, ".ppt": true,
		".odt": true, ".ods": true, ".odp": true,
		".rtf": true, ".csv": true,
	}

	for _, f := range os.Args[1:] {
		ext := strings.ToLower(filepath.Ext(f))
		if exts[ext] && outdir != "" {
			stem := filepath.Base(f)
			stem = strings.TrimSuffix(stem, ext)
			dst := filepath.Join(outdir, stem+".pdf")
			data, _ := os.ReadFile(samplePDF)
			os.WriteFile(dst, data, 0644)
		}
	}
}
`
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "fake_engine.go")
	if err := os.WriteFile(srcPath, []byte(goSrc), 0644); err != nil {
		t.Fatal(err)
	}

	binName := "fake-soffice"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	binPath := filepath.Join(tmpDir, binName)

	cmd := exec.Command("go", "build", "-o", binPath, srcPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake engine: %v\n%s", err, out)
	}

	t.Setenv("FAKE_ARGS_LOG", argsLog)
	t.Setenv("FAKE_XCU_COPY", xcuCopy)
	t.Setenv("FAKE_SAMPLE_PDF", samplePDF)
	return binPath
}

func TestConvertOfficeToPdfFakeEngine(t *testing.T) {
	dir := t.TempDir()
	argsLog := filepath.Join(dir, "args.log")
	xcuCopy := filepath.Join(dir, "xcu.xml")
	samplePDF := filepath.Join("..", "..", "..", "web", "e2e", "fixtures", "sample.pdf")
	engine := writeFakeOfficeEngine(t, argsLog, xcuCopy, samplePDF)

	outDir := filepath.Join(dir, "out")
	ins := writeMinimalOfficeFixtures(t)
	outs, err := ConvertOfficeToPdfContext(context.Background(), ins, outDir, engine, 60)
	if err != nil {
		t.Fatalf("convert qua fake engine lỗi: %v", err)
	}
	if len(outs) != 3 {
		t.Fatalf("outs = %v, muốn 3 file", outs)
	}
	for _, o := range outs {
		data, err := os.ReadFile(o)
		if err != nil || len(data) == 0 || !strings.HasPrefix(string(data), "%PDF") {
			t.Errorf("output %s không phải PDF hợp lệ: err=%v len=%d", o, err, len(data))
		}
	}

	argv, err := os.ReadFile(argsLog)
	if err != nil {
		t.Fatal(err)
	}
	// Profile tạm được truyền cho engine, không phải profile người dùng.
	// (Chỉ kiểm tra token profile: argv vốn chứa đường dẫn input tuyệt đối
	// nên home dir xuất hiện ở đó là bình thường.)
	profileArg := ""
	for _, tok := range strings.Fields(string(argv)) {
		if strings.HasPrefix(tok, "-env:UserInstallation=") {
			profileArg = tok
		}
	}
	if !strings.HasPrefix(profileArg, "-env:UserInstallation=file://") {
		t.Errorf("argv thiếu -env:UserInstallation:\n%s", argv)
	}
	profilePath := strings.TrimPrefix(strings.TrimPrefix(profileArg, "-env:UserInstallation=file://"), "file://")
	if home, _ := os.UserHomeDir(); home != "" && strings.Contains(profilePath, ".config/libreoffice") {
		t.Errorf("profile trỏ vào profile người dùng: %s", profilePath)
	}
	// Normalize paths for comparison (Windows: case-insensitive, handle separators).
	tmp := os.TempDir()
	normProfile := filepath.Clean(profilePath)
	normTmp := filepath.Clean(tmp)
	if runtime.GOOS == "windows" {
		normProfile = strings.ToLower(normProfile)
		normTmp = strings.ToLower(normTmp)
	}
	if !strings.HasPrefix(normProfile, normTmp) {
		t.Errorf("profile %s không nằm trong thư mục tạm %s", profilePath, tmp)
	}
	for _, f := range []string{"--headless", "--norestore", "--nolockcheck",
		"--nodefault", "--nofirststartwizard"} {
		if !strings.Contains(string(argv), f) {
			t.Errorf("argv thiếu flag %s:\n%s", f, argv)
		}
	}
	// Profile tạm thực sự được tạo và chứa xcu hardening khi engine chạy.
	xcu, err := os.ReadFile(xcuCopy)
	if err != nil {
		t.Fatalf("engine không thấy xcu trong profile tạm: %v", err)
	}
	if !strings.Contains(string(xcu), "MacroSecurityLevel") || !strings.Contains(string(xcu), "<value>3</value>") {
		t.Errorf("xcu trong profile tạm thiếu MacroSecurityLevel=3:\n%s", xcu)
	}
}

// TestConvertOfficeToPdfRealLibreOffice chạy convert thật 3 định dạng bằng
// LibreOffice có sẵn (LibreOffice 24.2.7.2 trên máy này). Skip khi không có.
func TestConvertOfficeToPdfRealLibreOffice(t *testing.T) {
	if FindOfficeEngine() == "" {
		t.Skip("không có LibreOffice trên máy này")
	}
	outDir := t.TempDir()
	ins := writeMinimalOfficeFixtures(t)
	outs, err := ConvertOfficeToPdfContext(context.Background(), ins, outDir, "", 180)
	if err != nil {
		t.Fatalf("convert thật lỗi: %v", err)
	}
	if len(outs) != 3 {
		t.Fatalf("outs = %v, muốn 3 file", outs)
	}
	for i, o := range outs {
		data, err := os.ReadFile(o)
		if err != nil {
			t.Fatal(err)
		}
		if len(data) == 0 || !strings.HasPrefix(string(data), "%PDF") {
			t.Errorf("output %s không phải PDF (len=%d)", o, len(data))
		}
		// PDF convert thật phải có text trích được.
		pages, err := ExtractText(o, nil)
		if err != nil {
			t.Errorf("ExtractText %s lỗi: %v", o, err)
			continue
		}
		var all strings.Builder
		for _, p := range pages {
			all.WriteString(p)
		}
		// Bỏ khoảng trắng vì pdfcpu có thể trích từng chữ cách nhau (vd "H e l l o").
		normalized := strings.ReplaceAll(strings.ToLower(all.String()), " ", "")
		if !strings.Contains(normalized, "hello") {
			t.Errorf("PDF %s (từ %s) không chứa text gốc, text=%q", o, ins[i], all.String())
		}
	}
}
