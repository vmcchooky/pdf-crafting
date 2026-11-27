# Font nhúng: PDFCraftSans

> Dữ liệu font nằm ở `../fontdata.go` (base64, tái tạo bằng
> `scripts/subset-font.py`) — giải mã ra là tệp PDFCraftSans.ttf dưới đây.

- **Nguồn**: subset từ **Noto Sans Regular** (dự án Google Noto).
- **Giấy phép**: SIL Open Font License 1.1 (https://openfontlicense.org).
- **Thay đổi so với bản gốc**: subset chỉ giữ Latin, Latin Extended,
  Latin Extended Additional và dấu tổ hợp (đủ cho tiếng Việt, ~39 KB);
  đổi tên family thành **PDFCraftSans** theo yêu cầu của OFL đối với
  bản sửa đổi; bỏ hinting.
- Font chỉ được nhúng trong tệp thực thi PDF Craft để vẽ watermark
  Unicode; không phân phối như một sản phẩm font độc lập.
