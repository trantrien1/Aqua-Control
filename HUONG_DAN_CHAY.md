# Hướng dẫn chạy — Aqua Control 3.0

> **Cập nhật điều khiển nước:** firmware hiện tại là `firmware-v2/`, hai kênh IN1/IN2
> đã đổi thành **rút nước / bơm vào**. Có thể chỉnh thể tích, ngưỡng và bật tự thay nước.
> Xem [hướng dẫn mới đầy đủ](docs/water-control-v3.md) cho điều khiển, an toàn và nạp ESP32.
> Các đoạn bơm pH, giới hạn 120 giây và “không có tự động” bên dưới thuộc bản cũ.
> Cách cài máy chủ, quản trị tài khoản và liên kết Telegram vẫn áp dụng.

Tài liệu này hướng dẫn từ số 0 tới lúc hệ thống chạy được: cài đặt, đăng nhập, cấp thiết bị cho từng khách hàng, nạp firmware ESP32, bật bot Telegram và chạy kiểm thử.

Mô hình 3.0: **một máy chủ phục vụ nhiều khách hàng**. Quản trị viên tạo tài khoản khách, cấp cho mỗi khách một `DEVICE_ID` + `DEVICE_KEY`. Mỗi khách tự liên kết tài khoản Telegram của mình để nhận cảnh báo riêng.

---

## 1. Yêu cầu

| Cách chạy | Cần gì |
|---|---|
| Trực tiếp bằng Node | Node.js **≥ 22.5** (bắt buộc, vì dùng `node:sqlite` có sẵn trong Node) |
| Docker | Docker Engine + Docker Compose (không cần cài Node trên máy) |

Không cần cài Mosquitto hay broker MQTT ngoài — broker `aedes` được nhúng sẵn trong tiến trình Node.

---

## 2. Chạy nhanh (Node)

```powershell
cd "D:\Deepseek Workspace\Trường\IOT"
npm.cmd ci                 # cài phụ thuộc
Copy-Item .env.example .env
npm.cmd start
```

Mở **http://localhost:3000** → trang đăng nhập.

Tài khoản quản trị mặc định:

```
admin / beca123
```

> Đổi mật khẩu này ngay bằng biến `ADMIN_PASSWORD` trong `.env` **trước lần chạy đầu tiên** (tài khoản `admin` được tạo tự động ở lần khởi động đầu và không ghi đè mật khẩu bạn đã đổi sau đó).

Dừng máy chủ: `Ctrl + C`.

---

## 3. Biến môi trường (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng giao diện web |
| `MQTT_PORT` | `1883` | Cổng broker MQTT nhúng (ESP32 kết nối vào đây) |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe |
| `ADMIN_PASSWORD` | `beca123` | Mật khẩu admin tạo ở lần chạy đầu |
| `SESSION_SECRET` | tự sinh | Khoá ký cookie phiên; tự sinh và lưu vào `data/.session-secret` nếu bỏ trống |
| `SESSION_TTL_SECONDS` | `604800` | Hạn phiên đăng nhập (7 ngày) |
| `MQTT_TOPIC_PREFIX` | `aquarium` | Tiền tố topic |
| `STALE_AFTER_SECONDS` | `60` | Sau bao lâu không nhận dữ liệu thì coi thiết bị là mất kết nối |
| `COMMAND_ACK_TIMEOUT_MS` | `8000` | Chờ thiết bị xác nhận lệnh bơm |
| `ALERT_COOLDOWN_SECONDS` | `180` | Thời gian chờ chống spam cảnh báo |
| `RETENTION_DAYS` | `30` | Số ngày giữ dữ liệu |
| `DB_PATH` | `data/aquarium.db` | File SQLite |
| `EMBEDDED_BROKER` | `true` | `false` = dùng broker MQTT ngoài qua `MQTT_URL` |
| `TELEGRAM_BOT_TOKEN` | *(trống)* | Token bot lấy từ @BotFather |
| `TELEGRAM_NOTIFY_LEVEL` | `warn` | `warn` = báo cả vùng vàng, `critical` = chỉ vùng đỏ |
| `TELEGRAM_REPEAT_WARN_MINUTES` | `30` | Nhắc lại mức vàng mỗi bao nhiêu phút khi vẫn còn xấu |
| `TELEGRAM_REPEAT_CRITICAL_MINUTES` | `10` | Nhắc lại mức đỏ mỗi bao nhiêu phút khi vẫn còn xấu |
| `PUBLIC_URL` | `http://localhost:3000` | Địa chỉ gắn vào tin nhắn Telegram (dùng IP LAN nếu xem từ điện thoại) |
| `MQTT_SERVER_USERNAME` / `MQTT_SERVER_PASSWORD` | `server-<pid>` / `SESSION_SECRET` | Tài khoản nội bộ của máy chủ khi nối vào broker |

