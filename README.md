# Aqua Control 4.0

Hệ thống giám sát và điều khiển bể cá bằng ESP32, MQTT, Web và Telegram.

- Theo dõi nhiệt độ, pH, TDS, độ đục; biểu đồ và lịch sử SQLite.
- Điều khiển bơm rút/cấp nước, thay theo phần trăm và tự động theo ngưỡng.
- Hẹn giờ đèn hằng ngày, lịch qua nửa đêm, bật đèn khi nhiệt độ thấp.
- ESP32 lưu cấu hình NVS và tự điều khiển tại chỗ khi mất mạng.
- Nhiều tài khoản, nhiều bể, phân quyền và Telegram riêng từng chủ bể.

## Tài liệu

- [Báo cáo kỹ thuật](BAO_CAO_KY_THUAT.md): kiến trúc, linh kiện, sơ đồ mạch, thuật toán và giao thức.
- [Hướng dẫn sử dụng](docs/HUONG_DAN_SU_DUNG.md): triển khai, ESP32, lịch đèn và Telegram.
- [Giao thức và API](docs/api.md): REST, MQTT, cấu hình và trạng thái.
- [Triển khai Railway](docs/TRIEN_KHAI_RAILWAY.md): máy chủ từ xa.

## Chạy máy chủ

Cần Node.js từ 22.5.0 trở lên. Chỉ tạo `.env` từ mẫu khi chưa có cấu hình riêng:

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd start
```

Đặt `ADMIN_PASSWORD` trước lần khởi động đầu, mở `http://localhost:3000`. Quản trị tạo tài khoản khách và cấp thiết bị; khách có thể tự thêm bể. Lưu ID/key khi hiển thị để cấu hình MQTT của ESP32. Docker: `docker compose up -d --build`; HTTP cổng 3000, MQTT cổng 1883, dữ liệu tại volume `aquarium-data`.

## Firmware và phần cứng

Sketch chính [aquarium-node.ino](firmware/aquarium-node/aquarium-node.ino) được Arduino IDE mở trực tiếp. PlatformIO dùng `.cpp` nhỏ để biên dịch cùng sketch. Tạo `local-config.h` từ `local-config.example.h` nếu chưa có, điền Wi-Fi, máy chủ MQTT và ID/key thiết bị. Build: `pio run -e esp32dev`.

| Thành phần | GPIO |
|---|---|
| pH / TDS / độ đục | 34 / 32 / 35 |
| DS18B20 DATA | 27 |
| Relay rút / cấp / đèn / dự phòng | 18 / 19 / 21 / 22 |

Relay mặc định **HIGH bật, LOW tắt**; chọn chế độ kích HIGH tương ứng trên module. Đèn 6 V và bơm dùng nguồn tải qua COM–NO, không cấp tải từ GPIO.

## Lịch đèn và giữ ấm

Trong **Thiết lập bể → Đèn hằng ngày & giữ ấm**, đặt giờ bật/tắt, múi giờ, hai ngưỡng nhiệt độ và lưu cấu hình. Mẫu lịch 08:00–16:00, UTC+7; mặc định tự động đèn chưa bật. Có thể lưu đèn khi chưa khai báo thể tích bể.

Đèn bật khi lịch hoặc nhiệt độ yêu cầu. Giữ ấm mặc định bật dưới 24 °C, ngừng yêu cầu từ 25 °C; dữ liệu nhiệt độ mất hợp lệ quá 30 giây sẽ bỏ yêu cầu giữ ấm. Hiệu quả truyền nhiệt phụ thuộc đèn và bể.

ESP32 đồng bộ giờ từ máy chủ MQTT hoặc NTP. Sau đồng bộ, lịch chạy khi mất mạng nếu ESP32 vẫn có nguồn. Sau mất điện, lịch chờ đồng bộ giờ lại vì mạch chưa có RTC dùng pin; cấu hình vẫn lưu trong NVS. Giữ ấm không cần giờ mạng.

Lệnh bật tay ưu tiên đến hết hẹn giờ rồi trở lại tự động. **Tắt/Tắt tất cả** tạm ngưng đèn tự động 60 phút trong phiên hoạt động; muốn tắt lâu dài, bỏ cả lịch và giữ ấm rồi lưu.

## Kiểm tra phần mềm

```powershell
npm.cmd test
npm.cmd run test:multi
npm.cmd run test:admin
npm.cmd run test:water
npm.cmd run test:lighting
npm.cmd run test:telegram
npm.cmd run test:telegram-control
npm.cmd run test:e2e
npm.cmd run check:ui
npm.cmd run test:firmware
```

Test firmware trên máy cần `g++` hoặc biến `CXX` và quyền chạy binary được tạo. Test dùng DB/cổng riêng; không chạy simulator cùng danh tính với ESP32 thật.

## Cấu trúc bàn giao

```text
firmware/aquarium-node/  Sketch, cảm biến, điều khiển đèn và nước
server/                 HTTP, MQTT, SQLite, xác thực và Telegram
public/                 Giao diện Web và tài nguyên
tests/                 Kiểm thử phần mềm và C++
tools/                  Simulator, kiểm tra UI, tạo manifest
docs/                   Hướng dẫn và giao thức
BAO_CAO_KY_THUAT.md      Báo cáo kỹ thuật
MANIFEST.sha256         Mã băm tệp bàn giao
```

Gói nộp không chứa `.env`, `local-config.h`, DB thực, cache, log hoặc `node_modules/`. Cài phụ thuộc bằng lockfile.
