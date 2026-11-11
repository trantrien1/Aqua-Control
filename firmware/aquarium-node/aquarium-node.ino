/*
 * Measurements merged from ESP32_Water_test.ino; see readmev2.md.
 * pH=34, turbidity=35 (10k/10k dividers), TDS=32 (3V3), DS18B20=27.
 * Relay IN1=GPIO18 (pH+), IN2=GPIO19 (pH-), IN3=GPIO21 (den 6V), IN4=GPIO22 (du phong).
 * WARNING: former optional ultrasonic sensor pins 18/19/21 are now assigned to relays.
 * Test mode from Serial Monitor: t1, t2, t3, off, status, help.
 * Libraries: PubSubClient, ArduinoJson >=7, OneWire, DallasTemperature.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "water-sensors.h"
static const char *WIFI_SSID = "TEN_WIFI_CUA_BAN";
static const char *WIFI_PASSWORD = "MAT_KHAU_WIFI_CUA_BAN";
static const char *MQTT_HOST = "IP_MAY_CHAY_SERVER";
static const uint16_t MQTT_PORT = 1883;
static const char *MQTT_USER = "";  // để trống nếu broker không đặt tài khoản
static const char *MQTT_PASSWORD = "";
static const char *DEVICE_ID = "esp32-beca-01";  // phải trùng .env của máy chủ
static const char *TOPIC_PREFIX = "aquarium";
static const char *FIRMWARE_VERSION = "2.2.0-relay3-light";
/* ------------------------------------------------------------------- chân --- */
// Chi bat cac thiet bi dang su dung; cac cam bien muc nuoc/thuc an van tat.
const bool ENABLE_PUMPS = true; // Bat 3 kenh: 2 bom + 1 den (giu ten de tuong thich MQTT)
const bool ENABLE_FLOAT = false;
const bool ENABLE_WATER_LEVEL = false; // Khong bat: GPIO18 da dung cho IN1
const bool ENABLE_FOOD_LEVEL = false; // Khong bat: GPIO19/21 da dung cho IN2/IN3
const uint8_t PIN_FLOAT = 33;
const uint8_t PIN_TRIG_WATER = 5;
const uint8_t PIN_ECHO_WATER = 18;
const uint8_t PIN_TRIG_FOOD = 19;
const uint8_t PIN_ECHO_FOOD = 21;
// Khong duoc doi ENABLE_WATER_LEVEL/ENABLE_FOOD_LEVEL thanh true
// khi chua doi lai cac chan GPIO18/19/21 vi trung voi relay.
const uint8_t PIN_RELAY_PH_UP = 18;   // GPIO18 -> IN1: Bom tang pH
const uint8_t PIN_RELAY_PH_DOWN = 19; // GPIO19 -> IN2: Bom giam pH
const uint8_t PIN_RELAY_LIGHT = 21;   // GPIO21 -> IN3: Den 6V
const uint8_t PIN_RELAY_SPARE = 22;   // GPIO22 -> IN4: Du phong, luon tat
static_assert(!ENABLE_WATER_LEVEL && !ENABLE_FOOD_LEVEL,
              "GPIO18/19/21 are relay outputs: ultrasonic sensors must remain disabled.");
/** Module 5V H/L: code nay dang chon che do kich muc LOW (jumper L). */
const bool RELAY_ACTIVE_LOW = true; // Dat ca 4 jumper tren module ve L, kiem tra khi CHUA co tai
const uint32_t RELAY_TEST_DURATION_MS = 3000; // Thu bang den: moi kenh sang 3 giay roi tat
/**
 * Phao cơ từ tính: một đầu nối GND, đầu kia vào GPIO 33 (INPUT_PULLUP).
 * Khi nước dâng chạm phao, tiếp điểm kín -> GPIO đọc mức THẤP.
 * Đổi thành true nếu phao của bạn đấu ngược lại.
 */
