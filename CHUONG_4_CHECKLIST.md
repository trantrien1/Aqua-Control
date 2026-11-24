# CHƯƠNG 4 — ĐỐI CHIẾU ẢNH VÀ THÔNG TIN CÒN THIẾU

Đối chiếu `Bao_cao_IoT_Aqua_Control.docx` (Chương 4, dòng "THỬ NGHIỆM VÀ KẾT QUẢ" → trước "KẾT LUẬN") với những gì đã có trong máy ngày **24/11/2026**.

## A. Chương 4 có 6 ô ảnh — hiện đã xong 1

| # | Ô ảnh (chú thích trong Word) | Trạng thái | Thiếu gì | Ai làm |
|---|---|---|---|---|
| 1 | Kết quả chạy kiểm thử phần mềm | ✅ **XONG** | — | Người 3 (đã chụp) |
| 2 | Thử relay qua Serial Monitor | ❌ Chưa | Log Serial `t1/t2/t3/status/off` + ảnh tải thật từng kênh | Người 1 + Người 3 |
| 3 | Dữ liệu Serial và dashboard từ bể thật | ❌ Chưa | Log `sensors`/`phstatus`, dashboard số đo thật, 4 giá trị + dụng cụ đối chiếu | Người 1 + Người 2 |
| 4 | Chu trình thay nước trên Web và mô hình | ❌ Chưa | V (L), t (s) từng bơm; ảnh 3 pha rút/cấp/chờ ổn định; % và số lít | Người 1 + Người 2 |
| 5 | Liên kết và cảnh báo trên Telegram | ❌ Chưa | Ảnh chat bot sau `/start <mã>`, `/be`, `/cam_bien`, `/nuoc`, nút Gửi thử | Người 2 (Web) + Người 3 (chat) |
| 6 | Minh chứng lịch đèn và bật theo nhiệt độ | ⛔ **Không thể** | Cả tính năng lẫn API đều không có trong mã hiện tại | Chờ bản 4.0 |

Ảnh đã chụp cho ô 1:

- `docs/screenshots/ket-qua/terminal-tests.png` — cửa sổ Terminal thật, chạy `tools/run-all-tests.ps1` lúc 16:28 ngày 24/11/2026.
- `docs/screenshots/ket-qua/terminal-tests-summary.png` — bản cắt riêng khung TỔNG KẾT cho dễ đọc khi chèn Word.

## B. Từng mục "BỔ SUNG" trong Chương 4 — đã đủ thông tin chưa?

### 1. Dòng 455 — "Người 3 chạy các lệnh… chụp Terminal"
**ĐỦ THÔNG TIN, đã hoàn thành.** Có sẵn: script chạy 1 lệnh, log có ngày giờ/môi trường, bảng kết quả, ảnh Terminal.
Còn phải làm khi ghép Word: ghi chú ảnh *"Windows 11, Node 24.12.0, ngày 24/11/2026"*.

### 2. Dòng 461–462 — thử relay `t1, t2, t3, status, off`
**ĐỦ THÔNG TIN để người cầm phần cứng làm**, nhưng có **một sai lệch cần sửa trong Word**: tài liệu ghi `IN1–IN4` và "relay bốn kênh", firmware thực tế chỉ có **3 kênh**: IN1 bơm rút (GPIO18), IN2 bơm cấp (GPIO19), IN3 đèn (GPIO21). Lệnh chỉ có `t1, t2, t3` — không có `t4`.
Cần bổ sung khi chụp: ảnh tải thật của từng kênh, giờ chụp, kênh nào đóng thật.

### 3. Dòng 465–487 — `sensors`, `phstatus`, `ph7`, `ph4`, `phmode calibrated`
**ĐỦ THÔNG TIN.** Các lệnh này có thật trong firmware hiện tại (đã kiểm tra mã nguồn).
Còn thiếu dữ liệu: nhiệt độ tham chiếu, pH tham chiếu, TDS tham chiếu, mẫu đục + `OUT (V)`. Bảng 4 dòng trong Word đang trống — phải có người đo mới điền được.
Lưu ý: `ph7`/`ph4` chỉ có nghĩa nếu có **dung dịch chuẩn pH 7,00 và 4,00**; không có thì ghi rõ "không hiệu chuẩn, dùng chế độ ước lượng".

