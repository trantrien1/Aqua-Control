# Triển khai & kiểm thử — tài liệu bàn giao cho người test

> **Checklist bản điều khiển nước:** xem [docs/water-control-v3.md](docs/water-control-v3.md).
> Bản hiện tại dùng `firmware/aquarium-node/`, bơm rút / bơm vào, thể tích bể, % thay nước,
> ngưỡng riêng và tự động khi được người dùng bật. Nội dung bơm pH, “không có tự động”,
> giới hạn bơm 120 giây và đường dẫn firmware cũ trong tài liệu dưới đây là của bản trước.
> Đăng nhập, phân quyền, cấp thiết bị và Telegram giữ nguyên; bổ sung `npm run test:water`
> và `npm run test:firmware` khi nghiệm thu phiên bản mới.

Tài liệu này dành cho người **trực tiếp cắm dây ESP32 và test**: dựng máy chủ (Docker
hoặc Node), lấy `DEVICE_ID`/`DEVICE_KEY`, nạp firmware, tạo bot Telegram, rồi test
từng chức năng theo checklist ở mục 6.

| Việc | Ai làm | Mục |
|---|---|---|
| Dựng máy chủ | quản trị | 1 (Docker) hoặc 2 (Node) |
| Tạo khách + cấp thiết bị → lấy ID/khoá | quản trị | 3 |
| Nạp firmware vào ESP32 | người có phần cứng | 4 |
| Tạo bot Telegram | quản trị | 5 |
| Test toàn bộ | cả hai | 6, 7 |

> **Nguyên tắc bất di bất dịch: không có tự động hoá.** Máy chủ không bao giờ tự bật
> bơm — mọi lệnh bơm đều do người bấm trên web. Các chốt an toàn (tự ngắt sau thời
> gian tối đa, ngắt khi mất MQTT) chỉ để **cắt**, không bao giờ để bật.

## 0. Cần có gì

- Máy chủ: **Node ≥ 22.5** (bản cài) **hoặc** Docker Desktop.
- ESP32 DevKit V1 + cáp USB **loại truyền dữ liệu**.
- Arduino IDE (hoặc PlatformIO) + 4 thư viện: `PubSubClient`, `ArduinoJson` ≥ 7, `OneWire`, `DallasTemperature`.
- Tải test: 2 bơm chìm 5 V, 1 đèn 6 V (hoặc LED), module relay 4 kênh mức thấp.
- ESP32 và máy chủ **cùng một mạng LAN**. Ghi lại IP LAN của máy chủ (`ipconfig`, dòng `IPv4`).

Chi tiết từng biến `.env`: xem [HUONG_DAN_CHAY.md mục 2](HUONG_DAN_CHAY.md).

## 1. Cách A — Docker (gọn nhất)

```powershell
git clone <link-repo> ; cd IOT
Copy-Item .env.example .env
# mở .env: đặt SESSION_SECRET, ADMIN_PASSWORD, PUBLIC_URL=http://<IP-LAN>:3000
docker compose up -d --build
docker compose logs -f aquarium      # Ctrl + C để thoát phần xem log
```

- Dashboard: `http://<IP-LAN>:3000` · MQTT cho ESP32: `<IP-LAN>:1883`
- Dữ liệu nằm trong volume `aquarium-data` (xoá sạch: `docker compose down -v`).
- Cập nhật code mới: `git pull` rồi `docker compose up -d --build`.
- Chạy kèm ESP32 giả để test không cần phần cứng: `docker compose --profile demo up -d`
  (cần `DEVICE_ID`/`DEVICE_KEY` trong `.env`).
- Kiểm tra sống: mở `http://<IP-LAN>:3000/api/health` → `{"ok":true,...}`.

## 2. Cách B — Bare metal (Node)

```powershell
npm ci
Copy-Item .env.example .env        # sửa như trên
npm start
```

