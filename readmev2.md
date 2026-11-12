# Aqua Control — hướng dẫn bản 3.0: nhiều khách hàng, hai bơm pH và đèn

Bản này đồng bộ website, server và firmware với mạch relay bạn vừa sửa:
**IN1/GPIO18 = bơm tăng pH, IN2/GPIO19 = bơm hạ pH, IN3/GPIO21 = đèn 6 V**.
IN4/GPIO22 dự phòng, luôn tắt. Kênh xả tràn `drain` đã được thay bằng `light`.

So với 2.2, bản 3.0 chuyển từ **một mật khẩu dùng chung** sang **đăng nhập theo
tài khoản**: quản trị viên tạo khách hàng, cấp thiết bị, mỗi khách chỉ thấy bể của
mình và liên kết Telegram riêng để bot chỉ nhắn cho đúng người. Mỗi thiết bị có
khoá riêng; broker chặn thiết bị này ghi vào topic của thiết bị khác.

## 1. Đã kiểm tra và sửa gì?

| Vấn đề tìm thấy | Cách sửa |
|---|---|
| Website/server còn gửi `drain`, chưa biết `light` | Đồng bộ ba khóa `ph_up`, `ph_down`, `light` ở mọi tầng |
| Chân relay trên web còn là 25/26/23 | Cập nhật đúng GPIO18/19/21 theo firmware mới của bạn |
| Hai hàm cùng đọc Serial, khiến lệnh pH có thể bị nuốt | Một bộ đọc Serial phân luồng cả lệnh relay lẫn hiệu chuẩn |
| GPIO18/19/21 trùng chân siêu âm cũ | Giữ cảm biến mực nước tắt, thêm static_assert để chặn bật nhầm |
| Website báo “đang chạy” ngay khi gửi lệnh | Chờ trạng thái từ ESP32; thiếu ACK thì báo chưa xác nhận |
| Từ chối lệnh Tắt có thể làm giao diện báo tắt sai | Giữ trạng thái thiết bị báo về và hiện lý do từ chối |
| State/status retained cũ có thể làm thiết bị trông như đang online | Chờ bản tin trực tiếp trước khi cho điều khiển |
| Lệnh QoS 1 có thể được giao lặp | Firmware nhớ 8 ID lệnh bật gần nhất, không khởi động lại hẹn giờ cho cùng ID |
| Test Serial bị chậm do đo/kết nối lại | Trong bài test Serial 3 giây, tạm hoãn đo và thử kết nối MQTT lại |

Giao diện mới đưa ba kênh điều khiển lên đầu, có màu riêng cho từng kênh,
nút **Thử 3 giây**, **Bật có hẹn giờ**, **Tắt** và **Tắt tất cả**.
Bên dưới là bốn số đo nhiệt độ, pH, TDS, độ đục; biểu đồ và lịch sử lệnh.
Chỉ số mực nước được ẩn khi firmware chưa bật cảm biến.

## 2. Sơ đồ chân đang dùng

| Phần cứng | GPIO / cách nối |
|---|---|
| pH analog Po | GPIO34, giữ chia áp 10k/10k |
| Độ đục analog OUT | GPIO35, giữ chia áp 10k/10k |
| TDS analog A | GPIO32, module cấp 3V3 như mạch đã test |
| DS18B20 DATA | GPIO27, kéo lên 3V3 bằng 4,7kΩ |
| Relay IN1 — bơm tăng pH | GPIO18 |
| Relay IN2 — bơm hạ pH | GPIO19 |
| Relay IN3 — đèn 6 V | GPIO21 |
| Relay IN4 — dự phòng | GPIO22, firmware giữ tắt |

Firmware đang dùng **relay kích mức LOW**, tương ứng jumper **L** trên module H/L.
Kiểm tra relay đóng/ngắt đúng với tải thử trước khi chạy bơm dung dịch.
Đèn 6 V dùng nguồn 6 V qua tiếp điểm COM/NO của relay; GPIO chỉ điều khiển chân IN.
Giữ cách cấp nguồn/GND và mạch chia áp cảm biến đã kiểm tra hoạt động.

Không bật `ENABLE_WATER_LEVEL`: chân siêu âm cũ
đang trùng với relay IN1. Compiler sẽ báo lỗi nếu bạn bật nhầm.

## 3. Chạy website