`TELEGRAM_CHAT_ID` **không còn tồn tại** ở bản 3.0 — mỗi khách tự liên kết (xem mục 7).

---

## 4. Tạo khách hàng và cấp thiết bị

1. Đăng nhập bằng `admin`.
2. Kéo xuống mục **Quản trị**.
3. **Bảng khách hàng** → *Thêm tài khoản* → nhập tên đăng nhập (3–32 ký tự, chỉ chữ/số và `. _ -`) + mật khẩu → **Lưu**.
   Có thể *Đổi mật khẩu*, *Khoá* / *Mở khoá*, *Xoá*. Không thể tự khoá hoặc xoá chính tài khoản admin.
4. **Bảng thiết bị** → *Cấp thiết bị* → chọn chủ sở hữu + đặt tên bể → **Lưu**.
5. Hộp **thông tin thiết bị** hiện ra `DEVICE_ID` và `DEVICE_KEY`.

> **Khoá chỉ hiển thị một lần.** Chép ngay `DEVICE_ID` và `DEVICE_KEY` để nạp vào ESP32. Máy chủ chỉ lưu `sha256` của khoá nên không xem lại được — nếu mất, dùng nút **Đổi khoá** để phát khoá mới (thiết bị phải nạp lại khoá mới).

Mỗi khách đăng nhập chỉ thấy đúng những bể thuộc tài khoản mình. Truy cập bể của người khác trả về **404** (không tiết lộ bể đó có tồn tại hay không).

---

## 5. Thử không cần phần cứng

Có sẵn công cụ dựng một tài khoản demo kèm thiết bị:

```powershell
node tools/create-demo-device.mjs
```

In ra:

```
Tài khoản : demo / demo123456
DEVICE_ID : esp32-xxxxxx
DEVICE_KEY: xxxxxxxxxxxxxxxxxxxxxxxx
```

Rồi chạy máy giả lập ESP32 ở cửa sổ thứ hai:

```powershell
npm.cmd run sim -- --device esp32-xxxxxx --key <DEVICE_KEY> --scenario critical
```

Các kịch bản: `normal`, `critical`, `low`, `drift`, `water-test`, `relay-test`. Thêm `--once` để gửi một gói rồi thoát, `--interval 3000` để đổi nhịp gửi.

Máy giả lập còn phản ứng ngược lại với lệnh bơm (bật bơm hạ pH thì số đo pH giảm dần) nên bấm nút trên web sẽ thấy số liệu đổi theo.

---

## 6. Nạp firmware cho ESP32 thật

Mở `firmware/aquarium-node/aquarium-node.ino`, sửa các hằng ở đầu file:

```cpp
static const char *WIFI_SSID         = "TEN_WIFI_CUA_BAN";
static const char *WIFI_PASSWORD     = "MAT_KHAU_WIFI_CUA_BAN";
static const char *MQTT_HOST         = "192.168.1.10";   // IP máy tính chạy server
static const uint16_t MQTT_PORT      = 1883;
static const char *DEVICE_ID         = "esp32-xxxxxx";   // lấy từ mục Quản trị
static const char *DEVICE_KEY        = "DAN_KHOA_THIET_BI_VAO_DAY";
```