const bool FLOAT_ACTIVE_HIGH = false;
/* ------------------------------------------------------- tham số hiệu chuẩn --- */
/** Khoảng cách (cm) từ cảm biến siêu âm tới đáy bể và tới mặt nước khi đầy. */
const float WATER_SENSOR_TO_BOTTOM_CM = 32.0f;
const float WATER_SENSOR_TO_FULL_CM = 6.0f;
/** Khoảng cách từ cảm biến tới đáy hộp thức ăn và tới mức thức ăn khi đầy. */
const float FOOD_SENSOR_TO_BOTTOM_CM = 20.0f;
const float FOOD_SENSOR_TO_FULL_CM = 4.0f;
/* --------------------------------------------------------- chu kỳ hoạt động --- */
const uint32_t TELEMETRY_INTERVAL_MS = 5000;   // chu kỳ gửi số đo
const uint32_t STATE_INTERVAL_MS = 30000;      // chu kỳ gửi trạng thái relay
const uint32_t MQTT_LOST_TIMEOUT_MS = 60000;   // Mat MQTT 60s -> tat kenh bat qua MQTT
const uint32_t RECONNECT_INTERVAL_MS = 5000;
/**
 * Gioi han thoi gian chay moi kenh. Neu server co PUMPS, dong bo key ph_up/ph_down/light:
 * nếu lệnh từ máy chủ dài hơn, thiết bị cắt ở mức này.
 */
