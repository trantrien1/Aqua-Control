# Triển khai Aqua-Control trên Railway (tất cả trong 1 service)

Mô hình: **1 service Railway** chạy cả web HTTPS, API, broker MQTT nhúng và SQLite
(volume). Không cần Vercel.

```
Trình duyệt ──HTTPS──> Railway (Node: Express + aedes + SQLite)
ESP32 ───────TCP────> Railway TCP Proxy :1883
```

## 0. Trước khi bắt đầu

- Tài khoản Railway (Trial/Hobby) đã liên kết GitHub.
- Repo đã push code mới nhất (có `Dockerfile` + `docker-entrypoint.sh`).
- Giới hạn Trial: 1 GB RAM, 2 vCPU, volume 0.5 GB, **$5 credit dùng một lần**.
  App chạy 24/7 tốn khoảng **$2–4/tháng** (RAM ~$1.5 + CPU/egress), nên credit
  sẽ hết sau vài tuần. Muốn chạy lâu dài cần Hobby $5/tháng.
- Nếu server Azure vẫn đang chạy cùng token Telegram, **phải tắt** trước khi
  Railway bật bot, nếu không sẽ bị `Conflict: terminated by other getUpdates request`.
  Chỉ tắt sau khi Railway đã chạy ổn:
  ```bash
  sudo systemctl stop aqua-control
  sudo systemctl disable aqua-control
  ```

## 1. Push code

```powershell
git add Dockerfile docker-entrypoint.sh server/config.js HUONG_DAN_RAILWAY.md
git commit -m "Chuẩn bị deploy Railway: entrypoint volume + PUBLIC_URL fallback"
git push
```

## 2. Tạo service trên Railway

1. Vào <https://railway.app> → **New Project** → **Deploy from GitHub repo** →
   chọn repo `Aqua-Control`, branch `main`.
2. Railway tự nhận `Dockerfile` và build.
3. **Settings → Deploy**:
   - Healthcheck Path: `/api/health`
   - Healthcheck Timeout: `120`
   - Restart Policy: `ON_FAILURE`
4. **Settings → Volumes → Add Volume**:
   - Mount path: `/app/data` (SQLite mặc định ở `/app/data/aquarium.db`)
   - Volume này giữ tài khoản, thiết bị, lịch sử đo qua các lần deploy.
   - `docker-entrypoint.sh` tự `chown` volume cho user `appuser`, không cần
     chạy container bằng root.

## 3. Biến môi trường

**Variables → Raw Editor**, dán (thay giá trị thật):

```ini
PORT=3000
HOST=0.0.0.0
MQTT_PORT=1883
EMBEDDED_BROKER=true
TZ=Asia/Ho_Chi_Minh

SESSION_SECRET=<chuỗi 64 ký tự hex, ví dụ openssl rand -hex 32>
ADMIN_PASSWORD=<mật khẩu admin bạn muốn dùng ngay từ lần đầu>

TELEGRAM_BOT_TOKEN=<token từ @BotFather>
TELEGRAM_NOTIFY_LEVEL=warn
TELEGRAM_REPEAT_WARN_MINUTES=30
TELEGRAM_REPEAT_CRITICAL_MINUTES=10
```

`PUBLIC_URL` không cần đặt: code tự dùng
`https://${{RAILWAY_PUBLIC_DOMAIN}}` khi chạy trên Railway. Nếu muốn domain
riêng thì đặt `PUBLIC_URL=https://ten-mien-cua-ban`.

> `ADMIN_PASSWORD` chỉ dùng khi tạo tài khoản `admin` lần đầu. Đặt đúng ngay
> trước lần deploy đầu — trang `/admin` hiện chỉ có chức năng thêm người dùng,
> không có chức năng đổi mật khẩu admin.

## 4. Lấy domain HTTPS

**Settings → Networking → Public Networking → Generate Domain** → nhận
`https://<ten>.up.railway.app`.

> Nếu không thấy nút Generate Domain: kiểm tra xem TCP Proxy đã bật chưa. Tài
> liệu Railway có chỗ ghi phải xoá TCP Proxy mới tạo được domain, nên hãy
> **tạo domain trước, bật TCP Proxy sau**.