- `MQTT_HOST` phải là **IP LAN** của máy chạy server (máy chủ in ra danh sách IP khi khởi động), không dùng `localhost`.
- `DEVICE_ID` / `DEVICE_KEY` chính là tài khoản MQTT của thiết bị. Sai khoá → broker từ chối kết nối.
- Nạp bằng PlatformIO (`platformio.ini` có sẵn trong repo) hoặc Arduino IDE với các thư viện trong `readmev2.md` §4.

Chân phần cứng: relay IN1 = GPIO 18 (bơm nâng pH), IN2 = GPIO 19 (bơm hạ pH), IN3 = GPIO 21 (đèn 6V).

---

## 7. Bật bot Telegram

Bot **không chạy riêng** — nó nằm trong tiến trình server, dùng long-polling `getUpdates`. Chỉ cần cấu hình token rồi chạy server như bình thường.

### 7.1. Tạo bot (một lần, cho cả hệ thống)

1. Mở Telegram, tìm **@BotFather**.
2. Gửi `/newbot`, đặt tên và username cho bot.
3. BotFather trả về token dạng `123456789:AAE...`.

### 7.2. Cấu hình

Thêm vào `.env`:

```ini
TELEGRAM_BOT_TOKEN=123456789:AAE...
TELEGRAM_NOTIFY_LEVEL=warn
PUBLIC_URL=http://192.168.1.10:3000
```

Khởi động lại server. Log phải hiện:

```
[telegram] Đã bật, mức thông báo: critical.
[telegram] Bot @ten_bot_cua_ban đã sẵn sàng.
```

Nếu thấy `[telegram] Bỏ qua: chưa có TELEGRAM_BOT_TOKEN.` thì token chưa được đọc — kiểm tra lại `.env`.

### 7.3. Từng khách tự liên kết

1. Khách đăng nhập web → thẻ **Thông báo Telegram** → bấm **Liên kết Telegram**.
2. Web hiện mã 8 ký tự, hạn 15 phút.
3. Trong Telegram, mở bot và gửi `/start <mã>`.
4. Bot trả lời xác nhận và liệt kê các bể của tài khoản đó.
5. Bấm **Gửi thử** trên web để chắc chắn đường đi thông.

Lệnh trong bot:

| Lệnh | Tác dụng |
|---|---|
| `/start <mã>` | Liên kết tài khoản Telegram với tài khoản web |
| `/status` | Xem tình trạng các bể của mình |
| `/tat [số phút]` | Tạm tắt thông báo; gõ trống thì hiện nút 30 phút / 1 giờ / 2 giờ / đến khi bật lại / tuỳ chỉnh |
| `/bat` | Bật lại thông báo |
| `/stop` | Ngắt liên kết, thôi nhận tin |

### 7.4. Cách bot báo

- Mức vàng và mức đỏ đều được báo (`TELEGRAM_NOTIFY_LEVEL=warn`). Đặt `critical` thì chỉ báo mức đỏ.
- Báo khi thông số **chuyển** vào vùng xấu, rồi **nhắc lại** mỗi 30 phút (vàng) / 10 phút (đỏ) chừng nào còn xấu — đổi bằng `TELEGRAM_REPEAT_WARN_MINUTES`, `TELEGRAM_REPEAT_CRITICAL_MINUTES`. Phải ra khỏi vùng xấu rồi rơi lại mới tính là tin mới (và được báo ngay).
- Vàng chuyển sang đỏ thì báo ngay, không chờ hết chu kỳ.
- Mỗi tin đều kèm nút tắt thông báo nhanh; muốn im hẳn thì `/tat` hoặc `/stop`.
- Trạng thái theo dõi tách theo từng cặp *thiết bị + chat id*, nên hai khách có bể cùng lỗi vẫn nhận tin riêng, không lẫn.
- Bot **không bao giờ tự bật bơm**. Máy bơm chỉ chạy khi người dùng bấm trên web.

---

## 8. Chạy bằng Docker

```powershell
cd "D:\Deepseek Workspace\Trường\IOT"
docker compose up -d --build
```

Dịch vụ chính mở cổng `3000` (web) và `1883` (MQTT), dữ liệu lưu trong volume `aquarium-data`.