Mở thư mục `D:\Documents\IOT` trong VS Code, Terminal tại nơi có `package.json`:

```powershell
node --version
npm.cmd ci --cache .npm-cache
npm.cmd start
```

Đã kiểm tra với Node.js 24.14.1. Dùng `npm.cmd` trên PowerShell nếu `npm.ps1` bị chặn.
Mở **http://localhost:3000**, đăng nhập **admin** / **beca123**
(hoặc `ADMIN_PASSWORD` của bạn trong `.env`). Đổi mật khẩu ngay sau lần đầu.

Hệ thống phục vụ **nhiều khách hàng**. Tài khoản `admin` tạo khách trong mục
**Quản trị**, cấp cho mỗi người một hoặc nhiều thiết bị. Mỗi thiết bị có
`DEVICE_ID` và `DEVICE_KEY` riêng; khoá chỉ hiện một lần lúc cấp hoặc đổi khoá.

Server có sẵn broker MQTT cổng 1883 và SQLite, không cần cài thêm Mosquitto.
Máy tính phải tiếp tục chạy server để nhận/lưu dữ liệu và điều khiển qua web.
Điện thoại cùng mạng mở `http://<IP-LAN-máy-tính>:3000`.

Nếu chưa có `.env` và muốn tự cấu hình:

```powershell
Copy-Item .env.example .env
```

Không ghi đè `.env` đã cấu hình. Các giá trị liên quan:

```dotenv
PORT=3000
HOST=0.0.0.0
MQTT_PORT=1883
MQTT_TOPIC_PREFIX=aquarium
ADMIN_PASSWORD=beca123
```

Thiết bị **không** còn khai báo trong `.env`; quản trị viên cấp trên web. Muốn có
thiết bị để thử mà không mở web:

```powershell
node tools/create-demo-device.mjs
```

Lệnh in ra `DEVICE_ID`/`DEVICE_KEY` để nạp vào firmware hoặc chạy bộ giả lập.

Sau khi sửa `.env`, khởi động lại server. Không chạy simulator cùng lúc với thiết bị
thật dùng chung `DEVICE_ID`: hai nguồn sẽ ghi đè trạng thái của nhau.

## 4. Firmware để nạp

Mở **`firmware/aquarium-node/aquarium-node.ino`**, giữ file
`water-sensors.h` cùng thư mục. Phiên bản hiện tại: **2.2.0-relay3-light**.

Thông tin Wi-Fi bạn vừa nhập được giữ lại trong firmware. Trước khi nạp,
kiểm tra `WIFI_SSID`, `WIFI_PASSWORD`, `MQTT_HOST`, `DEVICE_ID`, `DEVICE_KEY`.
`MQTT_HOST` là **IP LAN máy tính chạy server**, không phải localhost hay URL website.
Log server in dòng `ESP32 -> <IP>:1883`; chọn IP card Wi-Fi, không chọn IP VPN/VMware.
`MQTT_PORT`, `TOPIC_PREFIX` phải khớp server.

`DEVICE_ID` và `DEVICE_KEY` là cặp quản trị viên cấp cho bể của bạn trên web
(mục **Quản trị** → **Cấp thiết bị**). Broker xác thực MQTT bằng chính hai giá trị
này, nên thiết bị của người khác không ghi được vào bể của bạn và ngược lại.
Quên khoá thì bấm **Đổi khoá** rồi nạp lại firmware.

ESP32 phải liên lạc được với máy tính trong LAN. Nếu không kết nối được,
kiểm tra Wi-Fi 2,4 GHz và cho phép Node.js/TCP 1883 trong Windows Firewall mạng Private.

Các cờ hiện tại:

```cpp
const bool ENABLE_PUMPS = true; // tên cũ, bật cả 2 bơm và đèn
const bool ENABLE_FLOAT = false;
const bool ENABLE_WATER_LEVEL = false;
```

### Cách A — Arduino IDE

1. Mở đúng file `firmware/aquarium-node/aquarium-node.ino`.
2. Chọn board **ESP32 Dev Module**, đúng COM.
3. Cài **PubSubClient**, **ArduinoJson 7.x**, **OneWire**, **DallasTemperature**.
   WiFi và Preferences có trong board package ESP32; không cần ESP32Servo.
4. Verify rồi Upload; đóng Serial Monitor của ứng dụng khác trước khi nạp.
5. Serial Monitor **115200 baud**, kết thúc dòng **Newline**.

