# API và MQTT — Aqua Control 2.2

Web/API: `http://localhost:3000`. MQTT mặc định: `mqtt://<IP-LAN-server>:1883`.
Các API dữ liệu/điều khiển yêu cầu cookie phiên `beca_sid`.
`/api/health`, `/api/login`, `/api/logout` không yêu cầu phiên.

## Relay

Tên `pumps` được giữ trong API/JSON/database để tương thích cấu trúc cũ,
nhưng danh mục hiện tại gồm **hai bơm và một đèn**.

| Key | Chức năng | Relay | GPIO | Thời gian tối đa |
|---|---|---|---|---|
| `ph_up` | Bơm tăng pH | IN1 | 18 | 120 giây |
| `ph_down` | Bơm hạ pH | IN2 | 19 | 120 giây |
| `light` | Đèn bể cá | IN3 | 21 | 3600 giây |

Không còn kênh điều khiển `drain`; nhật ký cũ vẫn được giữ nguyên.
IN4/GPIO22 dự phòng, không có endpoint điều khiển.

## HTTP

| Endpoint | Hành vi |
|---|---|
| `GET /api/health` | Uptime, brokerConnected, device |
| `POST /api/login` | Body `{"password":"..."}`, tạo cookie |
| `POST /api/logout` | Xóa cookie |
| `GET /api/me` | Username và hết hạn phiên |
| `GET /api/state` | Snapshot đầy đủ, không cache |
| `GET /api/stream` | SSE, sự kiện `state` chứa cùng snapshot; heartbeat, tự reconnect |
| `GET /api/history?metric=ph&range=1h` | Điểm trung bình/min/max theo bucket |
| `GET /api/alerts?limit=50` | Lịch sử cảnh báo |
| `GET /api/events/pumps?limit=50` | Lịch sử lệnh gửi cho bơm/đèn |
| `GET /api/devices` | Danh sách thiết bị đã lưu |
| `POST /api/pumps/:key` | Bật/tắt một relay |
| `POST /api/relays/stop-all` | Gửi OFF cho mọi relay có capability; cần online |

Bật một kênh, ví dụ:

```http
POST /api/pumps/light
Content-Type: application/json

{"action":"on","seconds":60}
```

Tắt: `{"action":"off"}`. Khi bật, thiếu seconds mặc định **3 giây**.
Seconds phải hữu hạn và dương; server lấy phần nguyên, giới hạn theo từng kênh.
Bật bơm pH sẽ gửi OFF cho bơm pH còn lại đang bật/đang chờ bật, trước lệnh ON.
Đèn không tham gia nhóm liên động.

Phản hồi thành công: `{"ok":true,"pumps":[...],"exclusiveGroups":{...},"deviceOnline":true}`.
Đây là xác nhận server đã gửi lệnh, **không phải xác nhận tải đã bật**.

Lỗi: 400 sai key/action/seconds; 401 chưa đăng nhập; 409 offline, thiếu capability
hoặc kênh đang chờ lệnh bật; 503 broker chưa sẵn sàng.
OFF được phép khi có lệnh đang chờ và khi trạng thái chưa xác nhận.

## Snapshot

`device` có `id`, `online`, `status`, `lastSeen`, `ageMs`, `ip`, `rssi`,
`firmware`, `staleAfterMs`, `capabilities`.

```json
{
  "pumps": true,
  "relay_keys": ["ph_up", "ph_down", "light"],
  "water_level": false,
  "food_level": false,
  "turbidity_voltage": true
}
```

Một kênh chỉ `available: true` nếu `pumps: true` và key nằm trong `relay_keys`.
Firmware cũ không có danh sách này phải được nạp lại để điều khiển an toàn.

`pumps[]` và `pumpCatalog[]` chứa định nghĩa label, kind (`pump`/`light`), GPIO,
relayChannel, maxRunSeconds, defaultSeconds và durations.
Các trường trạng thái của `pumps[]`:

- `on`: trạng thái GPIO thiết bị báo gần nhất; không suy ra từ lệnh gửi.
- `confirmed`: đã nhận báo cáo trạng thái trực tiếp, thiết bị đang online.
- `pending`, `pendingAction`, `commandId`: đang chờ lệnh bật/tắt được phản hồi.
- `error`: từ chối hoặc quá thời gian chờ 8 giây; cấu hình bằng COMMAND_ACK_TIMEOUT_MS.
- `since`, `offAt`, `runSeconds`, `remainingSeconds`: thời gian của trạng thái/hẹn giờ.
- `source`: `serial` hoặc `mqtt` nếu có trong relay_timers của ESP32.
- `lastEvent`: lệnh gửi gần nhất, không phải phép đo tải điện thực tế.

