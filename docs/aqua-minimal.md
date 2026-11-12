# Aqua Minimal

Giao diện Aqua Control được thiết kế lại ngày 11/11/2026, giữ nguyên backend,
API, MQTT, SQLite, xác thực và firmware. Không thêm thư viện frontend.

Bản tinh gọn bỏ slogan, mô tả dưới tiêu đề và lời giải thích lặp trên card.
Chú thích cảm biến mở qua “Chi tiết”/“Ước tính”; cảnh báo chỉ xuất hiện khi có
vấn đề hoặc số đo cũ. Thông tin liên động, giới hạn và xác nhận thiết bị được giữ.

## Giao diện và tài nguyên

- Bảng màu theo yêu cầu: nền `#F3F8F8`, card trắng, xanh ngọc `#0F766E`,
  xanh biển `#0369A1`, chữ `#15343B`, chữ phụ `#526970`, viền `#DCE8E8`.
- Font Be Vietnam Pro đặt tại `public/assets/fonts/`, có đủ dấu tiếng Việt.
  Giữ kèm giấy phép `OFL.txt`. Font và ảnh chạy cục bộ, tương thích CSP hiện tại.
- `public/assets/aquarium.webp`: ảnh bể thủy sinh chính và trang đăng nhập.
- `neon-tetras.webp`, `aquatic-plants.webp`: thư viện ảnh, cây
  thủy sinh trên thanh bên và hình minh họa chăm sóc. Ảnh tải lười khi phù hợp.
- Tất cả hình bể/cá là ảnh minh họa được tạo bằng ImageGen, không phải camera
  hay ảnh thiết bị thật. Thư viện có thể mở ảnh lớn bằng chuột hoặc bàn phím.
- Mobile ưu tiên cảnh báo → cảm biến → điều khiển → biểu đồ; khu ảnh đặt sau
  các tác vụ chính. Có thể mở các tab biểu đồ bằng phím mũi tên, Home và End.

## Hiển thị đúng khả năng hệ thống

- Thẻ cảm biến lấy từ `state.params`, nên chỉ hiện mực nước khi thiết
  bị khai báo capability tương ứng. Bản firmware hiện tại có bốn cảm biến.
- Ngưỡng và trạng thái lấy từ API. Độ đục điện áp giữ đơn vị V, không đổi sang
  NTU. Giá trị `null` hiện `—`, không thay bằng số 0.
- Xu hướng nhỏ lấy từ API lịch sử 1 giờ và telemetry thật. Khi thiếu mẫu,
  hiển thị “Chưa đủ dữ liệu”, không tạo số liệu minh họa.
- Thủ công là chế độ hiện tại. Tự động được ghi rõ chưa hỗ trợ; không có nút
  bật tự động giả. Chưa thêm chức năng cho ăn, camera hay nhiều bể.
- Sau HTTP thành công, relay vẫn hiển thị trạng thái đã xác nhận gần nhất.
  Lệnh đang gửi/chờ ESP32 xác nhận có dòng thông báo riêng. Chỉ state/ACK từ
  thiết bị mới đổi trạng thái thực tế. Giữ hẹn giờ, liên động pH, tắt tất cả,
  giới hạn thời gian, khả năng firmware và thông báo lỗi.
- Tuổi số đo dùng `readingAgeMs` và `device.staleAfterMs` từ server, cộng thời
  gian trôi tại trình duyệt. Heartbeat không làm mới telemetry cũ. SSE mất
  kết nối hoặc thiết bị offline đều khóa điều khiển và làm rõ dữ liệu cũ.

## Kiểm tra

```powershell
npm.cmd ci
npm.cmd run demo-device   # tạo tài khoản + thiết bị, in DEVICE_ID/DEVICE_KEY
npm.cmd test              # tích hợp MQTT → SQLite → REST/SSE
npm.cmd run test:multi    # đa khách hàng + xác thực broker
npm.cmd run check:ui      # kiểm tra tĩnh id DOM / CSS / route API
npm.cmd start
```

Chạy simulator với cặp khoá vừa in ra nếu không có phần cứng:

```powershell
npm.cmd run sim -- --device <DEVICE_ID> --key <DEVICE_KEY>
```

Không chạy simulator trùng `DEVICE_ID` với ESP32 đang hoạt động.

```powershell
node tools/ui-smoke.mjs --base http://127.0.0.1:3000 --password MAT_KHAU --out .ui-smoke/aqua-minimal
```

`tools/ui-smoke.mjs` cần Chrome/Edge do nó điều khiển qua DevTools; trong môi trường
không mở được trình duyệt (sandbox, CI headless không có Chrome), dùng `npm run check:ui`
— script kiểm tra tĩnh: mọi id trong `dashboard.js` có trong `index.html`, không có
`style`/`script` nội tuyến (CSP), đủ lớp CSS mới, và mọi lời gọi trong `public/js/api.js`
đều có route tương ứng trong `server/api.js`.

Khi chạy được, công cụ kiểm tra đăng nhập, tab biểu đồ, ảnh/font cục bộ, lỗi
console/CSP, tràn ngang ở 320/390/768/1024/1440 px và thứ tự nội dung mobile.
Kết quả có ảnh desktop, mobile và trang đăng nhập.

Thêm `--verify-aqua` khi kiểm tra với simulator có relay. Chế độ này chèn fixture
chỉ trong trình duyệt kiểm thử và chặn POST điều khiển, không vận hành relay
thật. Nó kiểm tra lệnh chờ xác nhận, ACK, pH null, thiếu capability, dữ liệu cũ,
offline và kết nối lại SSE. Chế độ mặc định kiểm tra kết nối SSE thật.

Ảnh bản mới lưu tại `docs/screenshots/aqua-minimal-*.png`.

## Tham khảo thiết kế

Chuyển ý tưởng về bố cục, quản lý bể, cảm biến và điều khiển thành giao diện
riêng; không sao chép template thương mại hoặc sử dụng tài nguyên trả phí.

- [Aquaris](https://elements.envato.com/aquaris-aquarium-management-figma-dashboard-temp-TXCE2KV)
- [SmarTank, Andrew Baker](https://www.behance.net/gallery/112719539/SmarTank-UI-Design-for-Smart-Aquarium-Application)
- [Aquarium Control App, McKnight Media](https://dribbble.com/shots/22798146-UI-Challenge-Aquarium-Control-App)
- [IoT Sensor Dashboard](https://github.com/Serkanbyx/iot-dashboard)