Kiểm tra:

```powershell
curl.exe https://<ten>.up.railway.app/api/health
# {"ok":true,"uptimeSeconds":...,"brokerConnected":true}
```

## 5. Bật TCP Proxy cho MQTT

**Settings → Networking → TCP Proxy**:

- Internal port: `1883`
- Railway cấp địa chỉ dạng `roundhouse.proxy.rlwy.net:12345`

Địa chỉ này là **TCP trần, không TLS** — giống cổng 1883 hiện tại. DEVICE_KEY
và dữ liệu không được mã hoá trên đường truyền.

## 6. Cấu hình ESP32

1. Mở web Railway → đăng nhập `admin` → tự chuyển tới `/admin`.
2. Tạo tài khoản khách (tên + mật khẩu).
3. Vẫn ở `/admin`, bấm **Cấp thiết bị** → chọn khách, nhập tên bể → nhận
   `DEVICE_ID` và `DEVICE_KEY` (khoá chỉ hiện một lần). Admin **không** xem
   được dữ liệu bể.
4. Khách vẫn có thể tự bấm **Thêm bể** trong tài khoản của mình nếu muốn.
5. Sửa `firmware/aquarium-node/local-config.h`:

```cpp
#define WIFI_SSID      "..."
#define WIFI_PASSWORD  "..."
#define MQTT_HOST      "roundhouse.proxy.rlwy.net"   // domain TCP Proxy
#define MQTT_PORT      12345                          // port TCP Proxy
#define DEVICE_ID      "esp32-xxxxxx"
#define DEVICE_KEY     "..."
```

6. Nạp firmware, mở Serial Monitor 115200: phải thấy WiFi → MQTT → gửi số đo.

## 7. Kiểm tra sau deploy

- `https://<ten>.up.railway.app/api/health` → `ok:true`, `brokerConnected:true`.
- Đăng nhập `admin` → thấy trang `/admin`: form thêm người dùng và form cấp
  thiết bị cho khách. Đăng nhập tài khoản khách → thấy dashboard của bể được cấp.
- Railway **Logs** phải có:
  ```
  [mqtt] Broker nhúng đang lắng nghe tại 0.0.0.0:1883
  [telegram] Bot @... đã sẵn sàng.
  ```
- Telegram: vào web → **Liên kết Telegram** → gửi `/start <mã>` → **Gửi thử**.

## 8. Giới hạn cần biết

| Vấn đề | Ảnh hưởng |
|---|---|
| Railway đóng HTTP sau tối đa 15 phút dù có dữ liệu | SSE `/api/stream` tự nối lại sau ~3 giây; app có heartbeat 15 giây nên gần như không nhận ra |
| TCP Proxy không TLS | MQTT đi plaintext; nên dùng DEVICE_KEY mạnh và đổi định kỳ |
| Trial $5 credit | Chạy 24/7 sẽ hết credit sau vài tuần; chuyển Hobby nếu dùng lâu dài |
| Volume 0.5 GB (Trial) | SQLite vài chục MB, đủ dùng |
| Deploy lại | Volume giữ nguyên dữ liệu; domain Railway giữ nguyên nếu không xoá service |

## 9. Cập nhật code sau này

Railway tự deploy khi push lên GitHub (nếu bật Auto Deploy). Kiểm tra
**Settings → Source → Auto Deploy**.

Hoặc dùng CLI:

```powershell
npm i -g @railway/cli
railway login
railway link          # chọn project/service
railway up            # deploy thư mục hiện tại
railway logs
```

## 10. Sự cố thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| Deploy lỗi `unable to open database file` | Volume chưa mount đúng `/app/data`, hoặc dùng image cũ không có entrypoint |
| Web 502 | App chưa listen đúng port 3000 hoặc healthcheck fail; xem Logs |
| ESP32 mất kết nối | Sai `MQTT_HOST`/`MQTT_PORT`, dùng port HTTP thay vì port TCP Proxy |
| Bot im lặng + log Conflict | Còn instance khác polling cùng token (server Azure) — tắt nó hoặc đổi token |
| Mở web bị đăng xuất liên tục | Đổi `SESSION_SECRET` sau khi đã đăng nhập; đặt cố định và deploy lại |