Đừng xóa toàn bộ flash nếu muốn giữ hai điểm pH đã lưu trong NVS.

### Cách B — VS Code + PlatformIO

Có thể làm toàn bộ trong VS Code. Cài extension **PlatformIO IDE**, mở thư mục gốc
có `platformio.ini`, chờ tải toolchain/thư viện, rồi chọn **Build**, **Upload**,
**Serial Monitor**.

Trong terminal PlatformIO Core CLI:

```powershell
pio run -e esp32dev
pio run -e esp32dev --target upload
pio device monitor --baud 115200
```

Nếu không tự chọn được cổng, thêm `upload_port = COM5` và `monitor_port = COM5`
vào `[env:esp32dev]`, thay COM5 bằng COM thật.
Website chạy bằng Node.js ở terminal riêng, kể cả khi dùng Arduino IDE để nạp.

## 5. Test sau khi nạp

### Bước 1 — Serial, có thể chưa bật server

Gửi lần lượt, đợi từng lệnh tự tắt trước khi thử tiếp:

| Lệnh | Kết quả |
|---|---|
| `t1` | IN1/GPIO18 bật khoảng 3 giây rồi tắt |
| `t2` | IN2/GPIO19 bật khoảng 3 giây rồi tắt |
| `t3` | IN3/GPIO21 bật khoảng 3 giây rồi tắt |
| `off` | Tắt cả ba kênh |
| `status` | In trạng thái ba kênh và IN4 dự phòng |
| `help` | Hướng dẫn relay và hiệu chuẩn pH |

Test Serial chỉ bật một kênh tại một thời điểm, tắt mọi kênh trước khi thử kênh khác.
`off` được xử lý khi vòng lặp đọc Serial; đây không phải ngắt cứng bằng phần cứng.

### Bước 2 — Website

1. Chạy `npm.cmd start`, đợi Serial báo MQTT kết nối.
2. Đăng nhập web; phải có firmware 2.2 và ba kênh đã được xác nhận.
3. Bấm **Thử 3 giây** từng kênh, quan sát relay/tải thực và web cùng đổi trạng thái.
4. Bật đèn trong **1 phút**, sau đó thử một bơm: đèn vẫn bật.
5. Bật bơm tăng pH, rồi bật bơm hạ pH: bơm tăng phải tắt, đèn không bị tắt.
6. Bấm **Tắt tất cả**, xác nhận cả ba kênh tắt.

Lần đầu dùng tải thử trước khi gắn bơm dung dịch. Nút “Thử 3 giây” trên web
chỉ tác động kênh chọn; khác với Serial t1/t2/t3 vốn tắt các kênh trước khi thử.
Nếu muốn chỉ một kênh chạy khi test web, bấm “Tắt tất cả” trước.

“Đang chạy/Đang sáng” nghĩa là ESP32 báo trạng thái GPIO, chưa chứng minh tải có
điện hay bơm có lưu lượng. Cần quan sát relay và tải thực.
Giao diện chờ phản hồi, nếu quá 8 giây không xác nhận sẽ báo lỗi.
Khi mất mạng, trạng thái chuyển sang chưa xác nhận, nút điều khiển bị khóa.
Lệnh “Tắt tất cả” cũng cần kết nối; không thay thế công tắc nguồn tại chỗ.

### Giới hạn thời gian

- Hai bơm pH: tối đa **120 giây** mỗi lần; lựa chọn mặc định là **3 giây**.
- Đèn: tối đa **3600 giây / 60 phút**, có thể tắt sớm; mặc định cũng là 3 giây để thử.
- Bật một bơm pH sẽ tắt bơm pH còn lại; đèn không thuộc nhóm liên động.
- ESP32 tự ngắt các kênh bật qua MQTT khi mất kết nối quá **60 giây**.
- Không tự bật bơm theo pH; người dùng quyết định mọi lệnh bật.
- Nếu sau này bật phao GPIO33, phao sẽ chặn bơm hóa chất khi báo tràn.
- Hẹn giờ được kiểm tra trong vòng lặp, có thể trễ do đọc cảm biến hoặc xử lý mạng.

## 6. Cảm biến và hiệu chuẩn

Logic đo trong `water-sensors.h` giữ theo bản test ban đầu: ADC mV, trung vị
31 mẫu, công thức pH hai điểm và TDS bù nhiệt. Giá trị không hợp lệ gửi JSON null,
web hiển thị “—”; không đổi số đo lỗi thành 0.