- Log in ra các địa chỉ LAN; mở `http://localhost:3000`.
- **Không cần cài Mosquitto**: broker MQTT (aedes) chạy ngay trong tiến trình Node.
- Mở cổng cho ESP32 và điện thoại truy cập:
  ```powershell
  New-NetFirewallRule -DisplayName "Aquarium" -Direction Inbound -Protocol TCP `
    -LocalPort 3000,1883 -Action Allow
  ```
- Chạy nền: dùng NSSM/pm2 hoặc Task Scheduler trỏ tới `npm start` trong thư mục dự án.
- Chạy khi đang sửa code: `npm run dev` (tự nạp lại).

## 3. Lấy DEVICE_ID và DEVICE_KEY

1. Mở web → đăng nhập `admin` / mật khẩu trong `ADMIN_PASSWORD` (mặc định `beca123`).
2. Mục **Quản trị** → **Tạo khách hàng** (ví dụ `ban-cua-toi`, mật khẩu tự đặt).
3. Vẫn mục đó → **Cấp thiết bị**: chọn chủ sở hữu, đặt tên bể → bấm cấp.
4. Bảng kết quả hiện `DEVICE_ID` (dạng `esp32-1a2b3c`) và **khoá chỉ hiện đúng một lần** —
   chép ngay vào firmware. Khoá chính là password MQTT, máy chủ chỉ lưu bản băm nên
   **không xem lại được**.
5. Quên khoá: chọn thiết bị → **Đổi khoá** (khoá cũ hết hiệu lực ngay, phải nạp lại firmware).
6. Muốn có sẵn tài khoản demo không cần tạo tay: `node tools/create-demo-device.mjs`
   (in ra `demo` / `demo123456` kèm `DEVICE_ID`, `DEVICE_KEY`).

## 4. Nạp firmware vào ESP32

Mở `firmware/aquarium-node/aquarium-node.ino`, sửa **đúng 6 dòng đầu**:

| Hằng số | Điền gì | Ví dụ |
|---|---|---|
| `WIFI_SSID` | tên WiFi nhà (**ESP32 chỉ chạy 2.4 GHz**) | `NhaToi` |
| `WIFI_PASSWORD` | mật khẩu WiFi | `12345678` |
| `MQTT_HOST` | IP LAN của máy chủ | `192.168.1.10` |
| `MQTT_PORT` | giữ `1883` | `1883` |
| `DEVICE_ID` | lấy ở mục 3 | `esp32-1a2b3c` |
| `DEVICE_KEY` | lấy ở mục 3 | `oMn0EYln5bWjj-jrHx7LmOfNzYBOB7wV` |

Sau đó: **Tools → Board: ESP32 Dev Module**, chọn đúng cổng COM → **Upload** → mở
**Serial Monitor 115200**. Log đúng sẽ báo đã nối WiFi, đã nối MQTT và gửi số đo mỗi 5 giây.

Chân đấu dây (đừng đổi, web đã khớp sẵn):

| Trên web | GPIO / relay | Key trong firmware |
|---|---|---|
| Bơm tăng pH | GPIO18 → IN1 | `ph_up` |
| Bơm hạ pH | GPIO19 → IN2 | `ph_down` |
| Đèn bể | GPIO21 → IN3 | `light` |
| — | GPIO22 → IN4 | dự phòng, luôn tắt |

- Cả 4 jumper module relay để ở mức **L** (code đặt `RELAY_ACTIVE_LOW = true`).
- Cảm biến: DS18B20 = GPIO27, pH = GPIO34, độ đục = GPIO35, TDS = GPIO32.
- Test relay bằng Serial Monitor **khi chưa cắm tải**: gõ `t1` `t2` `t3` `off` `status` `help`.
- Cảm biến mực nước đang tắt có chủ đích (GPIO18 đã dùng cho relay IN1).

⚠️ **An toàn khi test**
- Bơm chìm phải **ngập trong nước**, không để chạy khô (cháy bơm trong vài chục giây).
- Không đấu 220 V vào module relay lúc test trên bàn — dùng tải 5–6 V.
- GND của module relay phải nối chung GND với ESP32.
- Cấp nguồn riêng cho bơm/đèn, không lấy từ chân 3V3 của ESP32.

## 5. Bật bot Telegram (làm một lần cho cả hệ thống)

1. Telegram → **@BotFather** → gửi `/newbot` → đặt tên + username → nhận token `123456789:AAE...`.
2. Điền vào `.env` (với Docker: biến môi trường trong `docker-compose.yml` hoặc `.env` cạnh nó):

```ini
TELEGRAM_BOT_TOKEN=123456789:AAE...
TELEGRAM_NOTIFY_LEVEL=warn      # warn = báo cả vùng vàng, critical = chỉ vùng đỏ
TELEGRAM_REPEAT_WARN_MINUTES=30
TELEGRAM_REPEAT_CRITICAL_MINUTES=10
PUBLIC_URL=http://192.168.1.10:3000
```

3. Khởi động lại. Log phải hiện:

```
[telegram] Đã bật, mức thông báo: warn.
[telegram] Bot @ten_bot_cua_ban đã sẵn sàng.
```

4. Người dùng vào web → thẻ **Thông báo Telegram** → **Liên kết Telegram** → nhận mã 8 ký tự
   → mở bot gửi `/start <mã>` → bấm **Gửi thử**.

## 6. Checklist test toàn bộ

Mỗi dòng tick ☑ khi đạt. Cột giữa là việc phải làm, cột phải là kết quả mong đợi.

### 6.1 Web — cơ bản

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | Mở `http://<IP-LAN>:3000` khi chưa đăng nhập | Bị chuyển về `/login` |
| ☐ | Đăng nhập sai mật khẩu | Báo lỗi, không vào được |
| ☐ | Đăng nhập `admin` + `ADMIN_PASSWORD` | Vào trang chính, thấy tên tài khoản |
| ☐ | Nhập sai 5 lần liên tiếp | Bị khoá tạm 5 phút |
| ☐ | Bấm **Đăng xuất** rồi mở lại `/` | Quay về trang đăng nhập |
| ☐ | Mở `/api/health` (không cần đăng nhập) | Trả JSON `ok` |
| ☐ | Mở `/api/state` khi chưa đăng nhập | `401` |

