# legacy/ — mã nguồn đã đóng băng

Thư mục này giữ các bản cài đặt cũ ở trạng thái **đóng băng**: không
phát triển tính năng mới, không sửa lỗi trừ khi ảnh hưởng an toàn dữ
liệu. Lý do và quyết định kiến trúc: xem `../ENGINEERING-ROADMAP.md`
(hợp nhất về Go hoàn toàn, 2026-11-27).

- `python/` — bản Python (pypdf) của PDF Craft, đầy đủ 17 lệnh, giữ làm
  tham chiếu lịch sử và đối chứng hành vi cho bản Go. Chạy được độc lập:
  `pip install .` ở thư mục gốc repo, hoặc
  `PYTHONPATH=legacy/python python -m pdfcraft ...`