**pH:** gửi `ph7` trong dung dịch chuẩn pH 7 và `ph4` trong dung dịch chuẩn pH 4,
sau khi ổn định. Hai điện áp phải chênh hơn 0,02 V. `resetph` xóa hiệu chuẩn.
Giữ namespace NVS `water-test`, khóa `ph7v`/`ph4v`, nên dùng lại hiệu chuẩn
cũ nếu không xóa flash/phân vùng NVS. Không dùng nước máy thay dung dịch chuẩn.

**TDS:** là ước tính theo mô hình SEN0244; nếu DS18B20 lỗi sẽ tạm bù nhiệt 25 °C
và web ghi chú. Chưa phải kết quả TDS đã hiệu chuẩn.

**Độ đục:** hiển thị điện áp OUT, `turbidity_voltage = Vadc × 2`, đơn vị V.
Chưa có phép quy đổi NTU cho module nên không áp ngưỡng NTU lên điện áp.
Lịch sử NTU cũ và điện áp mới được lưu riêng.

## 7. Demo không có ESP32 và kiểm thử

Server ở terminal 1, simulator ở terminal 2:

```powershell
npm.cmd start
npm.cmd run sim
```

Mặc định simulator là `relay-test`: bốn số đo + hai bơm + đèn, nhận lệnh và trả ACK.
Muốn thử trạng thái pH chưa hiệu chuẩn/không relay:
`npm.cmd run sim -- --scenario water-test`.
Dừng simulator trước khi dùng ESP32 thật.

Kiểm thử tự động dùng database/cổng riêng, không sửa dữ liệu vận hành:

```powershell
npm.cmd test
```

Đã kiểm tra trong bản này:

- MQTT → SQLite → REST/SSE, giữ dữ liệu cũ và dữ liệu sau khi restart.
- Giữ null/điện áp 0, cảnh báo pH và tách lịch sử V với NTU.
- Đúng khóa/GPIO, giới hạn thời gian từng kênh, liên động hai bơm, đèn độc lập.
- Lệnh chờ ACK, bỏ ACK cũ, xử lý từ chối/thiếu ACK, tắt tất cả và offline.
- Retained state/status cũ không tự mở quyền điều khiển sau restart.
- Simulator thật nhận lệnh, tự tắt 3 giây và trả state/ACK.
- Firmware biên dịch bằng Arduino CLI 1.5.1, ESP32 core 3.3.12:
  **931.708 byte chương trình (71%), 48.520 byte biến toàn cục (14%)**.
- Build **PlatformIO esp32dev** cũng thành công với cấu hình `platformio.ini`:
  **783.233 byte chương trình (59,8%), 46.376 byte RAM (14,2%)**.
  Binary để công cụ upload sử dụng nằm ở `.pio/build/esp32dev/firmware.bin`.
  Kích thước khác bản Arduino CLI vì dùng phiên bản core/toolchain khác nhau.
- Giao diện Chrome qua Playwright: đăng nhập, bật hẹn giờ/3 giây, liên động,
  đèn độc lập, tắt tất cả, biểu đồ V, khóa khi thiết bị offline; desktop 1440×1050
  và mobile 390×844. Không có lỗi/cảnh báo console; mobile không tràn ngang,
  hộp chọn thời gian nằm trong màn hình.

Chưa nạp firmware hay đo relay thật trong lần chỉnh này.

## 7b. Thông báo Telegram khi thông số vào vùng vàng hoặc đỏ

Mỗi khách hàng liên kết **Telegram của riêng mình**; bot chỉ nhắn cho đúng người
sở hữu bể đang có sự cố. Không có chat id dùng chung trong `.env`.

### Tạo bot (làm một lần, cho cả hệ thống)

1. Mở Telegram, tìm **@BotFather**, gửi `/newbot`, đặt tên và username.
   BotFather trả về token dạng `123456789:AAE...`.
2. Điền token vào `.env` (hoặc biến môi trường của container):

```ini
TELEGRAM_BOT_TOKEN=123456789:AAE...
# "warn" báo cả vùng vàng (mặc định), "critical" chỉ báo vùng đỏ
TELEGRAM_NOTIFY_LEVEL=warn
# Nhắc lại khi thông số vẫn còn xấu
TELEGRAM_REPEAT_WARN_MINUTES=30
TELEGRAM_REPEAT_CRITICAL_MINUTES=10
PUBLIC_URL=http://192.168.1.10:3000
```