struct PumpConfig {
  const char *key;
  uint8_t pin;
  uint16_t maxSeconds;
};
const PumpConfig PUMPS[] = {
    {"ph_up", PIN_RELAY_PH_UP, 120},
    {"ph_down", PIN_RELAY_PH_DOWN, 120},
    {"light", PIN_RELAY_LIGHT, 3600},  // Den: toi da 60 phut moi lenh MQTT
};
const uint8_t PUMP_COUNT = sizeof(PUMPS) / sizeof(PUMPS[0]);
struct PumpState {
  bool on;
  uint32_t offAtMs;  // Moc hen gio tu tat (cac kenh deu co gioi han)
  uint32_t startedAtMs;
  bool localTest; // true neu duoc bat boi lenh t1/t2/t3 Serial Monitor
};
PumpState pumps[PUMP_COUNT];
/* ------------------------------------------------------------------ toàn cục --- */
WiFiClient netClient;
PubSubClient mqtt(netClient);
WaterSensors::Reading latestSensors;
char topicTelemetry[96];
char topicState[96];
char topicStatus[96];
char topicAck[96];
char topicCmd[96];
uint32_t lastTelemetryMs = 0;
uint32_t lastStateMs = 0;
uint32_t lastReconnectMs = 0;
uint32_t lastMqttConnectedMs = 0;
uint32_t lastWifiAttemptMs = 0;
char serialCommand[24]; // Bo dem lenh Serial khong dung String
uint8_t serialCommandLen = 0; // So ky tu dang nhan
bool serialCommandOverflow = false;
char lastCommandIds[8][80] = {};
uint8_t commandHistoryIndex = 0;
/** Đánh dấu đang trong chế độ "phao báo tràn". */
bool overflowDetected = false;
/* --------------------------------------------------------------- tiện ích --- */
void setRelay(uint8_t pin, bool on) {
  if (!ENABLE_PUMPS) return;
  digitalWrite(pin, RELAY_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
}
int pumpIndexByKey(const char *key) {
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    if (strcmp(PUMPS[i].key, key) == 0) return i;
  }
  return -1;
}
/** Trạng thái phao: true khi nước đã dâng tới mức tràn. */
bool floatTriggered() {
  return ENABLE_FLOAT && digitalRead(PIN_FLOAT) == (FLOAT_ACTIVE_HIGH ? HIGH : LOW);
}
/** Trả về NaN nếu cảm biến không phản hồi (quá thời gian chờ). */
float readDistanceCm(uint8_t trigPin, uint8_t echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  unsigned long duration = pulseIn(echoPin, HIGH, 30000UL);
  if (duration == 0) return NAN;
  return duration * 0.0343f / 2.0f;
}
float distanceToPercent(float distanceCm, float toBottomCm, float toFullCm) {
  if (isnan(distanceCm)) return NAN;
  float percent = (toBottomCm - distanceCm) / (toBottomCm - toFullCm) * 100.0f;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  return percent;
}
/* ---------------------------------------------------------- điều khiển bơm --- */
void publishAck(const char *pumpKey, bool ok, const char *action, const char *reason, const char *id = "") {
  JsonDocument doc;
  doc["id"] = id;
  doc["pump"] = pumpKey;
  doc["ok"] = ok;
  doc["action"] = action;
  if (reason && reason[0]) doc["reason"] = reason;
  JsonObject pumpsJson = doc["pumps"].to<JsonObject>();
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    pumpsJson[PUMPS[i].key] = pumps[i].on;
  }
  char buffer[512];
  size_t n = serializeJson(doc, buffer, sizeof(buffer));
  mqtt.publish(topicAck, (const uint8_t *)buffer, n);
}
void addCapabilities(JsonDocument &doc) {
  JsonObject caps = doc["capabilities"].to<JsonObject>();
  caps["pumps"] = ENABLE_PUMPS;
  JsonArray keys = caps["relay_keys"].to<JsonArray>();
  if (ENABLE_PUMPS) {
    for (uint8_t i = 0; i < PUMP_COUNT; ++i) keys.add(PUMPS[i].key);
  }
  caps["water_level"] = ENABLE_WATER_LEVEL;
  caps["food_level"] = ENABLE_FOOD_LEVEL;
  caps["turbidity_voltage"] = WaterSensors::ENABLE_TURBIDITY;
}
void addRelayTimers(JsonDocument &doc) {
  JsonObject timers = doc["relay_timers"].to<JsonObject>();
  const uint32_t now = millis();
  for (uint8_t i = 0; i < PUMP_COUNT; ++i) {
    const int32_t remaining = static_cast<int32_t>(pumps[i].offAtMs - now);
    timers[PUMPS[i].key]["remaining_ms"] = pumps[i].on && remaining > 0 ? remaining : 0;
    timers[PUMPS[i].key]["source"] = pumps[i].localTest ? "serial" : "mqtt";
  }
}
void publishState() {
  JsonDocument doc;
  doc["firmware"] = FIRMWARE_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["overflow"] = overflowDetected;
  addCapabilities(doc);
  addRelayTimers(doc);
  JsonObject pumpsJson = doc["pumps"].to<JsonObject>();
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    pumpsJson[PUMPS[i].key] = pumps[i].on;
  }
  char buffer[1024];
  size_t n = serializeJson(doc, buffer, sizeof(buffer));
  mqtt.publish(topicState, (const uint8_t *)buffer, n, true);  // retained
}
/** Tắt một bơm tại chỗ, không gửi ack (dùng cho các chốt an toàn). */
void stopPump(int index) {
  if (index < 0 || index >= PUMP_COUNT) return;
  if (!pumps[index].on) return;
  pumps[index].on = false;
  pumps[index].offAtMs = 0;
  pumps[index].localTest = false; // Reset che do test
  setRelay(PUMPS[index].pin, false);
  Serial.printf("[bơm] %s -> TẮT (an toàn)\n", PUMPS[index].key);
}
void stopAllPumps() {
  for (uint8_t i = 0; i < PUMP_COUNT; i++) stopPump(i);
}

