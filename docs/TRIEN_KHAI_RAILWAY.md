# Triển khai máy chủ Aqua Control từ xa

Một tiến trình Node.js chạy Express, MQTT và bot Telegram. SQLite cần ổ bền vững. Dockerfile của dự án có thể dùng trên Railway hoặc máy chủ tương đương.

## Cấu hình

- Gắn volume tại `/app/data` khi dùng Dockerfile.
- Đặt `ADMIN_PASSWORD` trước lần chạy đầu; dùng `SESSION_SECRET` riêng hoặc giữ file bí mật trong volume.
- Bật `EMBEDDED_BROKER=true`, cấu hình MQTT qua `MQTT_PORT`.
- Đặt `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` là URL HTTPS của Web.
- HTTP đọc cổng `PORT`; thiết bị cần đường TCP đến broker, không dùng URL HTTP làm MQTT host.
- Chỉ chạy một tiến trình long polling cho mỗi bot token.

## ESP32

Nếu hạ tầng cung cấp TCP proxy, điền hostname/cổng thực vào firmware. MQTT TLS cần broker hoặc điểm kết thúc TLS và CA phù hợp; broker nhúng là TCP thuần. Dùng mạng riêng hoặc cấu hình TLS/ACL khi triển khai từ xa.

Firmware mặc định cổng 1883; cổng ngoài khác thì sửa `MQTT_PORT` trong sketch. `AQUA_MQTT_HOST` chỉ chứa hostname. ID/key phải trùng thiết bị được cấp trên Web.

## Kiểm tra

Kiểm tra `/api/health`, đăng nhập, dữ liệu sau restart, thiết bị online và revision đồng bộ. Thử Telegram, SSE, lịch đèn. Không chạy simulator và ESP32 chung danh tính. Lịch tiếp tục khi ESP32 đã đồng bộ giờ, mất mạng và vẫn có nguồn.

Sao lưu SQLite nhất quán, giữ volume khi cập nhật. Tài nguyên và chi phí phụ thuộc gói dịch vụ tại thời điểm triển khai.
