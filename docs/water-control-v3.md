# Điều khiển nước — firmware và web

Phiên bản này thay hai bơm pH bằng **bơm nước ra / bơm nước vào**, giữ đăng nhập,
quản trị khách hàng, danh tính MQTT, lịch sử, SSE và Telegram riêng từng tài khoản.
`platformio.ini` hiện biên dịch **firmware/aquarium-node/**. Toàn bộ header đã được đưa
vào cùng thư mục sketch. Có thể xóa thư mục tham khảo `firmware-v2` mà không ảnh hưởng build.

## Cách dùng trên web

1. Đăng nhập, chọn đúng bể ở đầu trang.
2. Trong **Mỗi bể, một cấu hình**, nhập lượng nước thực tế (1–500 lít).
3. Mở **Tinh chỉnh ngưỡng an toàn** để sửa bốn thông số: nhiệt độ, pH, TDS, độ đục tương đối.
4. Bấm **Lưu cấu hình bể**. Chờ nhãn **ESP32 đã áp dụng** trước khi bật bơm hoặc thay nước.
5. Để điều khiển riêng, chọn **Bật có hẹn giờ** trên bơm ra, bơm vào hoặc đèn.
   Chọn thời lượng có sẵn hoặc nhập từ 1–3600 giây; hết giờ thiết bị tự tắt.
   Hai bơm liên động, đèn độc lập. Có thể bấm **Tắt** hoặc **Tắt tất cả**.
6. Để thay nước, nhập phần trăm nguyên 1–50%, hoặc chọn nhanh 10 / 20 / 50%.
   Web hiển thị số lít, thời gian mỗi bơm và tổng thời gian. Bấm **Thay nước**,
   kiểm tra thông tin trong hộp xác nhận rồi **Bắt đầu thay nước**.

Mọi cấu hình gắn với thiết bị và được lưu SQLite, không dùng chung giữa các khách.
Máy chủ gửi cấu hình retained qua `aquarium/<id>/config`; ESP32 lưu NVS và báo lại
`settings_revision`. Chỉ lưu tại máy chủ chưa có nghĩa ESP32 đã áp dụng.
Khi bơm/chu trình đang chạy, hệ thống từ chối thay cấu hình để không đổi thời gian giữa chừng.

## Tính thể tích và thời gian

Lưu lượng danh định của **mỗi bơm** là 96 lít/giờ = 1,6 lít/phút.

```
lượng cần thay (lít) = thể tích bể × phần trăm / 100
thời gian mỗi bơm (giây) = lượng cần thay / 96 × 3600
tổng thời gian ≈ thời gian mỗi bơm × 2 + 1 giây chuyển + 60 giây ổn định
```

Ví dụ bể 60 lít, thay 20%: rút 12 lít trong 450 giây, ngắt cả hai bơm 1 giây,
bơm vào 12 lít trong 450 giây, rồi chờ 60 giây để lấy số đo mới.
Thực tế phụ thuộc cột áp, ống và nguồn điện; hiện hệ thống ước tính bằng thời gian,
chưa đo lưu lượng hay thể tích thực. Cảm biến mực nước và phao đang tắt theo firmware gốc.

## Tự thay khi bất thường

Mặc định **tắt**, không chạy cho đến khi đã có thể tích bể hợp lệ và người dùng
tích **Tự thay nước khi bất thường**, lưu cấu hình và được ESP32 xác nhận.

- Bất kỳ thông số đang giám sát ra ngoài min/max an toàn sẽ kích hoạt thay **20%**.
- Rút → nghỉ chuyển 1 giây → bơm vào → chờ ổn định tối thiểu **60 giây** và có số đo mới hợp lệ.
- Nếu vẫn ngoài ngưỡng, tiếp tục tối đa **3 lần trong một đợt**. Mỗi lần là 20% thể tích bể,
  không phải cộng dồn thành 60% lượng nước ban đầu.
- Sau 3 lần còn xấu, khóa tự động. Ba mẫu mới liên tiếp trong ngưỡng sẽ mở lại;
  người dùng cũng có thể kiểm tra và xác nhận đặt lại trên web.
- Cảm biến không hợp lệ hoặc TDS đang dùng nhiệt độ dự phòng không được dùng để kích hoạt tự động.
- Trong khi rút/bơm vào, firmware ưu tiên thời gian relay và tạm dừng lấy mẫu cảm biến.
  Trạng thái chu trình vẫn gửi về web mỗi 5 giây.

Chu trình do ESP32 chạy tại chỗ, tiếp tục với cấu hình đã lưu khi mất MQTT. Các lệnh
bơm/đèn hẹn giờ riêng bị cắt sau tối đa 60 giây mất MQTT. Khi mất điện giữa chu trình,
ESP32 không tự chạy tiếp; nó giữ trạng thái lỗi qua khởi động lại. Bấm **Dừng chu trình**
cũng yêu cầu kiểm tra và cân bằng mực nước trước khi tích xác nhận và **đặt lại**.

## Các giá trị hiệu chuẩn giữ nguyên

`firmware/aquarium-node/sensor-estimates.h` và `water-sensors.h` giữ phương pháp hiện tại:

| Thông số | Giá trị |
|---|---|
| pH mốc nước tham chiếu | ADC **1,927 V → pH 7,00** |
| Hệ số pH tạm thời | **−0,10 V/pH** |
| Độ đục tương đối | OUT **3,272 V → 0%**; giảm điện áp được quy đổi theo % |
| Hệ số chia điện áp | **2,0** |
| Hệ số TDS | **1,0**, bù nhiệt DS18B20 |

Web hiển thị độ đục **% tương đối**, không gán thành NTU. Các mốc này được dùng
đúng như code bạn cung cấp. Ngưỡng mặc định độ đục là an toàn 0–30%, nguy hiểm ngoài 0–60%;
người dùng có thể sửa trên web. Hiệu chuẩn hai điểm pH/NVS cũ vẫn được giữ nhưng chế độ
tham chiếu cố định đang được bật như firmware-v2 gốc.

## Nạp ESP32

Thông tin mạng và danh tính được tách khỏi hiệu chuẩn trong `firmware/aquarium-node/local-config.h`.
Tệp này được Git và Docker bỏ qua. Có mẫu `local-config.example.h` để tạo cho máy khác:

```powershell
Copy-Item firmware/aquarium-node/local-config.example.h firmware/aquarium-node/local-config.h
```

Nếu `local-config.h` đã tồn tại, chỉnh tệp đó, không chép mẫu đè lên nó.

Điền `AQUA_WIFI_SSID`, `AQUA_WIFI_PASSWORD`, `AQUA_MQTT_HOST`, `AQUA_DEVICE_ID`,
`AQUA_DEVICE_KEY`. ID/key phải do mục **Quản trị → Cấp thiết bị** trên web cấp;
MQTT dùng ID làm username và key làm password. ESP32 dùng Wi-Fi 2,4 GHz.

Tại máy này đã chuẩn bị `local-config.h` bằng Wi-Fi từ firmware-v2 của bạn và
danh tính thiết bị thật đã có trong firmware cũ; không dùng chung danh tính với giả lập.

```powershell
# Nếu platformio đã ở PATH:
pio run
pio device list
pio run --target upload --upload-port COM5
pio device monitor --port COM5 --baud 115200

# Hoặc gọi trực tiếp bản đã cài trên máy này:
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run
```

Thay COM5 bằng cổng thực. Không dùng thao tác erase flash: nạp firmware bình thường
giữ các namespace NVS hiệu chuẩn và chốt chu trình. Arduino IDE: mở
`firmware/aquarium-node/aquarium-node.ino`, chọn ESP32 Dev Module, cài PubSubClient, ArduinoJson 7,
OneWire, DallasTemperature; giữ các header cùng sketch.

| Relay | GPIO | Chức năng |
|---|---|---|
| IN1 | 18 | Rút nước |
| IN2 | 19 | Bơm nước vào |
| IN3 | 21 | Đèn |
| IN4 | 22 | Luôn tắt |

Chân cảm biến: pH34, TDS32, độ đục35, DS18B20 27. Relay active-low, jumper L.
Thử bằng Serial `t1`, `t2`, `t3`, `off`, `status` trước khi gắn tải.

## Telegram và dữ liệu cũ

Không tạo lại tài khoản, thiết bị, key hoặc liên kết Telegram. Dữ liệu SQLite
được nâng lược đồ tại chỗ, thêm cấu hình bể và cột độ đục tương đối; các số đo cũ vẫn giữ.
`TELEGRAM_BOT_TOKEN` trong `.env` vẫn dùng như trước. Bên cạnh cảnh báo theo ngưỡng
của từng bể, bot thông báo khi bắt đầu thay nước, lỗi hoặc khóa chu trình.
Các lệnh `/start`, `/status`, `/tat`, `/bat`, `/stop` và nút **Gửi thử** vẫn giữ.
`/stop` Telegram là ngắt liên kết thông báo; dùng `/dung` hoặc web để dừng bơm.

## Điều khiển qua Telegram

Các lệnh mới được đăng ký vào menu Telegram khi máy chủ khởi động. Dùng tài khoản
đã liên kết, gửi `/be` rồi `/chonbe <mã_bể>` nếu có nhiều bể. Bot luôn kiểm tra lại
quyền sở hữu trước mỗi thao tác; chọn bể không cấp thêm quyền. Sau khi khởi động lại
bot, tài khoản có nhiều bể cần chọn lại để tránh điều khiển nhầm.

| Lệnh | Tác dụng |
|---|---|
| `/help` | Danh sách lệnh |
| `/be`, `/chonbe <mã_bể>` | Xem danh sách và chọn bể |
| `/cam_bien` | Số đo, ADC và chẩn đoán |
| `/nuoc`, `/nguong` | Cấu hình, revision, chu trình và ngưỡng |
| `/bomvao 10`, `/rutnuoc 10` | Bơm vào / rút trong 10 giây; giới hạn 1–3600 giây |
| `/den bat 60`, `/den tat` | Bật đèn 60 giây / tắt |
| `/thaynuoc 20` | Thay 20%; cho phép số nguyên 1–50% |
| `/dung` | Dừng chu trình, tắt cả bơm và đèn |
| `/tudong bat`, `/tudong tat` | Lưu trạng thái tự thay; chờ ESP32 xác nhận |
| `/datlai XACNHAN` | Đặt lại lỗi sau khi người dùng đã kiểm tra và cân bằng mực nước |
| `/web` | Địa chỉ web |

Bot trả “đã gửi lệnh”, không coi đó là ESP32 đã thực hiện. Thiết bị offline,
chưa cấu hình thể tích, chưa đồng bộ hoặc đang khóa kiểm tra mực nước vẫn bị chặn
như khi thao tác trên web. Nhật ký lưu tên tài khoản và nguồn Telegram.

## Đọc log khởi động và cảm biến

- `ph7v/ph4v NOT_FOUND`: thiếu hiệu chuẩn hai điểm tùy chọn. Chế độ cố định 1,927 V
  không dùng chúng; firmware hiện kiểm tra key trước khi đọc để tránh log lỗi không cần thiết.
- `interrupted-check-level`: NVS ghi nhận chu trình đã bị gián đoạn hoặc lỗi chưa được đặt lại.
  Không tự xoá chốt này. Sau khi kiểm tra, cân bằng mực nước, dùng web hoặc `/datlai XACNHAN`;
  Serial tương đương là `waterreset`.
- Server revision 0 nhưng ESP32 giữ revision 6: server chưa thiết lập bể/đang dùng dữ liệu cũ.
  Web báo xung đột thay vì gửi lặp cấu hình 0. Nhập lượng nước thực tế và ngưỡng, lưu lại;
  máy chủ sẽ cấp revision ít nhất 7. Thao tác này không tự bỏ chốt mực nước.
- `nan` là chưa có giá trị quy đổi hợp lệ, không phải kết luận mạch hỏng. Code hiện giữ
  dải tham chiếu của v2: ADC pH/đục tối đa 2,60 V; TDS 0,15–2,40 V. ADC pH 3,134 V
  không phù hợp mốc 1,927 V và hệ số −0,10 V/pH nên không thể đổi thành pH 0–14.
- `DS18B20 tim thay: 0`: lần dò tại GPIO27 chưa thấy cảm biến. Firmware tự dò lại
  mỗi 10 giây nếu chưa có nhiệt độ hợp lệ; không gán nhiệt độ giả.

Giữ nguyên chân của v2. Gửi `sensors` qua Serial 115200 + Newline khi bơm đã dừng
để dò lại DS18B20, in ADC raw 12-bit, điện áp và lý do chưa quy đổi. Không đổi mốc
hiệu chuẩn chỉ để làm mất `nan`, và không erase flash để xử lý xung đột revision.

## Kiểm thử

```powershell
npm.cmd run test:multi
npm.cmd run test:telegram
npm.cmd run test:telegram-control
npm.cmd run test:e2e
npm.cmd test
npm.cmd run test:water
npm.cmd run test:firmware  # Cần g++ hoặc đặt CXX
npm.cmd run check:ui
```

`test:water` chạy HTTP, SQLite, MQTT và simulator trên DB/cổng tạm; kiểm tra quyền,
validation, revision, đồng bộ ESP32, % thể tích, ACK, dừng/đặt lại và khởi động lại.
`test:firmware` biên dịch và chạy chính header C++ của firmware trên máy để kiểm tra
chuyển pha, khóa 3 lần, mất điện, tràn, quá giờ và công thức cảm biến.