### 4. Dòng 491–511 — lưu lượng bơm và chu trình thay nước
**ĐỦ THÔNG TIN.** Công thức `Q = 3600 × V / t` và cách đo đã rõ.
Còn thiếu: số đo thực tế (V, t) của từng bơm; ảnh 3 pha; tỷ lệ % và số lít rút/cấp. Không thể suy ra từ phần mềm.
Ghi chú: nếu chưa thử ca tự động, ghi đúng "chưa thử" — đừng bịa.

### 5. Dòng 514–515 — Telegram
**ĐỦ THÔNG TIN**, và bot đã chạy sẵn:
- Bot Azure: **@AquaCT01AT05Bot** (log `[telegram] Bot @AquaCT01AT05Bot đã sẵn sàng`, 24/11 12:04 giờ VN).
- Trên Web: khối "Thông báo Telegram" → nút **Liên kết Telegram** sinh mã; mã **không hết hạn** cho tới khi dùng hoặc tạo mã mới.
- Trình tự: Web lấy mã → Telegram gửi `/start <mã>` → thử `/be`, `/cam_bien`, `/nuoc` → Web bấm **Gửi thử** → chụp chat + màn hình Web.
Còn thiếu: ảnh chat thật (cần tài khoản Telegram của bạn) và ảnh Web ở trạng thái **đã liên kết**. Che mã/token/chat id khi chèn.

### 6. Dòng 520–549 — lịch đèn và giữ ấm
**KHÔNG ĐỦ THÔNG TIN — không thể làm với mã hiện tại.** Cụ thể thiếu:
- Không có `light-control.h` (tài liệu tham khảo [3] có nhắc, repo không có).
- Không có script `test:lighting`, không có mã lịch đèn/giữ ấm phía server.
- `/api/state` **không trả** `water.lighting` (`clockValid`, `scheduled`, `heating`, `manualOverride`, `source`).
- Dashboard **không có** mục cấu hình lịch đèn / ngưỡng giữ ấm (ô ảnh Chương 3 "Thiết lập ngưỡng, lịch đèn và giữ ấm" cũng vì thế mà không chụp được phần đèn).
- Firmware chỉ bật/tắt đèn bằng lệnh MQTT có hẹn giờ (`/den bat <giây>`), không có lịch theo giờ hay theo nhiệt độ.

⇒ Hai lựa chọn: (a) lấy đúng bộ mã 4.0.0 có `light-control.h` rồi tôi chạy lại toàn bộ; (b) ghi rõ trong hồ sơ là phiên bản nộp không có chức năng này và bỏ 6 dòng nghiệm thu đèn.

## C. Ảnh Chương 3 dùng lại được (nếu Người 2 cần)

| Ô ảnh Chương 3 | Ảnh có sẵn | Ghi chú |
|---|---|---|
| Trang đăng nhập trên website đã triển khai | `ket-qua/login.png` | Đúng |
| Dashboard giám sát bốn chỉ số nước | `ket-qua/dashboard-desktop.png` | Đúng (số đo mô phỏng) |
| Biểu đồ lịch sử và bộ chọn thời gian | cắt từ dashboard | Có sẵn trong ảnh full-page |
| Nhật ký điều khiển và cảnh báo gần nhất | cắt từ dashboard | Có sẵn trong ảnh full-page |
| Điều khiển bơm, đèn và thay nước | cắt từ dashboard | Có sẵn trong ảnh full-page |
| Thiết lập ngưỡng, lịch đèn và giữ ấm | ⚠️ chỉ có ngưỡng + thay nước | **Không có lịch đèn/giữ ấm** |
| Giao diện quản trị tài khoản và thiết bị | `ket-qua/admin.png` | Đúng, không lộ khoá thiết bị |
| Giao diện liên kết Telegram trên Web | ⚠️ chưa chụp riêng | Có trong dashboard; nên cắt/chụp riêng khối Telegram |
| Toàn cảnh bể, cụm ESP32, đường ống, mã nguồn, build | ❌ | Việc của Người 1/Người 2 |

## D. Việc nên làm tiếp, theo thứ tự

1. Chèn `terminal-tests-summary.png` vào ô 1, ghi chú môi trường + ngày.
2. Nhờ Người 1 cắm ESP32 vào Azure (firmware đang trỏ `20.249.9.173`), chụp `t1/t2/t3/status` + `sensors/phstatus`; gửi kèm số đo dụng cụ.
3. Đo lưu lượng 2 bơm, chạy 1 ca thay nước nhỏ, chụp 3 pha.
4. Bạn tự liên kết Telegram (1 phút) rồi chụp chat; tôi chụp lại Web trạng thái đã liên kết nếu cần.
5. Chốt với nhóm về mục lịch đèn/giữ ấm trước khi nộp.