### 6.2 Web — dữ liệu & hiển thị

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | ESP32 chạy, xem 4 thẻ cảm biến | Nhiệt độ, pH, TDS, độ đục; số nhảy mỗi 5 giây |
| ☐ | Xem nhãn "cập nhật lúc …" | Giờ khớp với lần đo cuối |
| ☐ | Rút điện ESP32, chờ > 60 giây | Thẻ chuyển "mất kết nối", pill trên đầu trang báo mất kết nối |
| ☐ | Cắm lại ESP32 | Tự trở lại "trực tuyến", không cần F5 |
| ☐ | Làm pH lên 9 (nhúng đầu dò vào dung dịch thử) | Xuất hiện cảnh báo đỏ ở khung Cảnh báo |
| ☐ | Đưa pH về 7.2 | Cảnh báo tự hết, không cần thao tác gì |
| ☐ | Đổi tab biểu đồ (1h/6h/24h/7d/30d) | Biểu đồ vẽ lại, có vùng an toàn |
| ☐ | Đổi tab thông số ở biểu đồ | Đường dữ liệu đổi theo tham số |
| ☐ | Xem bảng nhật ký cảnh báo / lệnh bơm | Có dòng mới sau mỗi lần cảnh báo hoặc bấm bơm |

### 6.3 Web — điều khiển bơm (phần quan trọng nhất)

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | ESP32 offline, bấm bất kỳ nút bơm | Báo lỗi `409` — từ chối vì thiết bị đang offline |
| ☐ | Bấm **Thử 3 giây** ở bơm tăng pH | Bơm chạy 3 giây rồi tự tắt; nút hiện "đang chạy" rồi về bình thường |
| ☐ | Bật bơm tăng pH có hẹn giờ (ví dụ 60 giây) | Bơm chạy, hiện đếm ngược, tự tắt khi hết giờ |
| ☐ | Trong lúc bơm tăng pH đang chạy, bật bơm hạ pH | Bơm tăng pH **tự tắt trước** (hai bơm pH không chạy đồng thời) |
| ☐ | Bấm **Tắt** giữa chừng | Bơm dừng ngay |
| ☐ | Bấm **Tắt tất cả** | Cả 3 kênh đều tắt |
| ☐ | Bật bơm rồi rút điện ESP32 | Bơm dừng ngay (relay mất điện) |
| ☐ | Bật bơm rồi xoá WiFi trên ESP32 | Sau 60 giây không thấy MQTT, bơm tự tắt |
| ☐ | Bật bơm tăng pH và để quá thời gian tối đa (120 giây) | Máy chủ + firmware đều tự cắt |
| ☐ | Mở nhật ký lệnh bơm | Thấy đủ các lệnh vừa bấm, kèm ai bấm |
| ☐ | Rút mạng máy chủ khi bơm đang chạy (nếu test được) | ESP32 tự tắt bơm, không bơm chạy mãi |

