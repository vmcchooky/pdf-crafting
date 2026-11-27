#!/usr/bin/env python3
"""Tái tạo font subset cho watermark Unicode (go/pkg/pdfcraft/fontdata.go).

Nguồn: Noto Sans Regular (SIL OFL 1.1), subset giữ Latin + tiếng Việt,
đổi tên family thành PDFCraftSans (OFL yêu cầu bản sửa đổi không dùng
tên gốc), rồi mã hoá base64 vào fontdata.go — dạng lưu trữ này giúp
đẩy mã qua GitHub API (chỉ nhận UTF-8) mà không hỏng dữ liệu nhị phân.

Yêu cầu: pip install fonttools
Dùng:    python scripts/subset-font.py /đường/dẫn/NotoSans-Regular.ttf
"""

import base64
import io
import sys
import textwrap

from fontTools import subset
from fontTools.ttLib import TTFont  # noqa: F401  (fontTools.subset dùng nội bộ)

RANGES = [
    (0x20, 0x7E),      # ASCII cơ bản
    (0xA0, 0xFF),      # Latin-1 Supplement
    (0x100, 0x17F),    # Latin Extended-A (ă â đ ê ô...)
    (0x1A0, 0x1B0),    # ơ ư và họ hàng
    (0x300, 0x36F),    # dấu tổ hợp
    (0x1EA0, 0x1EF9),  # Latin Extended Additional (tiếng Việt đầy đủ)
    (0x2010, 0x2027),  # dấu câu mở rộng (—, "", ...)
    (0x2030, 0x2030),  # ‰
    (0x20AB, 0x20AB),  # ₫
]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    unicodes = [cp for a, b in RANGES for cp in range(a, b + 1)]

    opts = subset.Options()
    opts.hinting = False
    opts.layout_features = []
    opts.name_IDs = [1, 2, 4, 6, 16, 17]
    opts.notdef_outline = True
    opts.recommended_glyphs = True

    font = subset.load_font(src, opts)
    ss = subset.Subsetter(options=opts)
    ss.populate(unicodes=unicodes)
    ss.subset(font)

    name = font["name"]
    for nid, plat, enc, lang, val in [
        (1, 3, 1, 0x409, "PDFCraftSans"), (2, 3, 1, 0x409, "Regular"),
        (4, 3, 1, 0x409, "PDFCraftSans"), (6, 3, 1, 0x409, "PDFCraftSans"),
        (16, 3, 1, 0x409, "PDFCraftSans"), (17, 3, 1, 0x409, "Regular"),
        (1, 1, 0, 0, "PDFCraftSans"), (2, 1, 0, 0, "Regular"),
        (4, 1, 0, 0, "PDFCraftSans"), (6, 1, 0, 0, "PDFCraftSans"),
    ]:
        name.setName(val, nid, plat, enc, lang)

    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    b64 = base64.b64encode(data).decode()
    chunks = textwrap.wrap(b64, 100)
    lines = "\n".join(f'\t"{c}" +' for c in chunks[:-1]) + f'\n\t"{chunks[-1]}"'
    out = (
        "package pdfcraft\n\n"
        "// pdfCraftSansTTFB64 là font PDFCraftSans.ttf (subset từ Noto Sans Regular,\n"
        "// SIL OFL 1.1 — xem fonts/NOTICE.md) mã hoá base64.\n"
        "//\n"
        "// Font được lưu dạng base64 thay vì tệp .ttf rời để quy trình đẩy mã qua\n"
        "// GitHub API (chỉ nhận tệp văn bản UTF-8) không làm hỏng dữ liệu nhị phân.\n"
        "// Tái tạo bằng scripts/subset-font.py.\n"
        f"// Kích thước sau giải mã: {len(data)} byte.\n\n"
        'const pdfCraftSansTTFB64 = "" +\n'
        f"{lines}\n"
    )
    with open("go/pkg/pdfcraft/fontdata.go", "w", encoding="utf-8") as f:
        f.write(out)
    print(f"fontdata.go đã tái tạo — font giải mã {len(data)} byte")


if __name__ == "__main__":
    main()
