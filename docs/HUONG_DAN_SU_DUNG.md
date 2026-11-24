# Hướng dẫn sử dụng Aqua Control 4.0

## 1. Máy chủ và tài khoản

Cài Node.js từ 22.5.0, mở terminal tại thư mục `package.json`, tạo `.env` từ mẫu khi chưa có. Đặt `ADMIN_PASSWORD`, chạy `npm.cmd ci`, `npm.cmd start`, mở `http://localhost:3000`. Docker dùng `docker compose up -d --build`.

Quản trị tạo khách tại `/admin`; khách thêm bể hoặc nhận thiết bị được cấp. Lưu ID/key khi hiển thị. MQTT dùng ID/key riêng, không dùng mật khẩu Web. ESP32 và máy chủ phải liên lạc được qua TCP 1883; máy chủ phải có Internet để dùng Telegram.

## 2. ESP32 và đấu nối

Tạo `firmware/aquarium-node/local-config.h` từ mẫu nếu chưa có; điền `AQUA_WIFI_SSID`, `AQUA_WIFI_PASSWORD`, `AQUA_MQTT_HOST`, `AQUA_DEVICE_ID`, `AQUA_DEVICE_KEY`. Host là IP/hostname, không có URL hay số cổng. Mã mặc định dùng Wi-Fi 2,4 GHz và MQTT TCP 1883.

Arduino IDE mở `aquarium-node.ino`; giữ các header và `.cpp` cạnh sketch. PlatformIO build bằng `pio run -e esp32dev`. Không erase flash khi cần giữ NVS. Relay HIGH bật/LOW tắt, đấu module kích HIGH tương ứng; tải qua COM–NO và nguồn riêng phù hợp.

Serial 115200 baud + Newline: `t1`, `t2`, `t3` thử từng relay 3 giây; `off` tắt tất cả; `status` xem relay; `sensors` chẩn đoán khi bơm đã dừng.

DS18B20 DATA GPIO27 kéo lên 3V3 bằng 4,7 kΩ. pH GPIO34 và độ đục GPIO35 qua chia áp 10k/10k. TDS GPIO32 theo mạch dùng nguồn 3V3. Sơ đồ đầy đủ trong [báo cáo](../BAO_CAO_KY_THUAT.md).

## 3. Cảm biến và hiệu chuẩn

pH có chế độ tham chiếu cố định và hai điểm. Dùng dung dịch chuẩn pH 7,00 gửi `ph7`, chuẩn 4,00 gửi `ph4`, kiểm tra `phstatus`, rồi chọn `phmode calibrated`. Rửa đầu dò giữa dung dịch, giữ nguyên biến trở/chia áp. `phfilter off/on` hỗ trợ quan sát; `phmode estimated` chọn lại tham chiếu; `resetph` xóa mốc.

TDS tính theo điện áp có bù nhiệt DS18B20. Độ đục dùng phần trăm sụt tín hiệu so với mốc nước trong, không biểu diễn NTU. Chi tiết cảm biến và Telegram `/cam_bien` cho biết ADC, chế độ đo và dữ liệu không hợp lệ.

## 4. Lịch đèn và giữ ấm

1. Vào **Thiết lập bể → Đèn hằng ngày & giữ ấm**.
2. Bật lịch và chọn giờ khác nhau: ví dụ `08:00`–`16:00`, hoặc `22:00`–`06:00` qua nửa đêm.
3. Chọn múi giờ; Việt Nam UTC+7.
4. Bật giữ ấm nếu cần, ví dụ bật dưới 24 °C và ngừng yêu cầu từ 25 °C; hai ngưỡng cách nhau ít nhất 0,1 °C.
5. **Lưu cấu hình bể**, đợi **ESP32 đã áp dụng**. Chỉ dùng đèn thì có thể để trống thể tích bể.

Đèn bật nếu lịch hoặc nhiệt độ yêu cầu. Đạt ngưỡng nhiệt tắt nhưng vẫn trong lịch thì đèn còn sáng. Ra ngoài lịch nhưng nước lạnh thì đèn có thể sáng để giữ ấm. Hiệu quả truyền nhiệt phụ thuộc loại/công suất đèn.

ESP32 nhận giờ từ máy chủ hoặc NTP, sau đó tự chạy khi mất mạng và vẫn có nguồn. Mất điện hoàn toàn làm mất giờ thực; lịch chờ đồng bộ sau khi bật lại, cấu hình vẫn còn. Giữ ấm dùng DS18B20 tại chỗ. Muốn giữ giờ qua mất điện phải bổ sung RTC dùng pin.

Bật tay ưu tiên đến hết thời lượng rồi về tự động. Tắt đèn, `/den tat`, `/dung`, **Tắt tất cả** và Serial `off` tạm ngưng tự động đèn 60 phút. Ưu tiên tay không lưu qua reboot; muốn tắt lâu dài thì tắt cả hai lựa chọn tự động và lưu.

## 5. Thay nước

Nhập lượng nước thực 1–500 L và ngưỡng, đợi đồng bộ. Thay thủ công 1–50% hoặc tự động 20% khi ngoài ngưỡng. Chu trình: rút → chuyển 1 giây → cấp → chờ ổn định 60 giây. Lưu lượng khai báo 96 L/h mỗi chiều cần đối chiếu đường nước thực.

Tối đa ba lượt tự động mỗi đợt; ba mẫu an toàn liên tiếp có thể trở lại sẵn sàng. Lỗi/gián đoạn yêu cầu đặt lại theo giao diện, kiểm tra mực nước khi được yêu cầu. Chu trình đã chạy tiếp tục do ESP32 quản lý khi mất MQTT; phao và siêu âm đang tắt.

## 6. Telegram

Tạo bot bằng `@BotFather`, đặt `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` trong môi trường máy chủ rồi khởi động lại. Khách chọn **Liên kết Telegram** trên Web và gửi `/start <mã>` cho bot trong 15 phút; bấm **Gửi thử** để kiểm tra.

| Lệnh | Chức năng |
|---|---|
| `/be`, `/chonbe <id>` | Xem/chọn bể |
| `/status`, `/cam_bien`, `/nuoc`, `/nguong` | Theo dõi dữ liệu/cấu hình |
| `/bomvao 10`, `/rutnuoc 10` | Bơm 10 giây |
| `/den bat 60`, `/den tat` | Bật tay 60 giây / tắt và tạm ngưng tự động |
| `/thaynuoc 20`, `/dung` | Thay 20% / dừng chu trình và tắt relay |
| `/tudong bat`, `/tudong tat` | Tự thay nước |
| `/datlai`, `/datlai XACNHAN` | Đặt lại theo tình trạng chu trình |
| `/tat 45`, `/bat` | Tắt cảnh báo 45 phút / bật lại |
| `/stop` | Ngắt liên kết, không dừng bơm |
| `/web`, `/help` | Link Web, hướng dẫn |

Chỉnh lịch đèn/ngưỡng giữ ấm trên Web. Telegram kiểm tra lại quyền từng thao tác; sau khởi động lại bot, tài khoản nhiều bể cần chọn bể lại. Lệnh gửi thành công cần đợi ESP32 xác nhận.

## 7. Sao lưu và bảo mật cấu hình

Dùng backup SQLite nhất quán hoặc dừng máy chủ trước khi sao chép DB. Docker lưu tại volume `aquarium-data`. Không đưa DB thật, token, mật khẩu Wi-Fi và khóa thiết bị vào gói nộp. HTTP/MQTT mặc định dành cho mạng LAN; triển khai rộng cần HTTPS, MQTT TLS và ACL phù hợp.