### 6.4 Cách ly nhiều khách hàng

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | Tạo khách thứ hai + cấp cho họ một thiết bị khác | Có `DEVICE_ID` riêng |
| ☐ | Đăng nhập khách thứ hai | Chỉ thấy bể của mình ở ô chọn bể |
| ☐ | Khách thứ hai mở `/api/state?device=<bể của khách 1>` | `404` (không lộ dữ liệu) |
| ☐ | Khách thứ hai bấm nút bơm của bể khách 1 (nếu thấy) | Bị từ chối |
| ☐ | Khách thứ hai mở mục Quản trị | Không thấy mục Quản trị (chỉ admin) |
| ☐ | Khách chưa được cấp thiết bị đăng nhập | Báo "Tài khoản chưa được cấp thiết bị nào." |

### 6.5 Quản trị

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | Tạo khách mới | Đăng nhập được bằng tài khoản đó |
| ☐ | Tạo khách trùng tên | Báo lỗi trùng tên đăng nhập |
| ☐ | Khoá một khách rồi đăng nhập bằng tài khoản đó | Bị từ chối với thông báo tài khoản đã khoá |
| ☐ | Xoá khách | Phiên đăng nhập của khách đó hết hiệu lực |
| ☐ | Cấp thiết bị cho khách | Hiện `DEVICE_ID` + khoá một lần |
| ☐ | Đổi khoá thiết bị | ESP32 cũ mất kết nối cho tới khi nạp lại khoá mới |
| ☐ | Khởi động lại máy chủ | Dữ liệu, tài khoản, thiết bị vẫn còn |

### 6.6 Telegram

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | Khách bấm **Liên kết Telegram**, gửi `/start <mã>` | Bot xác nhận và liệt kê bể của khách đó |
| ☐ | Dùng mã sai / mã cũ quá 15 phút | Bot báo mã sai hoặc hết hạn |
| ☐ | Bấm **Gửi thử** | Có tin "đã kết nối được với Telegram của bạn" |
| ☐ | Gửi `/status` | Trả tình trạng bể của chính chat đó (nhiệt độ, pH, TDS) |
| ☐ | Đẩy pH vào vùng vàng | Nhận tin "⚠️ CẢNH BÁO" (với `TELEGRAM_NOTIFY_LEVEL=warn`) |
| ☐ | Để yên trong vùng vàng quá 30 phút | Nhận tin "🔁 Nhắc lại" |
| ☐ | Đẩy pH sang vùng đỏ | Nhận tin ngay "🚨 NGUY HIỂM", không chờ hết chu kỳ |
| ☐ | Để yên trong vùng đỏ quá 10 phút | Nhận tin nhắc lại |
| ☐ | Gửi `/tat` | Hiện nút **30 phút / 1 giờ / 2 giờ / đến khi bật lại / tuỳ chỉnh** |
| ☐ | Bấm "Tắt 1 giờ", rồi đẩy pH vào vùng đỏ | **Không nhận tin nào** (thẻ Telegram trên web báo đang tắt) |
| ☐ | Gửi `/tat 45` | Bot xác nhận tắt 45 phút |
| ☐ | Gửi `/bat` | Bot xác nhận bật lại; cảnh báo tiếp theo lại về |
| ☐ | Bấm "Tuỳ chỉnh…" rồi gửi `20` | Bot xác nhận tắt 20 phút |
| ☐ | Gửi `/stop` | Bot báo đã ngắt liên kết, thôi nhận tin |
| ☐ | Hai khách có bể cùng lỗi | Mỗi người chỉ nhận tin của bể mình |
| ☐ | Kiểm tra bot có tự bật bơm không | **Không bao giờ** — bot chỉ báo, không điều khiển |

### 6.7 Phần cứng / firmware

