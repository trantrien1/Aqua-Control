# Aqua Control

**Hệ thống giám sát và điều khiển bể cá thông minh**

Aqua Control kết hợp ESP32, cảm biến chất lượng nước và giao diện Web để hỗ trợ theo dõi, chăm sóc bể cá. Người dùng có thể quan sát các chỉ số, điều khiển bơm và đèn, thiết lập lịch hoạt động, đồng thời nhận thông báo qua Telegram.

## Chức năng

- **Theo dõi chất lượng nước:** hiển thị nhiệt độ, pH, TDS và độ đục tương đối; cập nhật trạng thái theo ngưỡng của từng bể.
- **Lịch sử và biểu đồ:** lưu các lần đo, biểu diễn diễn biến theo thời gian và ghi nhận hoạt động điều khiển.
- **Điều khiển bơm:** bật/tắt bơm rút nước, bơm cấp nước và thay nước theo tỷ lệ thể tích. Hai bơm hoạt động luân phiên.
- **Thay nước tự động:** thay 20% khi thông số vượt ngưỡng đã đặt, chờ ổn định và đánh giá lại, tối đa ba lượt trong một đợt.
- **Lịch chiếu sáng:** đặt giờ bật/tắt hằng ngày, hỗ trợ lịch qua nửa đêm và lựa chọn múi giờ.
- **Giữ ấm bằng đèn:** bật đèn khi nhiệt độ thấp, với ngưỡng bật và ngừng giữ ấm riêng biệt.
- **Thông báo Telegram:** nhận cảnh báo, xem tình trạng bể và gửi lệnh điều khiển từ điện thoại.
- **Quản lý nhiều bể:** mỗi tài khoản sử dụng các bể thuộc quyền sở hữu, với cấu hình và liên kết Telegram riêng.

## Thành phần hệ thống

| Thành phần | Vai trò |
|---|---|
| ESP32 | Đọc cảm biến, điều khiển relay và thực hiện lịch tại thiết bị |
| DS18B20 | Đo nhiệt độ nước |
| Cảm biến pH, TDS và độ đục | Theo dõi các đặc tính của nước |
| Module relay | Đóng/ngắt hai bơm và đèn |
| Máy chủ Aqua Control | Kết nối thiết bị, lưu dữ liệu, cung cấp Web và Telegram |
| Trình duyệt Web | Theo dõi, cấu hình và điều khiển bể |

ESP32 trao đổi dữ liệu với máy chủ bằng MQTT qua Wi-Fi. Trình duyệt nhận dữ liệu từ máy chủ và cập nhật trực tiếp. Lịch đèn, ngưỡng và cấu hình bể được lưu trên ESP32 để phục vụ điều khiển tại chỗ.

## Cấu trúc thư mục

```text
Aqua-Control/
├── firmware/aquarium-node/   Chương trình ESP32
├── public/                  Giao diện Web, hình ảnh và phông chữ
├── server/                  Máy chủ và kết nối Telegram
├── .env.example             Mẫu thiết lập máy chủ
├── package.json             Thông tin ứng dụng
├── package-lock.json        Danh sách thư viện
├── platformio.ini           Thiết lập board ESP32
└── README.md                Giới thiệu và hướng dẫn sử dụng
```

## Cài đặt và khởi động

Máy tính chạy máy chủ cần cài **Node.js từ 22.5.0 trở lên**. ESP32 và máy tính cần có kết nối mạng tới nhau; Telegram sử dụng kết nối Internet của máy chủ.

### 1. Thiết lập máy chủ

Giải nén dự án, mở PowerShell tại thư mục có `package.json`, chạy:

```powershell
Copy-Item .env.example .env
npm.cmd ci
```

Mở `.env`, đặt mật khẩu quản trị tại `ADMIN_PASSWORD`. Các thiết lập chính:

| Thiết lập | Ý nghĩa | Giá trị mẫu |
|---|---|---|
| `PORT` | Cổng truy cập Web | `3000` |
| `MQTT_PORT` | Cổng kết nối ESP32 | `1883` |
| `ADMIN_PASSWORD` | Mật khẩu quản trị ban đầu | Người sử dụng tự đặt |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram | Điền khi sử dụng Telegram |
| `PUBLIC_URL` | Địa chỉ Web dùng trong tin nhắn | `http://192.168.1.10:3000` |