3. Khởi động lại server. Log in ra `[telegram] Đã bật, mức thông báo: warn.`

### Mỗi khách tự liên kết

4. Đăng nhập bằng tài khoản của mình, vào thẻ **Thông báo Telegram**, bấm
   **Liên kết Telegram**. Web hiện mã 8 ký tự kèm câu lệnh mẫu.
5. Mở Telegram, tìm bot, gửi `/start <mã>` (mã có hạn 15 phút).
6. Bot trả lời xác nhận và liệt kê bể của tài khoản đó. Bấm **Gửi thử** trên web
   để chắc chắn đường đi thông suốt.

Khách đổi tài khoản Telegram thì bấm **Ngắt liên kết** rồi liên kết lại, hoặc gửi
`/stop` trong bot. Lệnh `/status` trả tình trạng các bể của chính chat đó.

### Khi nào bot nhắn

Bot nhắn khi một thông số **chuyển** vào vùng vàng hoặc đỏ, rồi **nhắc lại** mỗi
30 phút (vàng) / 10 phút (đỏ) chừng nào còn xấu — không dội tin theo từng số đo.
Vàng chuyển sang đỏ thì nhắn ngay. Thông số phải ra khỏi vùng xấu rồi rơi lại thì
mới tính là tin mới. Trạng thái theo dõi tách riêng theo từng cặp *thiết bị + chat
id*, nên hai khách có bể cùng lỗi vẫn nhận tin riêng của mình, không lẫn.

Khách muốn im: `/tat` (hiện nút 30 phút / 1 giờ / 2 giờ / đến khi bật lại / tuỳ
chỉnh), `/tat 45` để tắt thẳng 45 phút, `/bat` để bật lại. Mỗi tin cảnh báo cũng
kèm sẵn nút tắt nhanh. Bot không bao giờ tự bật bơm — dự án vẫn giữ nguyên nguyên
tắc không tự động hoá.

### Kiểm thử

```powershell
npm.cmd run test:telegram   # logic báo tin + nhắc lặp + tắt thông báo, không cần mạng
npm.cmd run test:e2e        # chạy thật MQTT → Telegram giả lập, hai khách hai bể
```

Bài e2e dựng một Telegram giả trên localhost nên không gửi tin thật, và kiểm bảy
tình huống: bình thường không báo, vào vùng đỏ báo một tin cho đúng chủ, đang đỏ
không báo lặp, bể của khách khác báo riêng không lẫn, ngắt liên kết thì thôi nhận,
quay lại vùng đỏ báo lại, tắt thông báo thì im và bật lại thì nhận tiếp.

## 8. File cần biết

| File | Vai trò |
|---|---|
| `firmware/aquarium-node/aquarium-node.ino` | Firmware chính để nạp, Wi-Fi/MQTT, relay, Serial |
| `firmware/aquarium-node/water-sensors.h` | Đo và hiệu chuẩn bốn cảm biến |
| `platformio.ini` | VS Code + PlatformIO |
| `server/config.js` | Khóa relay, GPIO, giới hạn, thời gian lựa chọn |
| `server/users.js` | Băm mật khẩu scrypt, tạo tài khoản quản trị đầu tiên |
| `server/auth.js` | Phiên đăng nhập, `requireAuth`, `requireAdmin` |
| `server/db.js` | SQLite: users, devices, readings, alerts, pump_events |
| `server/broker.js` | Xác thực thiết bị, gửi lệnh, xác nhận, timeout, liên động |
| `server/api.js` | REST + SSE, phân quyền theo chủ sở hữu, route quản trị |
| `server/telegram.js` | Bot Telegram nhiều khách hàng, chống spam |
| `public/index.html`, `public/js/dashboard.js`, `public/styles.css` | Giao diện |
| `docs/api.md` | Giao thức và API |
| `tests/integration.test.js` | Kiểm thử toàn luồng |
| `tests/multi-tenant.test.js` | Kiểm thử đa khách hàng và xác thực broker |
| `tests/telegram.test.js`, `tests/telegram-e2e.mjs` | Kiểm thử bot Telegram |
| `tools/create-demo-device.mjs` | Tạo nhanh tài khoản + thiết bị để thử |