Trạng thái retained không chứng minh thiết bị online. Sau restart, server chờ bản tin
trực tiếp trước khi cho gửi lệnh. Khi offline, `confirmed=false`, không tự giả định tải đã tắt.

`params[]`: bốn thẻ cảm biến mặc định, gồm value, unit, decimals, status, statusText,
rangeLabel, note. Chỉ thêm mực nước/thức ăn nếu capability tương ứng được bật.
`status` có `good | warn | critical | nodata | unrated`. `unrated` là chưa có ngưỡng
đánh giá (điện áp độ đục). Issues rỗng không có nghĩa cảm biến thiếu đã an toàn.
Snapshot còn chứa reading, readingAgeMs, issues, suggestions, recentAlerts,
recentPumpEvents, retention, exclusiveGroups và brokerConnected.

## Lịch sử

Metric hợp lệ: temperature, ph, tds, turbidity, turbidity_voltage, water_level, food_level.
Range: 1h, 6h, 24h, 7d, 30d. Response chứa metric, range, from, to, bucketMs,
unit, decimals, safeRange và points. Mỗi point có ts, avg, min, max, n.

`turbidity` giữ lịch sử NTU cũ; `turbidity_voltage` lưu điện áp OUT (V) riêng,
3 số lẻ, safeRange có min/max null. Không trộn hai đơn vị.
Null/chuỗi rỗng/boolean không được chuyển thành số 0 trong telemetry.
sensor_status được lưu cùng bản ghi để còn nhãn hiệu chuẩn sau restart.

## MQTT

Tiền tố mặc định `aquarium`, dashboard chỉ xử lý DEVICE_ID cấu hình.
Firmware gửi chu kỳ khoảng 5 giây, không gửi millis làm epoch timestamp;
server đóng dấu thời gian nếu payload không có ts hợp lệ.

| Topic | Chiều | Retained |
|---|---|---|
| `aquarium/<id>/telemetry` | ESP32 → server | Không |
| `aquarium/<id>/state` | ESP32 → server | Có |
| `aquarium/<id>/status` | ESP32 → server | Có, `online`/`offline`, LWT |
| `aquarium/<id>/ack` | ESP32 → server | Không |
| `aquarium/<id>/cmd` | Server → ESP32 | Không |

Telemetry v2.2:

```json
{
  "temperature":26.25,"ph":7.23,"tds":225,
  "turbidity":null,"turbidity_voltage":4.08,
  "water_level":null,"food_level":null,
  "firmware":"2.2.0-relay3-light",
  "capabilities":{"pumps":true,"relay_keys":["ph_up","ph_down","light"],"water_level":false,"food_level":false,"turbidity_voltage":true},
  "sensor_status":{"ph_calibrated":true,"tds_estimated":true,"tds_temperature_fallback":false,"ph_adc_voltage":1.5,"tds_adc_voltage":0.6,"turbidity_adc_voltage":2.04},
  "pumps":{"ph_up":false,"ph_down":false,"light":true},
  "relay_timers":{"ph_up":{"remaining_ms":0,"source":"mqtt"},"ph_down":{"remaining_ms":0,"source":"mqtt"},"light":{"remaining_ms":59900,"source":"mqtt"}}
}
```

`state` gửi firmware, ip, overflow, capabilities, pumps và relay_timers.
`remaining_ms` giúp web tính đúng thời gian còn lại của cả test Serial và lệnh MQTT.
Dữ liệu cảm biến lỗi/chưa hiệu chuẩn dùng JSON null; không gửi NaN như một token JSON.

Command:

```json
{"id":"cmd-uuid","pump":"light","action":"on","duration":60,"source":"user","ts":1794300000000}
```

ACK:

```json
{"id":"cmd-uuid","pump":"light","action":"on","ok":true,"pumps":{"ph_up":false,"ph_down":false,"light":true}}
```

ACK lỗi có `ok:false`, `reason`. Server không áp ACK có ID cũ vào lệnh đang chờ mới.
State/telemetry trực tiếp có trạng thái đúng với lệnh đang chờ cũng có thể xác nhận lệnh.
ESP32 nhớ 8 ID lệnh bật gần nhất để bản giao lặp QoS 1 không kéo dài hẹn giờ.
Lệnh tự tắt tại thiết bị có thể không có ID (không phải ACK một yêu cầu mới).

