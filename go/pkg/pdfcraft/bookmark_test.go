package pdfcraft

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func seedBookmarkedPDF(t *testing.T, dir, name string, pages int, marks []pdfcpu.Bookmark) string {
	t.Helper()
	base := filepath.Join(dir, name+"_base.pdf")
	createValidTestPDF(t, base, pages)
	out := filepath.Join(dir, name+".pdf")
	if err := api.AddBookmarksFile(base, out, marks, true, model.NewDefaultConfiguration()); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBookmarkRoundtrip(t *testing.T) {
	dir := t.TempDir()
	seed := seedBookmarkedPDF(t, dir, "seed", 5, []pdfcpu.Bookmark{
		{Title: "Chuong 1", PageFrom: 1, Kids: []pdfcpu.Bookmark{
			{Title: "Muc 1.1", PageFrom: 2},
		}},
		{Title: "Chuong 2", PageFrom: 4},
	})

	got, err := ListBookmarks(seed, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Title != "Chuong 1" || got[0].Page != 1 {
		t.Fatalf("list sai: %+v", got)
	}
	if len(got[0].Kids) != 1 || got[0].Kids[0].Title != "Muc 1.1" || got[0].Kids[0].Page != 2 {
		t.Fatalf("kids sai: %+v", got[0].Kids)
	}
	if got[1].Title != "Chuong 2" || got[1].Page != 4 {
		t.Fatalf("muc 2 sai: %+v", got[1])
	}

	// Add
	added := filepath.Join(dir, "added.pdf")
	if err := AddBookmark(seed, added, "Phu luc", 5, ""); err != nil {
		t.Fatal(err)
	}
	got2, err := ListBookmarks(added, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) != 3 || got2[2].Title != "Phu luc" || got2[2].Page != 5 {
		t.Fatalf("add sai: %+v", got2)
	}

	// Export -> Import roundtrip
	exp, err := ExportBookmarks(added, "")
	if err != nil {
		t.Fatal(err)
	}
	var tree pdfcpu.BookmarkTree
	if err := json.Unmarshal(exp, &tree); err != nil {
		t.Fatalf("export JSON hỏng: %v", err)
	}
	if len(tree.Bookmarks) != 3 {
		t.Fatalf("export thiếu: %+v", tree.Bookmarks)
	}

	plain, _ := json.Marshal([]Bookmark{{Title: "Moi", Page: 3}})
	imp := filepath.Join(dir, "imp.pdf")
	if err := ImportBookmarks(added, imp, plain, ""); err != nil {
		t.Fatal(err)
	}
	got3, err := ListBookmarks(imp, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got3) != 1 || got3[0].Title != "Moi" || got3[0].Page != 3 {
		t.Fatalf("import sai: %+v", got3)
	}

	// Clear
	clr := filepath.Join(dir, "clr.pdf")
	if err := ClearBookmarks(imp, clr, ""); err != nil {
		t.Fatal(err)
	}
	got4, err := ListBookmarks(clr, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got4) != 0 {
		t.Fatalf("clear chưa sạch: %+v", got4)
	}

	// Trang sai
	if err := AddBookmark(seed, filepath.Join(dir, "x.pdf"), "Sai", 99, ""); err == nil {
		t.Errorf("expected error for out-of-range page")
	}
}

func TestMergeKeepsBookmarks(t *testing.T) {
	dir := t.TempDir()
	a := seedBookmarkedPDF(t, dir, "a", 3, []pdfcpu.Bookmark{{Title: "Chuong 1", PageFrom: 1}})
	b := seedBookmarkedPDF(t, dir, "b", 2, []pdfcpu.Bookmark{{Title: "Phu luc", PageFrom: 2}})

	merged := filepath.Join(dir, "merged.pdf")
	if err := MergeFiles([]string{a, b}, merged); err != nil {
		t.Fatal(err)
	}
	got, err := ListBookmarks(merged, "")
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, m := range got {
		found[m.Title] = true
		for _, k := range m.Kids {
			found[k.Title] = true
		}
	}
	if !found["Chuong 1"] || !found["Phu luc"] {
		t.Fatalf("merge mất bookmark: %+v", got)
	}
}
