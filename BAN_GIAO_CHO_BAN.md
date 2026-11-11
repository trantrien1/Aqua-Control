# Bàn giao Aqua Control 2.2

Đọc file này trước khi sửa giao diện hoặc đưa website lên Internet.
Đây là mã nguồn để bàn giao, chưa phải một website đã triển khai công khai.

## 1. Các file cần dùng

| Thư mục / file | Công việc |
|---|---|
| `public/index.html` | Bố cục dashboard |
| `public/styles.css` | Giao diện dashboard và đăng nhập |
| `public/assets/` | Ảnh minh họa WebP và font Be Vietnam Pro chạy cục bộ; gửi kèm toàn bộ thư mục |
| `docs/aqua-minimal.md` | Ghi chú giao diện Aqua Minimal và cách kiểm tra bản mới |
| `public/login.html` | Trang đăng nhập |
| `public/js/dashboard.js` | Render dữ liệu, điều khiển, trạng thái MQTT qua API/SSE |
| `public/js/chart.js` | Biểu đồ canvas |
| `public/js/api.js`, `format.js`, `login.js` | Gọi API, định dạng, đăng nhập |
| `server/` | Server Node.js/Express, API, xác thực, MQTT, SQLite, cảnh báo |
| `package.json`, `package-lock.json` | Thư viện và lệnh chạy, cần gửi cả hai |
| `.env.example` | Mẫu cấu hình; tự tạo `.env` của máy nhận |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Cách chạy bằng Docker nếu cần |
| `firmware/aquarium-node/` | Firmware ESP32 để đối chiếu giao thức và nạp khi đổi broker |
| `platformio.ini` | Build/nạp ESP32 bằng VS Code + PlatformIO |
| `tests/integration.test.js` | Kiểm thử luồng MQTT, API, SQLite, relay |
| `tools/simulate-device.js` | Giả lập ESP32 để làm giao diện khi không có phần cứng |
| `tools/ui-smoke.mjs` | Công cụ kiểm tra giao diện có sẵn, dùng Chrome/Edge |
| `docs/api.md` | Hợp đồng API/MQTT cần giữ khi sửa giao diện |
| `readmev2.md` | Hướng dẫn phần cứng, hiệu chuẩn, chạy và test |
| `docs/screenshots/` (trong ZIP) | Ảnh tham khảo giao diện với dữ liệu giả lập |
| `MANIFEST.sha256` (trong ZIP) | Danh sách SHA-256 để đối chiếu các file bàn giao |

ZIP không chứa `.env`, database, khóa phiên, thư viện đã cài, cache, build firmware
hay cấu hình VS Code của máy gửi. Thông tin Wi-Fi/tài khoản MQTT trong **bản firmware
đóng gói** được thay bằng giá trị mẫu. Không nạp firmware mẫu trước khi cấu hình lại.
Database và khóa phiên sẽ được server tự tạo trên máy nhận.

## 2. Chạy thử giao diện ngay trên máy bạn

Giải nén, mở thư mục `Aqua-Control` (chứa package.json). Dùng Node.js 24
(bản đã kiểm thử ở máy gửi: 24.14.1).

PowerShell, terminal 1:

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd start
```

Chỉ sao chép `.env.example` khi chưa có `.env`. Mở http://localhost:3000,
đăng nhập mặc định `beca123` khi chưa đổi ADMIN_PASSWORD.

Terminal 2:

```powershell
npm.cmd run sim
```

Simulator mặc định gửi bốn cảm biến và hỗ trợ hai bơm pH + đèn.
Trên Linux/macOS dùng `npm` thay `npm.cmd`.

Kiểm tra sau khi chỉnh:

```powershell
npm.cmd test
```

Dừng simulator trước khi kết nối ESP32 thật với cùng DEVICE_ID.
Dữ liệu demo ghi vào database của server đang chạy; dùng DB_PATH riêng nếu cần tách.

## 3. Giữ đúng hợp đồng phần cứng khi sửa giao diện

| Key điều khiển | Relay | GPIO | Giới hạn |
|---|---|---|---|
| `ph_up` — bơm tăng pH | IN1 | 18 | 120 giây |
| `ph_down` — bơm hạ pH | IN2 | 19 | 120 giây |
| `light` — đèn 6 V | IN3 | 21 | 3600 giây |

IN4/GPIO22 dự phòng, luôn tắt. Không còn chức năng `drain`.
Tên trường/endpoint `pumps` được giữ để tương thích, dù có cả đèn bên trong.

- Bật/tắt: `POST /api/pumps/:key`, body `{"action":"on","seconds":3}` hoặc `{"action":"off"}`.
- Tắt cả ba: `POST /api/relays/stop-all`.
- Số đo/trạng thái: `GET /api/state`; cập nhật thời gian thực: `GET /api/stream` qua SSE.
- Không báo tải đã bật ngay khi HTTP trả thành công: phải chờ `confirmed`/state/ACK.
- Hai bơm pH loại trừ nhau; đèn độc lập. Mỗi lệnh bật có hẹn giờ, mặc định 3 giây.
- Độ đục hiện là `turbidity_voltage`, đơn vị **V**, chưa có phép hiệu chuẩn NTU.
- pH chưa hiệu chuẩn hoặc cảm biến lỗi dùng `null`; không đổi `null` thành 0.
- Giữ capability `relay_keys`, giới hạn thời gian, trạng thái offline và phản hồi lỗi.

Chi tiết payload trong `docs/api.md`. Backend/firmware đã có các chốt an toàn;
giao diện không được thay thế việc kiểm tra quyền điều khiển ở server.

## 4. Cho mọi người xem: cần phân biệt xem và điều khiển

**Bản hiện tại chỉ có một loại tài khoản quản trị. Ai có mật khẩu đăng nhập cũng
có quyền gửi lệnh bơm/đèn. Chưa có tài khoản viewer hoặc trang công khai chỉ xem.**

Nếu mục tiêu là mọi người xem số liệu, công việc tiếp theo của bên nhận là làm
trang/quyền **chỉ xem**, chỉ trả dữ liệu cần công khai. Các endpoint điều khiển,
nhất là `/api/pumps/:key` và `/api/relays/stop-all`, phải tiếp tục yêu cầu quyền admin
ở server. Chỉ ẩn nút trong giao diện không tạo ra quyền chỉ xem.

Các bước này chưa được thực hiện trong gói bàn giao; không chia sẻ mật khẩu admin
như một tài khoản xem chung.

## 5. Hai cách bố trí server

### A. Giữ Node.js và MQTT ở máy gần ESP32

```text
ESP32 -- MQTT nội bộ --> Máy tại nhà chạy Node.js + SQLite
                                      |
                              HTTPS/tunnel ổn định
                                      |
                              Người xem Internet
