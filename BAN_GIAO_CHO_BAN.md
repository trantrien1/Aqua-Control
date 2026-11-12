# Bàn giao Aqua Control 3.0 — nhiều khách hàng

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
đăng nhập **admin** / `beca123` khi chưa đổi ADMIN_PASSWORD. Vào mục **Quản trị**
để tạo tài khoản khách và cấp thiết bị; mỗi thiết bị trả về `DEVICE_ID` + `DEVICE_KEY`
đúng một lần để nạp vào firmware.

Chưa muốn mở web, có thể tạo nhanh tài khoản + thiết bị bằng lệnh:

```powershell
npm.cmd run demo-device
```

Terminal 2 (thay hai giá trị lệnh trên in ra):

```powershell
npm.cmd run sim -- --device <DEVICE_ID> --key <DEVICE_KEY>
```

Simulator mặc định gửi bốn cảm biến và hỗ trợ hai bơm pH + đèn.
Trên Linux/macOS dùng `npm` thay `npm.cmd`.

Kiểm tra sau khi chỉnh:

```powershell
npm.cmd test             # tích hợp MQTT → SQLite → REST/SSE
npm.cmd run test:multi   # đa khách hàng, xác thực broker, cách ly dữ liệu
npm.cmd run test:e2e     # cả đường dây tới Telegram (Telegram giả lập)
npm.cmd run check:ui     # kiểm tra tĩnh id DOM / CSS / route API
```

`npm test` và `npm run test:e2e` cần spawn tiến trình con: trên Windows phải chạy
ở terminal thường, không bị sandbox chặn.

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

- Bật/tắt: `POST /api/devices/:deviceId/pumps/:key`, body `{"action":"on","seconds":3}` hoặc `{"action":"off"}`.
- Tắt cả ba: `POST /api/devices/:deviceId/relays/stop-all`.
- Số đo/trạng thái: `GET /api/state?device=<id>`; cập nhật thời gian thực: `GET /api/stream?device=<id>` qua SSE. Bỏ trống `device` thì dùng bể đầu tiên của tài khoản.
- Không báo tải đã bật ngay khi HTTP trả thành công: phải chờ `confirmed`/state/ACK.
- Hai bơm pH loại trừ nhau; đèn độc lập. Mỗi lệnh bật có hẹn giờ, mặc định 3 giây.
- Độ đục hiện là `turbidity_voltage`, đơn vị **V**, chưa có phép hiệu chuẩn NTU.
- pH chưa hiệu chuẩn hoặc cảm biến lỗi dùng `null`; không đổi `null` thành 0.
- Giữ capability `relay_keys`, giới hạn thời gian, trạng thái offline và phản hồi lỗi.

Chi tiết payload trong `docs/api.md`. Backend/firmware đã có các chốt an toàn;
giao diện không được thay thế việc kiểm tra quyền điều khiển ở server.

## 4. Phân quyền hiện có

Hai vai trò, đều kiểm tra ở server chứ không chỉ ẩn nút:

| Vai trò | Quyền |
|---|---|
| `admin` | Toàn quyền: tạo/khoá/xoá khách, cấp và đổi khoá thiết bị, xem và điều khiển mọi bể |
| `customer` | Chỉ bể của mình: xem, điều khiển relay, liên kết Telegram riêng |
| chưa đăng nhập | Chỉ `/api/health` |

Không có mức "chỉ xem". Nếu cần cho người ngoài xem số liệu mà không điều khiển được,
việc tiếp theo là thêm vai trò `viewer` (hoặc trang công khai chỉ trả dữ liệu đã lọc):
mở các route `GET` cho `requireRole('viewer','admin')` và giữ nguyên kiểm tra chủ sở hữu
ở `POST /api/devices/:deviceId/pumps/:key`, `POST /api/devices/:deviceId/relays/stop-all`.
Chỉ ẩn nút trong giao diện không tạo ra quyền chỉ xem — endpoint vẫn gọi được bằng curl.

Cách ly dữ liệu dựa trên `devices.owner_id`: mọi route có thiết bị đi qua
`resolveDevice(req, res)` và trả **404** khi thiết bị không thuộc tài khoản (không phải
403), để không lộ sự tồn tại của bể người khác. Thiết bị MQTT xác thực bằng cặp
`DEVICE_ID`/`DEVICE_KEY`; broker chặn publish/subscribe ra ngoài topic của chính nó.

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

- `.env`: ADMIN_PASSWORD riêng; SESSION_SECRET ổn định; HOST/PORT,
  DB_PATH/volume và MQTT theo vị trí server.
- Thiết bị **không** còn trong `.env`: quản trị viên cấp trên web, mỗi thiết bị có
  `DEVICE_ID` + `DEVICE_KEY` riêng. Khoá chỉ lưu dạng sha256 trong DB và chỉ hiện
  một lần lúc cấp/đổi. Chép vào firmware rồi nạp.
- `TELEGRAM_BOT_TOKEN` đặt một lần cho cả hệ thống. **Không** có `TELEGRAM_CHAT_ID`:
  mỗi khách tự bấm "Liên kết Telegram" trên web và gửi `/start <mã>` cho bot.
- Nếu đặt `MQTT_SERVER_USERNAME`/`MQTT_SERVER_PASSWORD`, phải khớp giữa server và
  broker ngoài (nếu dùng). Thiết bị luôn dùng xác thực riêng theo cặp ID/khoá.
  Docker Compose hiện chưa truyền sẵn mọi biến tuỳ chọn của `.env`.
- Firmware mẫu: điền `WIFI_SSID`, `WIFI_PASSWORD`, `MQTT_HOST`, `DEVICE_ID`,
  `DEVICE_KEY`; `TOPIC_PREFIX` phải trùng server.
- Giữ cấu hình thật/khóa phiên ngoài Git, sao lưu database ở nơi triển khai.

## 7. Tiêu chí bàn giao bản web công khai

1. Người ngoài LAN mở được URL HTTPS và xem được số liệu thật.
2. Dữ liệu tự cập nhật qua SSE; mất mạng và kết nối lại hiển thị đúng.
3. Khách A không xem/điều khiển được bể của khách B (kể cả gọi API trực tiếp).
4. Hai bơm pH liên động, tự tắt theo hẹn giờ, đèn độc lập.
5. Restart server giữ được lịch sử; ESP32 kết nối lại đúng broker bằng khoá của nó.
6. Bot Telegram chỉ nhắn cho chủ bể, không nhắn lặp khi thông số còn trong vùng đỏ.
7. Chạy `npm test`, `npm run test:multi`, `npm run check:ui`, kiểm tra desktop/mobile,
   thử lại với mạch thật.

Nguồn cấu hình triển khai, kiểm tra ngày 10/11/2026:

- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/).
- [Giới hạn Quick Tunnels, gồm SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
- [Caddy reverse_proxy và streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- [HTTPS của Caddy](https://caddyserver.com/docs/automatic-https).