// Kiem tra tung kenh bang DEN, khong can Wi-Fi hay MQTT.
// Chi mot kenh bat tai mot thoi diem; tu tat sau 3 giay.
void startSerialTest(uint8_t index) { // index = 0,1,2 tuong ung IN1,IN2,IN3
  if (!ENABLE_PUMPS || index >= PUMP_COUNT) return; // Chan chi so khong hop le
  stopAllPumps(); // Tat kenh truoc khi thu kenh moi
  pumps[index].on = true; // Cap nhat trang thai
  pumps[index].localTest = true; // Danh dau thu truc tiep tu Serial
  pumps[index].startedAtMs = millis(); // Lay moc thoi gian bat
  pumps[index].offAtMs = millis() + RELAY_TEST_DURATION_MS; // Hen gio tat 3 giay
  setRelay(PUMPS[index].pin, true); // Bat relay dang chon
  Serial.printf("[TEST] IN%u / GPIO%u / %s -> BAT 3 giay\n", index + 1, PUMPS[index].pin, PUMPS[index].key); // In thong tin
  if (mqtt.connected()) publishState(); // Cap nhat trang thai neu MQTT dang ket noi
}

void handleSerialCommand(const char *command) { // Xu ly cau lenh vua nhap
  if (strcmp(command, "t1") == 0) { startSerialTest(0); return; } // Test IN1
  if (strcmp(command, "t2") == 0) { startSerialTest(1); return; } // Test IN2
  if (strcmp(command, "t3") == 0) { startSerialTest(2); return; } // Test IN3
  if (strcmp(command, "off") == 0) { // Tat tat ca ngay
    stopAllPumps(); // Tat 3 kenh
    if (mqtt.connected()) publishState(); // Bao trang thai
    Serial.println("[TEST] Da tat IN1, IN2, IN3"); // Xac nhan
    return; // Ket thuc
  }
  if (strcmp(command, "status") == 0) { // Xem trang thai hien tai
    for (uint8_t i = 0; i < PUMP_COUNT; i++) { // Duyet 3 kenh
      Serial.printf("IN%u (%s): %s\n", i + 1, PUMPS[i].key, pumps[i].on ? "ON" : "OFF"); // In
    }
    Serial.println("IN4: OFF (du phong)"); // Kenh 4 luon tat
    return; // Ket thuc
  }
  if (strcmp(command, "help") == 0 || command[0] == '\0') { // Hien thi huong dan
    Serial.println("Lenh Serial: t1 | t2 | t3 | off | status | ph7 | ph4 | resetph | help");
    Serial.println("t1/t2/t3: lan luot bat IN1/IN2/IN3 trong 3 giay, sau do tu tat"); // Giai thich
    WaterSensors::printHelp();
    return; // Ket thuc
  }
  // Only this parser consumes Serial; delegate complete calibration commands.
  if (strcmp(command, "ph7") == 0 || strcmp(command, "ph4") == 0 || strcmp(command, "resetph") == 0) {
    WaterSensors::executeCommand(String(command));
    return;
  }
  Serial.println("Lenh khong hop le. Nhap help.");
}