```

Máy tại nhà phải hoạt động liên tục. Đưa cổng HTTP của server ra ngoài qua một
dịch vụ tunnel có hostname ổn định và hỗ trợ SSE. MQTT 1883 có thể giữ trong LAN;
ESP32 vẫn trỏ tới IP LAN của máy tại nhà, không cần đổi broker chỉ để công khai web.

Nếu chọn Cloudflare, dùng tunnel cấu hình đầy đủ và kiểm tra SSE; **Quick Tunnel
trycloudflare không hỗ trợ SSE** theo tài liệu chính thức, nên không dùng nó làm
giải pháp cập nhật thời gian thực cho dự án này.

### B. Chuyển Node.js lên VPS / máy chủ luôn chạy

- Chọn môi trường chạy được tiến trình Node.js lâu dài, có ổ đĩa lưu SQLite và SSE.
  Chỉ upload thư mục public lên static hosting sẽ không chạy được server/MQTT.
- Chạy một instance với database hiện tại; lưu `data/` hoặc DB_PATH ở ổ đĩa bền vững.
- Dùng HTTPS/reverse proxy trước Node.js, có cơ chế tự khởi động lại tiến trình.
- Thiết kế lại đường MQTT từ ESP32 tới server: IP LAN `192.168.x.x` của máy cũ
  không truy cập được từ VPS. Có thể giữ broker ở LAN và dùng kết nối mạng riêng/bridge,
  hoặc chuyển broker ra ngoài rồi cập nhật firmware/cấu hình.
- Firmware hiện dùng `WiFiClient` và MQTT TCP, chưa dùng `WiFiClientSecure`/TLS.
  Không chỉ đổi cổng thành 8883 rồi coi là đã có TLS; nếu dùng broker Internet TLS,
  cần bổ sung client TLS, xác minh chứng chỉ và thông tin xác thực phù hợp.
- Broker nhúng dùng chung HOST với HTTP; cần chọn địa chỉ bind/firewall theo
  thiết kế mạng. Không tự công khai cổng MQTT 1883 khi chỉ cần chia sẻ trang web.

Ví dụ Caddy trên **cùng VPS với Node.js**, sau khi đã có domain trỏ đúng VPS:

```caddyfile
aquarium.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Đây là mẫu để bên nhận điều chỉnh, chưa có domain thật hoặc triển khai sẵn.
Đảm bảo `/api/stream` không bị proxy giữ buffer/cache, cookie đăng nhập hoạt động
qua HTTPS và kiểm tra cấu hình trusted proxy/rate limit trước khi mở công khai.
Code hiện đặt `trust proxy=false`; chỉ cấu hình proxy tin cậy đúng topology thực tế.

## 6. Cấu hình cần tự điền khi triển khai

- `.env`: ADMIN_PASSWORD riêng; SESSION_SECRET ổn định; HOST/PORT, DEVICE_ID,
  DB_PATH/volume và MQTT theo vị trí server.
- Nếu bật MQTT_USERNAME/MQTT_PASSWORD, cấu hình đồng bộ server, ESP32, simulator.
  Khi dùng Docker Compose, các biến này cần được truyền vào container; file Compose
  hiện chưa truyền sẵn mọi biến tùy chọn của `.env`.
- Firmware mẫu: điền WIFI_SSID, WIFI_PASSWORD, MQTT_HOST; cấu hình user/password
  MQTT nếu dùng; DEVICE_ID và topic phải trùng server.
- Giữ cấu hình thật/khóa phiên ngoài Git, sao lưu database ở nơi triển khai.

## 7. Tiêu chí bàn giao bản web công khai

1. Người ngoài LAN mở được URL HTTPS và xem được số liệu thật.
2. Dữ liệu tự cập nhật qua SSE; mất mạng và kết nối lại hiển thị đúng.
3. Người xem không có quyền điều khiển qua cả giao diện lẫn gọi API trực tiếp.
4. Admin vẫn thử được ba relay, liên động pH và tự tắt theo thời gian.
5. Restart server giữ được lịch sử; ESP32 kết nối lại đúng broker.
6. Chạy `npm test`, kiểm tra desktop/mobile, thử lại với mạch thật.

Nguồn cấu hình triển khai, kiểm tra ngày 10/11/2026:

- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/).
- [Giới hạn Quick Tunnels, gồm SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
- [Caddy reverse_proxy và streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- [HTTPS của Caddy](https://caddyserver.com/docs/automatic-https).