| ☑ | Việc làm | Kết quả mong đợi |
|---|---|---|
| ☐ | Serial Monitor 115200 khi khởi động | Báo WiFi, MQTT, gửi số đo mỗi 5 giây |
| ☐ | Gõ `status` ở Serial Monitor | In trạng thái 3 kênh relay |
| ☐ | Gõ `t1` `t2` `t3` khi chưa cắm tải | Từng relay đóng 3 giây rồi nhả |
| ☐ | Gõ `off` | Tắt cả kênh |
| ☐ | Rút WiFi router | Không sập/treo; khi có mạng lại tự kết nối lại |
| ☐ | Điền sai `DEVICE_KEY` rồi nạp lại | Broker từ chối; web báo mất kết nối |

## 7. Test không cần phần cứng (ESP32 giả)

```powershell
node tools/create-demo-device.mjs                 # in ra DEVICE_ID + DEVICE_KEY
npm run sim -- --device <DEVICE_ID> --key <DEVICE_KEY> --scenario critical
```

- Kịch bản có sẵn: `normal` (bình thường), `critical` (vượt ngưỡng đỏ), `low` (thiếu),
  `drift` (trôi từ từ). Thêm `--once` để gửi đúng một chu kỳ rồi thoát.
- Bơm bật trên web sẽ tác động ngược lại số đo (bơm tăng pH làm pH tăng…), nên test
  được cả vòng điều khiển mà không cần bể thật.

## 8. Bộ kiểm thử tự động (chạy trên máy chủ)

```powershell
npm run test:multi      # 27 kiểm tra: tài khoản, khoá thiết bị, cách ly dữ liệu
npm run test:telegram   # 8 kiểm tra: logic báo tin, nhắc lặp, tắt thông báo
npm run test:e2e        # chạy thật MQTT → Telegram giả, 2 khách 2 bể (không gửi tin thật)
npm run check:ui        # đối chiếu id giao diện, lớp CSS, route API
npm test                # test tích hợp: MQTT → SQLite → REST/SSE
```

`npm test` cần quyền khởi động tiến trình con (spawn). Nếu bị chặn, chạy trong
PowerShell thường (không qua sandbox) là được.

Kiểm tra giao diện thật bằng trình duyệt (tuỳ chọn, cần Chrome/Edge):

```powershell
node tools/ui-smoke.mjs --base http://127.0.0.1:3000 --username admin --password beca123
```

## 9. Sự cố thường gặp

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Web báo "Tài khoản chưa được cấp thiết bị nào." | Chưa gán bể cho khách — vào Quản trị cấp thiết bị |
| ESP32 hiện **mất kết nối** dù đã nạp firmware | Sai `DEVICE_KEY`, sai `MQTT_HOST`, ESP32 ở mạng 5 GHz, hoặc firewall chặn cổng 1883 |
| Bấm nút bơm báo `409` | Thiết bị đang offline — máy chủ từ chối để tránh bơm chạy mãi |
| Bơm tự tắt sau một lúc | Đúng thiết kế: chốt an toàn tự ngắt (nâng/hạ pH 120 giây, đèn 3600 giây) |
| Bot không nhắn | Chưa có `TELEGRAM_BOT_TOKEN`, khách chưa liên kết, thông số chưa vào vùng vàng/đỏ, hoặc khách đang `/tat` |
| Nhắn `/start <mã>` báo mã sai | Mã hết hạn sau 15 phút — bấm **Liên kết Telegram** lấy mã mới |
| Không tìm thấy khoá thiết bị | Khoá chỉ hiện một lần — dùng **Đổi khoá** rồi nạp lại vào ESP32 |
| Giao diện không đổi sau khi cập nhật | Ctrl + Shift + R (tệp tĩnh được cache 5 phút) |
| Docker không lên | Xem `docker compose logs aquarium`; nhớ `git pull` rồi `--build` lại |
| Không vào được từ điện thoại | `PUBLIC_URL`/firewall: phải mở cổng 3000 và dùng IP LAN, không dùng `localhost` |

## 10. Nghiệm thu

Đạt khi: mục 6.1 → 6.7 tick gần hết ☑, `npm run test:multi`, `test:telegram`, `test:e2e`,
`check:ui` đều xanh, và bot Telegram **chỉ báo chứ không bao giờ tự bật bơm**.