Khởi động ứng dụng:

```powershell
npm.cmd start
```

Trên máy chủ, truy cập **http://localhost:3000**. Điện thoại hoặc máy tính khác trong cùng mạng sử dụng `http://<IP-máy-chủ>:3000`.

Nếu sử dụng Docker, sau khi thiết lập `.env`, có thể khởi động hệ thống bằng `docker compose up -d --build`. Dữ liệu được lưu trong volume `aquarium-data` giữa các lần khởi động.

### 2. Tạo tài khoản và thêm bể

1. Đăng nhập bằng tài khoản `admin` và mật khẩu đã đặt trong `.env`.
2. Vào trang quản trị, tạo tài khoản sử dụng.
3. Đăng nhập tài khoản vừa tạo và chọn **Thêm bể**, hoặc nhận bể được quản trị viên cấp.
4. Lưu **ID thiết bị** và **khóa thiết bị** khi được hiển thị để cấu hình ESP32.

Tài khoản quản trị dùng cho việc quản lý tài khoản và cấp phát thiết bị. Tài khoản sử dụng dùng để theo dõi và điều khiển bể.

### 3. Thiết lập ESP32

Sao chép mẫu cấu hình:

```powershell
Copy-Item firmware/aquarium-node/local-config.example.h firmware/aquarium-node/local-config.h
```

Điền thông tin trong `local-config.h`:

| Trường | Nội dung |
|---|---|
| `AQUA_WIFI_SSID` | Tên mạng Wi-Fi 2,4 GHz |
| `AQUA_WIFI_PASSWORD` | Mật khẩu Wi-Fi |
| `AQUA_MQTT_HOST` | IP hoặc hostname máy chủ |
| `AQUA_DEVICE_ID` | ID thiết bị đã được cấp |
| `AQUA_DEVICE_KEY` | Khóa tương ứng của thiết bị |

Địa chỉ MQTT chỉ gồm IP/hostname, chẳng hạn `192.168.1.10`. Cổng mặc định là `1883`.

**Arduino IDE:** mở `firmware/aquarium-node/aquarium-node.ino`, chọn board **ESP32 Dev Module** và cổng kết nối. Cài các thư viện **PubSubClient**, **ArduinoJson 7**, **OneWire**, **DallasTemperature**, sau đó chọn Upload. Giữ các tệp trong thư mục sketch cùng nhau.

**PlatformIO:** mở thư mục dự án có `platformio.ini`, chọn môi trường `esp32dev` và Upload. Cấu hình board và thư viện đã được khai báo sẵn.

### 4. Kết nối phần cứng

| Thiết bị | GPIO ESP32 | Kết nối |
|---|---|---|
| pH | 34 | Tín hiệu analog qua chia áp 10 kΩ/10 kΩ |
| TDS | 32 | Tín hiệu analog, module dùng nguồn 3V3 theo cấu hình mạch |
| Độ đục | 35 | Tín hiệu analog qua chia áp 10 kΩ/10 kΩ |
| DS18B20 | 27 | DATA kéo lên 3V3 bằng điện trở 4,7 kΩ |
| Bơm rút nước | 18 | Relay IN1 |
| Bơm cấp nước | 19 | Relay IN2 |
| Đèn 6 V | 21 | Relay IN3 |
| Kênh dự phòng | 22 | Relay IN4, giữ tắt |

Relay được điều khiển **HIGH để bật, LOW để tắt**; chọn chế độ kích tương ứng trên module. Bơm và đèn sử dụng nguồn tải phù hợp qua tiếp điểm **COM–NO** của relay. GPIO chỉ nối tới đầu vào điều khiển module.

## Sử dụng giao diện Web

### Theo dõi bể

Chọn bể ở đầu trang để xem thông số hiện tại, tình trạng kết nối, ngưỡng và biểu đồ lịch sử. Phần nhật ký ghi nhận cảnh báo và các thao tác điều khiển.

pH có chế độ tham chiếu cố định hoặc hiệu chuẩn hai điểm. TDS được tính từ điện áp cảm biến và bù nhiệt; độ đục hiển thị tỷ lệ tương đối theo mốc nước trong. Chi tiết phương pháp xuất hiện tại thẻ cảm biến.

### Thiết lập và thay nước