void pollSerialCommands() { // Goi lien tuc trong loop
  while (Serial.available() > 0) { // Neu co du lieu tu Serial Monitor
    char c = (char)Serial.read(); // Doc mot ky tu
    if (c == '\r' || c == '\n') {
      serialCommand[serialCommandLen] = '\0'; // Ket thuc chuoi
      if (!serialCommandOverflow && serialCommandLen > 0) handleSerialCommand(serialCommand);
      serialCommandLen = 0; // Xoa bo dem
      serialCommandOverflow = false;
    } else if (serialCommandOverflow) {
      continue;  // Discard the WHOLE overlong line, not just its prefix.
    } else if (serialCommandLen < sizeof(serialCommand) - 1) {
      if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      serialCommand[serialCommandLen++] = c; // Luu ky tu
    } else { // Qua dai
      serialCommandOverflow = true;
      Serial.println("Lenh qua dai. Nhap help."); // Bao loi
    }
  }
}
void handleCommand(const uint8_t *payload, unsigned int length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.printf("[lệnh] JSON lỗi: %s\n", err.c_str());
    return;
  }
  const char *pumpKey = doc["pump"] | "";
  const char *action = doc["action"] | "";
  const char *commandId = doc["id"] | "";
  // QoS 1 can redeliver a command; never restart its timer a second time.
  for (uint8_t i = 0; commandId[0] && i < 8; ++i) {
    if (strcmp(lastCommandIds[i], commandId) == 0) {
      publishState();
      publishAck(pumpKey, true, action, "duplicate-ignored", commandId);
      return;
    }
  }
  int index = pumpIndexByKey(pumpKey);
  if (!ENABLE_PUMPS) {
    publishAck(pumpKey, false, action, "pumps-disabled", commandId);
    return;
  }
  if (index < 0) {
    publishAck(pumpKey, false, action, "unknown-pump", commandId);
    return;
  }
  Serial.printf("[lệnh] %s %s (%s)\n", pumpKey, action, commandId);
  if (strcmp(action, "off") == 0) {
    stopPump(index);
    publishState();
    publishAck(pumpKey, true, "off", "", commandId);
    return;
  }
  if (strcmp(action, "on") != 0) {
    publishAck(pumpKey, false, action, "unknown-action", commandId);
    return;
  }
  // ---- các chốt an toàn trước khi đóng relay ----
  if (overflowDetected && (strcmp(pumpKey, "ph_up") == 0 || strcmp(pumpKey, "ph_down") == 0)) {
    publishAck(pumpKey, false, "on", "nuoc-tran-khong-bom-hoa-chat", commandId);
    return;
  }
  if (!mqtt.connected()) {
    publishAck(pumpKey, false, "on", "mat-ket-noi", commandId);
    return;
  }
  // Liên động: nâng pH và hạ pH triệt tiêu nhau.
  if (strcmp(pumpKey, "ph_up") == 0) stopPump(pumpIndexByKey("ph_down"));
  if (strcmp(pumpKey, "ph_down") == 0) stopPump(pumpIndexByKey("ph_up"));
  // Missing/invalid duration defaults to a short test, never a full chemical dose.
  double duration = doc["duration"] | 3.0;
  if (!isfinite(duration) || duration <= 0) duration = 3;
  const uint32_t requested = static_cast<uint32_t>(constrain(duration, 1.0, static_cast<double>(PUMPS[index].maxSeconds)));
  pumps[index].on = true;
  pumps[index].localTest = false; // Lenh den tu MQTT, phai dung neu mat ket noi qua lau
  pumps[index].startedAtMs = millis();
  pumps[index].offAtMs = millis() + (uint32_t)requested * 1000UL;
  setRelay(PUMPS[index].pin, true);
  if (commandId[0]) {
    snprintf(lastCommandIds[commandHistoryIndex], sizeof(lastCommandIds[0]), "%s", commandId);
    commandHistoryIndex = (commandHistoryIndex + 1) % 8;
  }
  publishState();
  publishAck(pumpKey, true, "on", "", commandId);
}
/* ----------------------------------------------------------- MQTT + Wi-Fi --- */
void buildTopics() {
  snprintf(topicTelemetry, sizeof(topicTelemetry), "%s/%s/telemetry", TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicState, sizeof(topicState), "%s/%s/state", TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicStatus, sizeof(topicStatus), "%s/%s/status", TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicAck, sizeof(topicAck), "%s/%s/ack", TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicCmd, sizeof(topicCmd), "%s/%s/cmd", TOPIC_PREFIX, DEVICE_ID);
}
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiAttemptMs < RECONNECT_INTERVAL_MS) return;
  lastWifiAttemptMs = millis();
  Serial.printf("[wifi] Kết nối %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}
void ensureMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastReconnectMs < RECONNECT_INTERVAL_MS) return;
  lastReconnectMs = millis();
  Serial.printf("[mqtt] Kết nối %s:%u ...\n", MQTT_HOST, MQTT_PORT);
  // Last Will: broker tự báo "offline" khi mất điện / mất Wi-Fi.
  bool ok = mqtt.connect(
      DEVICE_ID,
      (MQTT_USER[0] ? MQTT_USER : nullptr),
      (MQTT_PASSWORD[0] ? MQTT_PASSWORD : nullptr),
      topicStatus, 1, true, "offline");
  if (!ok) {
    Serial.printf("[mqtt] Thất bại, mã %d\n", mqtt.state());
    return;
  }
  lastMqttConnectedMs = millis();
  Serial.println("[mqtt] Đã kết nối");
  mqtt.publish(topicStatus, "online", true);
  mqtt.subscribe(topicCmd, 1);
  publishState();
  lastTelemetryMs = 0;  // gửi số đo ngay sau khi kết nối lại
}
/* -------------------------------------------------------------- telemetry --- */
void publishTelemetry() {
  JsonDocument doc;
  // ArduinoJson emits JSON null for NaN (default configuration).
  doc["temperature"] = latestSensors.temperature;
  doc["ph"] = latestSensors.ph;
  doc["tds"] = latestSensors.tds;
  doc["turbidity"] = nullptr;  // No NTU calibration for this module.
  doc["turbidity_voltage"] = latestSensors.turbidityVoltage;
  doc["water_level"] = nullptr;
  doc["food_level"] = nullptr;
  JsonObject sensorStatus = doc["sensor_status"].to<JsonObject>();
  sensorStatus["ph_calibrated"] = latestSensors.phCalibrated;
  sensorStatus["tds_estimated"] = true;
  sensorStatus["tds_temperature_fallback"] = latestSensors.tdsTemperatureFallback;
  sensorStatus["ph_adc_voltage"] = latestSensors.phADC;
  sensorStatus["tds_adc_voltage"] = latestSensors.tdsADC;
  sensorStatus["turbidity_adc_voltage"] = latestSensors.turbidityADC;
  addCapabilities(doc);
  addRelayTimers(doc);
  if (ENABLE_WATER_LEVEL) {
    doc["water_level"] = distanceToPercent(readDistanceCm(PIN_TRIG_WATER, PIN_ECHO_WATER),
                                          WATER_SENSOR_TO_BOTTOM_CM, WATER_SENSOR_TO_FULL_CM);
  }
  if (ENABLE_FOOD_LEVEL) {
    doc["food_level"] = distanceToPercent(readDistanceCm(PIN_TRIG_FOOD, PIN_ECHO_FOOD),
                                         FOOD_SENSOR_TO_BOTTOM_CM, FOOD_SENSOR_TO_FULL_CM);
  }
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  doc["firmware"] = FIRMWARE_VERSION;
  JsonObject pumpsJson = doc["pumps"].to<JsonObject>();
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    pumpsJson[PUMPS[i].key] = pumps[i].on;
  }
  char buffer[1280];
  size_t n = serializeJson(doc, buffer, sizeof(buffer));
  if (!mqtt.publish(topicTelemetry, (const uint8_t *)buffer, n)) {
    Serial.println("[mqtt] Gửi telemetry thất bại (hàng đợi đầy?)");
  }
}
/* ------------------------------------------------------------ chốt an toàn --- */
void runSafetyChecks() {
  if (!ENABLE_PUMPS) return;
  // 1. Giới hạn thời gian chạy cứng
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    if (!pumps[i].on) continue;
    bool timedOut = pumps[i].offAtMs != 0 && static_cast<int32_t>(millis() - pumps[i].offAtMs) >= 0;
    bool overMax = millis() - pumps[i].startedAtMs > PUMPS[i].maxSeconds * 1000UL + 2000UL;
    if (timedOut || overMax) {
      bool wasLocalTest = pumps[i].localTest; // Ghi nho nguon lenh de khong gui ack sai
      stopPump(i);
      publishState();
      if (mqtt.connected() && !wasLocalTest) publishAck(PUMPS[i].key, true, "off", "het-thoi-gian");
    }
  }
  // 2. Phao báo tràn: ghi nhận và tắt các bơm hoá chất đang chạy.
  bool overflowNow = floatTriggered();
  if (overflowNow != overflowDetected) {
    overflowDetected = overflowNow;
    Serial.printf("[an toàn] Nước tràn: %s\n", overflowDetected ? "CÓ" : "không");
    if (overflowDetected) {
      stopPump(pumpIndexByKey("ph_up"));
      stopPump(pumpIndexByKey("ph_down"));
      publishState();
    }
  }
  // 3. Mat MQTT qua lau: tat kenh duoc bat tu MQTT; khong can thiep test Serial 3 giay.
  if (!mqtt.connected() && millis() - lastMqttConnectedMs > MQTT_LOST_TIMEOUT_MS) {
    for (uint8_t i = 0; i < PUMP_COUNT; i++) {
      if (pumps[i].on && !pumps[i].localTest) {
        Serial.printf("[an toan] Mat MQTT -> tat %s\n", PUMPS[i].key);
        stopPump(i);
      }
    }
  }
}
/* ------------------------------------------------------------------- setup --- */
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("=== Bể cá IoT — ESP32 khởi động ===");
  for (uint8_t i = 0; i < PUMP_COUNT; i++) { // Khoi tao 3 kenh relay
    pumps[i].on = false; // Trang thai logic OFF
    pumps[i].offAtMs = 0; // Khong co hen gio
    pumps[i].startedAtMs = 0; // Chua bat
    pumps[i].localTest = false; // Khong phai lenh test
    if (ENABLE_PUMPS) { // Neu cho phep dieu khien relay
      digitalWrite(PUMPS[i].pin, RELAY_ACTIVE_LOW ? HIGH : LOW); // Dat muc tat truoc
      pinMode(PUMPS[i].pin, OUTPUT); // Cau hinh GPIO lam dau ra
      setRelay(PUMPS[i].pin, false); // Giu relay tat
    }
  }
  digitalWrite(PIN_RELAY_SPARE, RELAY_ACTIVE_LOW ? HIGH : LOW); // IN4 luon tat
  pinMode(PIN_RELAY_SPARE, OUTPUT); // GPIO22 la dau ra du phong
  if (ENABLE_FLOAT) pinMode(PIN_FLOAT, INPUT_PULLUP);
  if (ENABLE_WATER_LEVEL) {
    pinMode(PIN_TRIG_WATER, OUTPUT);
    pinMode(PIN_ECHO_WATER, INPUT);
  }
  if (ENABLE_FOOD_LEVEL) {
    pinMode(PIN_TRIG_FOOD, OUTPUT);
    pinMode(PIN_ECHO_FOOD, INPUT);
  }
  WaterSensors::begin();
  buildTopics();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1536);
  mqtt.setSocketTimeout(2);
  mqtt.setKeepAlive(30);
  mqtt.setCallback([](char *topic, uint8_t *payload, unsigned int length) {
    if (strcmp(topic, topicCmd) == 0) handleCommand(payload, length);
  });
  Serial.printf("[hệ thống] Device ID: %s\n", DEVICE_ID);
  Serial.printf("[hệ thống] Broker: %s:%u\n", MQTT_HOST, MQTT_PORT);
  Serial.println("[TEST] Gui t1, t2, t3 roi Enter (Newline) de thu tung kenh 3 giay.");
}
/* -------------------------------------------------------------------- loop --- */
void loop() {
  pollSerialCommands();
  runSafetyChecks();
  // Keep local 3s tests responsive even when the broker is unreachable.
  bool localTestRunning = false;
  for (uint8_t i = 0; i < PUMP_COUNT; ++i) localTestRunning |= pumps[i].on && pumps[i].localTest;
  ensureWifi();
  if (!localTestRunning) ensureMqtt();
  if (mqtt.connected()) {
    mqtt.loop();
    lastMqttConnectedMs = millis();
  }
  runSafetyChecks();
  uint32_t now = millis();
  if (!localTestRunning && now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    latestSensors = WaterSensors::read();  // Serial measurements continue without Wi-Fi.
    runSafetyChecks();
    if (mqtt.connected()) publishTelemetry();
  }
  if (mqtt.connected() && now - lastStateMs >= STATE_INTERVAL_MS) {
    lastStateMs = now;
    publishState();
  }
  delay(10);
}
