# Kiểm tra pH PH-4502C

Điện áp ADC thay đổi thì pH tính ra cũng thay đổi. Ví dụ công thức ước tính hiện
tại dùng mốc 1,831 V và hệ số −0,10 V/pH: 2,04 V sẽ thành khoảng pH 4,91.
Đây là mốc giả định từ nước trước đó, không phải hiệu chuẩn bằng dung dịch chuẩn.
Không đổi mốc theo mỗi log để ép nước về pH 7. Nước sạch và giấm ăn chưa biết pH
không dùng làm hai điểm chuẩn. Bộ lọc chỉ giảm dao động, không sửa độ lệch.

## Thử tách nguồn gây nhiễu trước

1. Tạm tắt thay nước tự động trên web và dừng bơm/đèn trong lúc thử.
2. Lấy mẫu nước ra cốc sạch, chỉ nhúng đầu dò pH; giữ khô board và đầu nối BNC.
   Để đầu dò TDS ngoài cốc và ngắt nguồn module TDS khi đã tắt nguồn hệ thống.
   Cấp lại nguồn ESP32 và module pH, giữ nguyên biến trở và cách chia áp hiện tại.
3. Mở Serial Monitor 115200, chọn Newline. Gửi `phstatus`, rồi `phfilter off`.
   Lệnh tắt lọc chỉ bỏ bộ lọc thời gian; từng lần đọc ADC vẫn lấy trung vị 31 mẫu.
   Đợi điện áp ổn định và lưu khoảng 10–20 dòng ADC.
4. So sánh với lúc TDS cùng được cấp nguồn và cùng ngâm trong mẫu; thay một yếu
   tố mỗi lần, tránh di chuyển đầu dò pH hoặc vặn biến trở. Nếu điện áp đổi rõ
   khi thêm TDS, kiểm tra nhiễu/cách ly nguồn và tín hiệu. Nếu chỉ pH vẫn trôi,
   kiểm tra tiếp nguồn cấp, đầu nối, đầu dò và board; chưa kết luận hỏng bộ phận nào.
5. Gửi `phfilter on` để bật lại lọc. Lựa chọn này không lưu qua khởi động.

Việc code đọc pH rồi TDS tuần tự không ngăn tín hiệu điện từ đầu dò TDS đang
được cấp nguồn đi vào cùng dung dịch. Không cấp module cảm biến trực tiếp từ GPIO.

## Hiệu chuẩn khi có dung dịch chuẩn

Giữ nguyên cấu hình nguồn, chia áp và biến trở. Xử lý nguồn gây nhiễu trước.
Tráng đầu dò giữa hai dung dịch, tránh mang giấm/nước mẫu vào chai dung dịch chuẩn.

1. Nhúng vào dung dịch chuẩn pH 7,00; chờ ADC ổn định, gửi `ph7`.
2. Tráng đầu dò, nhúng vào chuẩn pH 4,00; chờ ADC ổn định, gửi `ph4`.
3. Gửi `phstatus`, kiểm tra V7/V4 khác nhau và đúng hai dung dịch vừa đo.
4. Gửi `phmode calibrated` để kích hoạt; hai mốc và chế độ được lưu trong NVS.
5. Đo lại cả hai dung dịch để kiểm tra, rồi bật lại lọc nếu đã tắt.

Công thức dùng hai điện áp thực đo tại GPIO34, sau mạch chia áp:

```text
pH = 7 + (Vadc − V7) × (4 − 7) / (V4 − V7)
```

Firmware chấp nhận cả hai chiều dốc, từ chối mốc ngoài dải quy đổi hoặc quá gần
nhau. `phmode estimated` quay về ước tính; `resetph` xóa hai mốc đã lưu.
Các mốc cũ không tự kích hoạt: phải chọn `phmode calibrated`. Sau khi vặn biến
trở hay đổi mạch chia áp, cần hiệu chuẩn lại. Không gửi `ph7` bằng nước máy hay
`ph4` bằng giấm ăn để làm số đo trông hợp lý.

Web hiển thị “Ước tính” khi chưa chọn hiệu chuẩn hai điểm. Telegram `/cam_bien`
báo chế độ tương ứng. Cập nhật firmware không tự tắt cấu hình tự động đang lưu;
người vận hành chủ động tắt trong lúc kiểm tra và bật lại sau khi xác minh số đo.

## Build và nạp

`pio run` tạo `.pio/build/esp32dev/firmware.bin`. Mã chính nằm ở
`firmware/aquarium-node/aquarium-node.cpp`; `.ino` cùng thư mục là sketch để mở
bằng Arduino IDE, IDE biên dịch cả `.cpp`. PlatformIO biên dịch `.cpp` trực tiếp,
không phụ thuộc tệp `.ino.cpp` tạm. Giữ `.cpp` và các header cạnh sketch.
Wi-Fi/MQTT riêng nằm trong `local-config.h`. Không erase flash nếu muốn giữ NVS.

## Tài liệu đối chiếu

- [DFRobot: nhiễu giữa pH và cảm biến độ dẫn, cách ly nguồn và tín hiệu](https://wiki.dfrobot.com/dfr0504/docs/19034).
  Đây là cơ chế tham khảo; chưa chứng minh hệ thống hiện tại bị nhiễu TDS.
- [DFRobot: quy trình hai điểm pH 4 và 7](https://wiki.dfrobot.com/sen0161-v2/docs/20941).
  Module khác PH-4502C, nên không sao chép hệ số chuyển đổi của DFRobot sang board này.