Trong **Thiết lập bể**, nhập lượng nước thực tế từ 1 đến 500 lít, điều chỉnh ngưỡng rồi chọn **Lưu cấu hình bể**. Khi trạng thái hiển thị **ESP32 đã áp dụng**, cấu hình đã được thiết bị xác nhận.

Chọn tỷ lệ thay từ 1 đến 50% và nhấn **Thay nước**. Chu trình gồm rút nước, chuyển bơm, cấp nước và chờ ổn định 60 giây. Thời gian mỗi bơm được tính theo lưu lượng khai báo 96 lít/giờ. Ví dụ bể 50 lít, thay 20% tương ứng 10 lít mỗi chiều, khoảng 375 giây cho mỗi bơm.

Bật **Tự thay nước khi bất thường** để thiết bị thực hiện chu trình theo ngưỡng đã lưu. Chuẩn bị nước cấp, đường xả và đối chiếu lưu lượng thực tế trước khi sử dụng tự động.

### Lịch đèn và giữ ấm

Trong **Đèn hằng ngày & giữ ấm**:

1. Bật lịch, chọn giờ bật/tắt và múi giờ; ví dụ **08:00–16:00, UTC+7**.
2. Chọn giữ ấm nếu cần; ví dụ bật khi dưới **24 °C**, ngừng yêu cầu giữ ấm từ **25 °C**.
3. Lưu cấu hình và đợi thiết bị xác nhận.

Đèn bật khi lịch chiếu sáng hoặc nhiệt độ yêu cầu. Lịch **22:00–06:00** hoạt động qua nửa đêm. Hiệu quả giữ ấm phụ thuộc loại đèn, công suất và thể tích bể.

Sau khi đồng bộ giờ, lịch tiếp tục khi mất mạng và ESP32 vẫn được cấp nguồn. Khi cấp nguồn lại, thiết bị đồng bộ giờ trước khi áp dụng lịch; các mốc giờ đã lưu vẫn được giữ. Chức năng giữ ấm sử dụng nhiệt độ đo tại thiết bị.

Lệnh bật tay được ưu tiên đến hết thời lượng rồi trở lại tự động. **Tắt** hoặc **Tắt tất cả** tạm ngưng đèn tự động 60 phút trong phiên hoạt động. Để ngừng tự động lâu dài, tắt cả lịch và giữ ấm rồi lưu cấu hình.

## Kết nối Telegram

1. Tạo bot qua **@BotFather** trên Telegram và nhận token.
2. Điền token vào `TELEGRAM_BOT_TOKEN` trong `.env`, đặt `PUBLIC_URL` thành địa chỉ Web của hệ thống và khởi động lại máy chủ.
3. Đăng nhập Web, chọn **Liên kết Telegram** để nhận mã.
4. Mở bot và gửi `/start <mã>` trong vòng 15 phút.
5. Chọn **Gửi thử** trên Web để xác nhận liên kết.

| Lệnh | Chức năng |
|---|---|
| `/be`, `/chonbe <id>` | Xem danh sách và chọn bể |
| `/status`, `/cam_bien` | Xem tình trạng và số đo |
| `/nuoc`, `/nguong` | Xem cấu hình nước và ngưỡng |
| `/bomvao 10`, `/rutnuoc 10` | Chạy bơm tương ứng 10 giây |
| `/den bat 60`, `/den tat` | Bật đèn 60 giây hoặc tắt |
| `/thaynuoc 20` | Thay 20% lượng nước |
| `/dung` | Dừng chu trình và tắt các kênh |
| `/tudong bat`, `/tudong tat` | Bật/tắt tự thay nước |
| `/tat 45`, `/bat` | Tạm ngưng thông báo 45 phút hoặc bật lại |
| `/stop` | Ngắt liên kết Telegram |
| `/help` | Xem hướng dẫn lệnh |

Thông báo được gửi đến chủ bể đã liên kết, theo mức ngưỡng đã đặt. Lịch đèn và ngưỡng giữ ấm được điều chỉnh trên Web.

## Lưu dữ liệu

Thông số đo, cấu hình và nhật ký được lưu trong thư mục `data/` khi ứng dụng hoạt động. Giữ thư mục này để tiếp tục sử dụng tài khoản và lịch sử giữa các lần khởi động. Cấu hình bể và lịch đèn được lưu riêng trong bộ nhớ ESP32.
