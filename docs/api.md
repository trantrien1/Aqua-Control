# API và MQTT — Aqua Control 4.0

## Xác thực và REST

HTTP dùng cookie `beca_sid`. Health/login/logout công khai; API còn lại yêu cầu phiên. Khách chỉ truy cập bể thuộc quyền; bể khác trả 404. Quản trị dùng API quản lý tài khoản/thiết bị, không xem dữ liệu hoặc điều khiển bể.

| Endpoint | Tác dụng |
|---|---|
| `GET /api/health` | Health |
| `POST /api/login`, `/api/logout` | Đăng nhập/đăng xuất |
| `GET /api/me` | Phiên |
| `GET /api/devices`, `POST /api/devices` | Liệt kê/tạo bể |
| `GET /api/state?device=<id>` | Snapshot |
| `GET /api/stream?device=<id>` | SSE sự kiện state, heartbeat |
| `GET /api/history?device=<id>&metric=ph&range=24h` | Lịch sử avg/min/max/n |
| `GET /api/alerts`, `/api/events/pumps` | Nhật ký |
| `GET /api/devices/:id/settings` | Cấu hình và đồng bộ |
| `PATCH /api/devices/:id/settings` | Lưu cấu hình đầy đủ |
| `POST /api/devices/:id/pumps/:key` | Relay drain/fill/light |
| `POST /api/devices/:id/water-change` | Start/stop/reset chu trình |
| `POST /api/devices/:id/relays/stop-all` | Dừng chu trình và tắt relay |
| `POST /api/telegram/link`, `/api/telegram/unlink`, `/api/telegram/test` | Telegram của tài khoản |
| `/api/admin/users`, `/api/admin/devices` | Quản trị |

Body bật relay `{"action":"on","seconds":60}`, tắt `{"action":"off"}`; bật tay tối đa 3600 giây. HTTP thành công xác nhận máy chủ gửi, cần state/ACK để xác nhận thiết bị. Lỗi: 400 dữ liệu, 401 phiên, 403 vai trò, 404 quyền sở hữu, 409 xung đột/offline/chưa đồng bộ, 503 broker.

## Cấu hình bể và đèn

Ví dụ PATCH khi revision hiện tại là 2:

```json
{
  "revision": 2,
  "tankLiters": 60,
  "autoEnabled": false,
  "thresholds": {
    "temperature": {"min":24,"max":28,"criticalMin":20,"criticalMax":32},
    "ph": {"min":6.8,"max":8.2,"criticalMin":6,"criticalMax":9},
    "tds": {"min":180,"max":280,"criticalMin":60,"criticalMax":450},
    "turbidity_percent": {"min":0,"max":30,"criticalMin":0,"criticalMax":60}
  },
  "lighting": {
    "scheduleEnabled": true, "onMinute": 480, "offMinute": 960,
    "utcOffsetMinutes": 420, "heatEnabled": true, "heatOn": 24, "heatOff": 25
  }
}
```

Server tăng revision, lưu SQLite, gửi MQTT retained; ESP32 lưu NVS và báo revision đã áp dụng. Phút trong ngày 0–1439, giờ bật/tắt khác nhau, hỗ trợ qua nửa đêm. Offset −720 đến +840 phút. Nhiệt độ 0–40 °C, ngưỡng tắt cao hơn bật ít nhất 0,1 °C. Có thể để tankLiters null khi autoEnabled false để chỉ dùng đèn. Client không gửi lighting thì giữ cấu hình đèn trước đó.

## MQTT

Username = DEVICE_ID, password = DEVICE_KEY. Broker nhúng chỉ cho thiết bị publish telemetry/state/status/ack của chính nó và subscribe nhánh riêng. Broker ngoài cần ACL tương đương.

| Topic dưới `aquarium/<id>/` | Chiều | Retained |
|---|---|---|
| telemetry | ESP32 → máy chủ | Không |
| state | ESP32 → máy chủ | Có |
| status | ESP32/broker → máy chủ | Có, LWT offline |
| ack | ESP32 → máy chủ | Không |
| cmd | Máy chủ → ESP32 | Không |
| config | Máy chủ → ESP32 | Có |

Máy chủ gửi lệnh/cấu hình QoS 1. ESP32 publish QoS 0, subscribe QoS 1. Telemetry khoảng 5 giây, state 30 giây hoặc 5 giây trong chu trình. Retained cũ không chứng minh online. Cảm biến lỗi dùng null; timestamp do server bổ sung nếu thiếu.

Lệnh relay:

```json
{"id":"cmd-001","pump":"light","action":"on","duration":60,"source":"user"}
```

Lệnh chu trình:

```json
{"id":"cmd-002","type":"water_change","action":"start","percent":20,"settings_revision":3}
```

ACK có ID, ok, reason khi có lỗi và trạng thái thiết bị. Đặt lại có xác nhận dùng action reset và confirm_level true. ESP32 nhớ 8 ID trong RAM để tránh xử lý lặp.

Đồng bộ giờ: server gửi `{"type":"time","epoch":1794531600}` trên cmd không retained theo báo cáo thiết bị khoảng mỗi 30 giây. Epoch là Unix UTC giây. NTP là nguồn bổ sung. Không lấy timestamp cấu hình retained làm giờ hiện tại.

Firmware 4 khai báo capabilities.lighting true và gửi trạng thái:

```json
{
  "lighting": {
    "clock_valid": true, "schedule_demand": true, "heat_demand": false,
    "manual_override": false, "source": "schedule"
  },
  "pumps": {"drain":false,"fill":false,"light":true},
  "relay_timers": {"light":{"remaining_ms":0,"source":"schedule"}}
}
```

Nguồn tự động gồm schedule, temperature, schedule+temperature; đèn tự động không chịu timer bật tay hoặc watchdog mất MQTT. HTTP snapshot cung cấp water.lighting với clockValid/scheduled/heating/manualOverride/source; cấu hình ở water.settings.lighting.

Tắt tay ưu tiên 60 phút trong RAM; bật tay ưu tiên theo duration. Hết ưu tiên trở về tự động. Sau reboot, cấu hình NVS còn nhưng lịch chờ đồng bộ giờ; giữ ấm cần cảm biến hợp lệ và không cần mạng.