Kèm máy giả lập (chỉ dùng để demo):

```powershell
node tools/create-demo-device.mjs      # rồi điền DEVICE_ID / DEVICE_KEY vào .env
docker compose --profile demo up -d
```

Xem log: `docker compose logs -f aquarium` · Dừng: `docker compose down`

> ESP32 thật kết nối vào cổng `1883` của máy chạy Docker, nên phải đảm bảo cổng đó không bị tường lửa chặn.

---

## 9. Kiểm thử

```powershell
npm.cmd test          # tích hợp: MQTT → SQLite → REST/SSE (cần chạy được tiến trình con)
npm.cmd run test:multi   # 29 bài: tài khoản, phiên, cấp thiết bị, cách ly, xác thực MQTT
npm.cmd run test:telegram # logic chống spam cảnh báo
npm.cmd run test:e2e     # dựng Telegram giả, 2 khách 2 bể
npm.cmd run check:ui     # kiểm tra tĩnh giao diện (không cần trình duyệt)
```

`npm test` và `test:e2e` cần quyền mở tiến trình con; nếu chạy trong môi trường bị hạn chế quyền, hãy dùng ba lệnh còn lại.

---

## 10. Sự cố thường gặp

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Web hiện "Tài khoản chưa được cấp thiết bị nào." | Tài khoản khách chưa được gán bể — vào mục Quản trị để cấp, hoặc gán lại chủ sở hữu |
| Thiết bị hiện **mất kết nối** dù ESP32 vẫn chạy | Sai `DEVICE_KEY`, sai `MQTT_HOST`, hoặc tường lửa chặn cổng `1883`. Xem log server |
| Bấm nút bơm báo **409** | Thiết bị đang offline — máy chủ từ chối gửi lệnh để tránh bơm chạy mãi |
| Bot không nhắn tin | Chưa đặt `TELEGRAM_BOT_TOKEN`, khách chưa liên kết, thông số chưa vào vùng vàng/đỏ, hoặc khách đang `/tat`. Đặt `TELEGRAM_NOTIFY_LEVEL=warn` để báo cả mức vàng |
| Nhắn `/start <mã>` báo mã sai | Mã hết hạn sau 15 phút — bấm **Liên kết Telegram** lại để lấy mã mới |
| Không tìm thấy khoá thiết bị nữa | Khoá chỉ hiện một lần. Dùng **Đổi khoá** trong mục Quản trị rồi nạp lại vào ESP32 |
| Bơm tự tắt sau một lúc | Đúng thiết kế: máy chủ có chốt an toàn tự ngắt sau số giây tối đa của từng bơm (nâng/hạ pH 120s, đèn 3600s) |

---

## 11. An toàn — những điều cần biết

- **Không có chế độ tự động.** Không có luật nào tự bật bơm theo ngưỡng. Máy chủ chỉ gợi ý bơm nào nên chạy, người dùng quyết định.
- Chốt an toàn duy nhất máy chủ tự làm là **ngắt bơm sau `maxRunSeconds`** và **tắt bơm cùng nhóm** khi bật bơm ngược lại (nâng pH và hạ pH không bao giờ chạy đồng thời).
- Thiết bị offline thì máy chủ **từ chối gửi lệnh** (409) thay vì xếp hàng đợi.
- Lệnh bơm không được lưu giữ (không retain) nên thiết bị kết nối lại sẽ không phát lại lệnh cũ.
- ESP32 giữ toàn bộ ngưỡng an toàn cục bộ, nên bể vẫn được bảo vệ khi mất WiFi.

---

## 12. Bàn giao cho người test

Nếu bạn đưa dự án cho người khác test (cắm dây ESP32 thật, thử từng chức năng), dùng
[HUONG_DAN_TRIEN_KHAI_VA_TEST.md](HUONG_DAN_TRIEN_KHAI_VA_TEST.md): có bản Docker/bare metal,
chỗ điền `DEVICE_ID`/`DEVICE_KEY` vào firmware, cách tạo bot Telegram, và checklist tick
từng chức năng kèm bảng sự cố.
