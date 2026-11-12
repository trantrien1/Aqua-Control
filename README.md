# Aqua Control — bể cá ESP32

Bản hiện tại **3.0**: nhiều khách hàng, mỗi khách có tài khoản riêng, nhiều bể,
mỗi bể có khoá thiết bị riêng và bot Telegram báo cho đúng chủ.

Đo nhiệt độ, pH, TDS và độ đục tương đối theo các mốc trong `firmware-v2`.
Điều khiển **bơm nước ra, bơm nước vào và đèn** theo thời gian; thay nước theo phần trăm
thể tích với lưu lượng mỗi bơm 96 lít/giờ. Chủ bể có thể chỉnh ngưỡng và bật tự thay nước
khi bất thường. Chế độ tự động mặc định tắt và phải được ESP32 xác nhận cấu hình.

**Hướng dẫn phiên bản điều khiển nước: [docs/water-control-v3.md](docs/water-control-v3.md)**
— sử dụng web, công thức, hiệu chuẩn giữ nguyên, nạp firmware và kiểm thử.

**Từ số 0 tới lúc chạy được: [HUONG_DAN_CHAY.md](HUONG_DAN_CHAY.md)** — cài đặt, biến
môi trường, tạo khách hàng, cấp thiết bị, nạp firmware, bật bot Telegram, sự cố thường gặp.

**Đưa cho người test: [HUONG_DAN_TRIEN_KHAI_VA_TEST.md](HUONG_DAN_TRIEN_KHAI_VA_TEST.md)**
— triển khai Docker/bare metal, lấy `DEVICE_ID`/`DEVICE_KEY`, điền gì vào firmware, tạo
bot Telegram, và checklist tick từng chức năng (web, bơm, cách ly khách, bot, phần cứng).

**Hướng dẫn kỹ thuật: [readmev2.md](readmev2.md)** — sơ đồ chân, cấu hình Wi-Fi,
nạp bằng Arduino IDE hoặc VS Code + PlatformIO, thử relay/hiệu chuẩn và xử lý lỗi.

| Relay | Chức năng | GPIO |
|---|---|---|
| IN1 | Bơm nước ra | 18 |
| IN2 | Bơm nước vào | 19 |
| IN3 | Đèn 6 V | 21 |
| IN4 | Dự phòng, giữ tắt | 22 |

Cảm biến giữ chân pH34, TDS32, độ đục35, DS18B20 27.
Hai bơm liên động, đèn độc lập; có giới hạn thời gian và test 3 giây.

## Nhiều khách hàng

| Vai trò | Làm được gì |
|---|---|
| Quản trị (`admin`) | Tạo/khoá/xoá tài khoản khách, cấp thiết bị, đổi khoá thiết bị, xem mọi bể |
| Khách hàng | Chỉ thấy bể của mình, điều khiển relay, xem lịch sử, liên kết Telegram riêng |

Tài khoản `admin` được tạo lần đầu từ `ADMIN_PASSWORD` trong `.env` (mặc định
`beca123`). **Đổi ngay sau lần đăng nhập đầu tiên.** Khách hàng do quản trị viên
tạo trong mục **Quản trị** trên web.

Mỗi thiết bị nhận một cặp `DEVICE_ID` + `DEVICE_KEY` khi được cấp. Khoá chỉ hiện
**một lần** — chép vào `AQUA_DEVICE_ID`/`AQUA_DEVICE_KEY` trong `firmware-v2/local-config.h`.
Mất khoá thì bấm "Đổi khoá" trong mục Quản trị rồi nạp lại firmware.

MQTT xác thực bằng chính hai giá trị đó: username = `DEVICE_ID`, password =
`DEVICE_KEY`. Broker chặn thiết bị này publish/subscribe sang topic của thiết bị khác.

## Thông báo Telegram

Bỏ `TELEGRAM_BOT_TOKEN` (lấy từ @BotFather) vào `.env`. Mỗi khách vào web bấm
**Liên kết Telegram**, nhận mã 8 ký tự, mở bot gửi `/start <mã>`. Từ đó bot chỉ
nhắn cho đúng người sở hữu bể: báo khi thông số vào vùng vàng hoặc đỏ, rồi nhắc
lại mỗi 30 phút (vàng) / 10 phút (đỏ) chừng nào còn xấu.
Lệnh trong bot: `/status`, `/tat [số phút]`, `/bat`, `/stop`, `/start <mã>`. Chi tiết ở [readmev2.md §7b](readmev2.md).

## Chạy

```powershell
npm.cmd ci --cache .npm-cache
npm.cmd start
```

Mở http://localhost:3000, đăng nhập `admin` / `beca123` (hoặc giá trị trong `.env`).
Server có broker MQTT nhúng cổng 1883. Máy tính và ESP32 phải liên lạc được trong LAN.

Firmware để nạp: `firmware-v2/aquarium-node.ino` (đã được chọn trong `platformio.ini`).
Kiểm tra SSID/mật khẩu Wi-Fi, IP LAN server và ID/key trong `firmware-v2/local-config.h` trước khi nạp.

### Docker

```powershell
docker compose up -d --build
```

Dữ liệu nằm trong volume `aquarium-data`. Bản demo có bộ giả lập ESP32:

```powershell
node tools/create-demo-device.mjs     # in ra DEVICE_ID và DEVICE_KEY
# điền hai giá trị đó vào .env rồi:
docker compose --profile demo up -d
```

### Thử không cần phần cứng

```powershell
node tools/create-demo-device.mjs
npm.cmd run sim -- --device <DEVICE_ID> --key <DEVICE_KEY> --scenario critical
```

## Kiểm thử

```powershell
npm.cmd test            # tích hợp: MQTT → SQLite → REST/SSE, migration, relay
npm.cmd run test:multi  # đa khách hàng: phân quyền, xác thực broker, cách ly dữ liệu
npm.cmd run test:telegram
npm.cmd run test:e2e    # cả đường dây tới Telegram (dùng Telegram giả)
npm.cmd run check:ui    # kiểm tra tĩnh giao diện: id DOM, CSS, route API
```

`npm test` và `npm run test:e2e` cần spawn tiến trình con — trên Windows phải chạy
với quyền đầy đủ, không bị sandbox chặn.

Giao thức chi tiết trong [docs/api.md](docs/api.md).
