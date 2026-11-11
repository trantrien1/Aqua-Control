# Aqua Control — bể cá ESP32

Bản hiện tại **2.2**: đo nhiệt độ, pH, TDS, điện áp độ đục; điều khiển thủ công
**bơm tăng pH, bơm hạ pH và đèn 6 V** qua MQTT.

**Hướng dẫn đầy đủ: [readmev2.md](readmev2.md)** — sơ đồ chân, cấu hình Wi-Fi,
nạp bằng Arduino IDE hoặc VS Code + PlatformIO, thử relay/hiệu chuẩn và xử lý lỗi.

| Relay | Chức năng | GPIO |
|---|---|---|
| IN1 | Bơm tăng pH | 18 |
| IN2 | Bơm hạ pH | 19 |
| IN3 | Đèn 6 V | 21 |
| IN4 | Dự phòng, giữ tắt | 22 |

Cảm biến giữ chân pH34, TDS32, độ đục35, DS18B20 27.
Hai bơm liên động, đèn độc lập; có giới hạn thời gian và test 3 giây.

```powershell
npm.cmd ci --cache .npm-cache
npm.cmd start
```

Mở http://localhost:3000, mật khẩu mặc định `beca123` hoặc giá trị trong `.env`.
Server có broker MQTT nhúng cổng 1883. Máy tính và ESP32 phải liên lạc được trong LAN.

Firmware để nạp: `firmware/aquarium-node/aquarium-node.ino`.
Kiểm tra SSID/mật khẩu Wi-Fi và IP LAN server trước khi nạp.

```powershell
npm.cmd test
npm.cmd run sim
```

Simulator mặc định mô phỏng bốn cảm biến + ba relay. Dừng simulator trước khi dùng
ESP32 thật. Giao thức chi tiết trong [docs/api.md](docs/api.md).

