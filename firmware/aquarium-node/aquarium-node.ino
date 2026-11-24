/*
 * Aqua Control 4.0: water monitoring, water exchange and local lighting automation.
 * pH=34, turbidity=35 (10k/10k dividers), TDS=32 (3V3), DS18B20=27.
 * Relay IN1=GPIO18 (drain), IN2=GPIO19 (fill), IN3=GPIO21 (light), IN4=GPIO22 (spare).
 * WARNING: former optional ultrasonic sensor pins 18/19/21 are now assigned to relays.
 * Test mode from Serial Monitor: t1, t2, t3, off, status, help.
 * Libraries: PubSubClient, ArduinoJson >=7, OneWire, DallasTemperature.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <sys/time.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "water-sensors.h"
#include "network-config.h"
#include "mqtt-root-ca.h"
#include "water-settings.h"
#if __has_include("local-config.h")
#include "local-config.h"
#else
#include "local-config.example.h"
#endif
// Credentials are kept in local-config.h, separately from calibration.
static const char *WIFI_SSID = AQUA_WIFI_SSID;      // Ten Wi-Fi cua ban
static const char *WIFI_PASSWORD = AQUA_WIFI_PASSWORD;  // Mat khau Wi-Fi cua ban
// false: luon dung thong tin trong code, bo qua cau hinh mang NVS cu.
static const bool USE_SAVED_NETWORK_CONFIG = false;
static const char *MQTT_HOST = AQUA_MQTT_HOST;
static const uint16_t MQTT_PORT = 1883;
static const bool MQTT_TLS = false;
static const char *MQTT_USER = AQUA_DEVICE_ID;  // MQTT username = web-issued device ID
static const char *MQTT_PASSWORD = AQUA_DEVICE_KEY;
static const char *DEVICE_ID = AQUA_DEVICE_ID;  // Identity issued in the admin website
static const char *TOPIC_PREFIX = "aquarium";
static const char *FIRMWARE_VERSION = "4.0.0";
/* ------------------------------------------------------------------- chân --- */
// Chi bat cac thiet bi dang su dung; cac cam bien muc nuoc/thuc an van tat.
const bool ENABLE_PUMPS = true; // Bat 3 kenh: . bom + 1 den (giu ten de tuong thich MQTT)
const bool ENABLE_FLOAT = false;
const bool ENABLE_WATER_LEVEL = false; // Khong bat: GPIO18 da dung cho IN1
const bool ENABLE_FOOD_LEVEL = false; // Khong bat: GPIO19/21 da dung cho IN2/IN3
const uint8_t PIN_FLOAT = 33;
const uint8_t PIN_TRIG_WATER = 5;
const uint8_t PIN_ECHO_WATER = 18;
const uint8_t PIN_TRIG_FOOD = 19;
const uint8_t PIN_ECHO_FOOD = 21;
// Khong duoc doi ENABLE_WATER_LEVEL/ENABLE_FOOD_LEVEL thanh true
// khi chua doi lai cac chan GPIO18/19/.1 vi trung voi relay.
const uint8_t PIN_RELAY_DRAIN = 18; // GPIO18 -> IN1: Bom nuoc ra
const uint8_t PIN_RELAY_FILL = 19;  // GPIO19 -> IN2: Bom nuoc vao
const uint8_t PIN_RELAY_LIGHT = 21;   // GPIO21 -> IN3: Den 6V
const uint8_t PIN_RELAY_SPARE = 22;   // GPIO22 -> IN4: Du phong, luon tat
static_assert(!ENABLE_WATER_LEVEL && !ENABLE_FOOD_LEVEL,
              "GPIO18/19/.1 are relay outputs: ultrasonic sensors must remain disabled.");
/** Module H/L: use the HIGH trigger setting with this firmware. */
const bool RELAY_ACTIVE_LOW = false; // HIGH=ON, LOW=OFF; loads connected to COM-NO.
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
 * Gioi han thoi gian chay moi kenh. Neu server co PUMPS, dong bo key drain/fill/light:
 * nếu lệnh từ máy chủ dài hơn, thiết bị cắt ở mức này.
 */
struct PumpConfig {
  const char *key;
  uint8_t pin;
  uint16_t maxSeconds;
};
const PumpConfig PUMPS[] = {
    {"drain", PIN_RELAY_DRAIN, 3600},
    {"fill", PIN_RELAY_FILL, 3600},
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
WiFiClientSecure tlsClient;
PubSubClient mqtt(netClient);
NetworkConfig::Config networkSettings;
bool ntpStarted = false;
WaterSensors::Reading latestSensors;
char topicTelemetry[96];
char topicState[96];
char topicStatus[96];
char topicAck[96];
char topicCmd[96];
char topicConfig[96];
WaterChange::Controller waterChange;
LightControl::Controller lightControl;
uint32_t lastTemperatureReadMs = 0;
bool temperatureSampled = false;
void serviceLighting();
void serviceWaterChange();
void cancelWaterChange(const char *reason);
void publishTelemetry();
uint32_t lastTelemetryMs = 0;
uint32_t lastStateMs = 0;
uint32_t lastReconnectMs = 0;
uint32_t lastMqttConnectedMs = 0;
uint32_t lastWifiAttemptMs = 0;
char serialCommand[1536]; // Includes one-line JSON configuration; never echoed.
size_t serialCommandLen = 0;
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
  caps["water_change"] = ENABLE_PUMPS;
  caps["water_recovery"] = ENABLE_PUMPS;
  caps["lighting"] = ENABLE_PUMPS;
  JsonArray keys = caps["relay_keys"].to<JsonArray>();
  if (ENABLE_PUMPS) {
    for (uint8_t i = 0; i < PUMP_COUNT; ++i) keys.add(PUMPS[i].key);
  }
  caps["water_level"] = ENABLE_WATER_LEVEL;
  caps["food_level"] = ENABLE_FOOD_LEVEL;
  caps["turbidity_voltage"] = WaterSensors::ENABLE_TURBIDITY;
  caps["turbidity_percent"] = WaterSensors::ENABLE_TURBIDITY;
}
void addRelayTimers(JsonDocument &doc) {
  JsonObject timers = doc["relay_timers"].to<JsonObject>();
  const uint32_t now = millis();
  for (uint8_t i = 0; i < PUMP_COUNT; ++i) {
    const int32_t remaining = static_cast<int32_t>(pumps[i].offAtMs - now);
    timers[PUMPS[i].key]["remaining_ms"] = pumps[i].on && remaining > 0 ? remaining : 0;
    timers[PUMPS[i].key]["source"] = i == 2 && lightControl.automaticOn ? lightControl.source() : (i < 2 && waterChange.active()) ? (waterChange.automatic ? "auto" : "water_change") : pumps[i].localTest ? "serial" : "mqtt";
  }
}
void addWaterState(JsonDocument &doc) {
  JsonObject light = doc["lighting"].to<JsonObject>();
  light["clock_valid"] = time(nullptr) >= 1704067200;
  light["schedule_demand"] = lightControl.scheduled;
  light["heat_demand"] = lightControl.heatDemand;
  light["manual_override"] = lightControl.manualActive(millis());
  light["source"] = lightControl.automaticOn ? lightControl.source() : "manual";
  doc["settings_revision"] = waterChange.config.revision;
  JsonObject w = doc["water_change"].to<JsonObject>();
  w["stage"] = waterChange.stageName();
  w["percent"] = waterChange.percent;
  w["attempts"] = waterChange.attempts;
  w["automatic"] = waterChange.automatic;
  w["requires_level_check"] = waterChange.requiresLevelCheck();
  w["remaining_ms"] = waterChange.remaining(millis());
  w["reason"] = waterChange.reason;
}
void publishState() {
  JsonDocument doc;
  doc["firmware"] = FIRMWARE_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["overflow"] = overflowDetected;
  addWaterState(doc);
  addCapabilities(doc);
  addRelayTimers(doc);
  JsonObject pumpsJson = doc["pumps"].to<JsonObject>();
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    pumpsJson[PUMPS[i].key] = pumps[i].on;
  }
  char buffer[3072];
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

void serviceLighting() {
  if (!ENABLE_PUMPS) return;
  const uint32_t now = millis();
  const time_t epoch = time(nullptr);
  const bool clockValid = epoch >= 1704067200;
  const int64_t localSeconds = static_cast<int64_t>(epoch) + waterChange.config.lighting.utcOffsetMinutes * 60;
  const uint16_t minute = clockValid ? (localSeconds % 86400) / 60 : 0;
  const bool manual = lightControl.manualActive(now);
  const bool on = lightControl.update(waterChange.config.lighting, clockValid, minute,
    latestSensors.temperature, temperatureSampled && now - lastTemperatureReadMs <= 30000, now);
  if (manual) return;
  if (pumps[2].on == on) return;
  if (on) {
    pumps[2].on = true; pumps[2].startedAtMs = now;
    pumps[2].offAtMs = 0; pumps[2].localTest = false;
    setRelay(PIN_RELAY_LIGHT, true);
  } else stopPump(2);
  if (mqtt.connected()) publishState();
}

void serviceWaterChange() {
  static WaterChange::Stage previous = WaterChange::Stage::Idle;
  static uint8_t previousAttempts = 0;
  static bool managed = false;
  waterChange.tick(millis(), floatTriggered());
  WaterSettings::guard(waterChange); // Persist BEFORE energizing a relay.
  if (waterChange.active()) {
    managed = true;
    for (uint8_t i = 0; i < 2; ++i) {
      const bool on = i == 0 ? waterChange.drain() : waterChange.fill();
      if (!on) stopPump(i);
      else if (!pumps[i].on) {
        // Break before make, even if a malformed earlier report left the other pump on.
        stopPump(i == 0 ? 1 : 0);
        pumps[i].on = true;
        pumps[i].localTest = false;
        pumps[i].startedAtMs = waterChange.since;
        pumps[i].offAtMs = waterChange.since + waterChange.durationMs;
        setRelay(PUMPS[i].pin, true);
      }
    }
  } else if (managed) {
    stopPump(0); stopPump(1); managed = false;
  }
  if (previous != waterChange.stage || previousAttempts != waterChange.attempts) {
    previous = waterChange.stage; previousAttempts = waterChange.attempts;
    if (mqtt.connected()) publishState();
    Serial.printf("[water] %s, auto=%u, attempts=%u/3, reason=%s\n", waterChange.stageName(), waterChange.automatic, waterChange.attempts, waterChange.reason);
  }
}
void cancelWaterChange(const char *reason) {
  waterChange.abort(reason);
  serviceWaterChange();
}
void publishWaterAck(const char *id, const char *action, bool ok, const char *reason) {
  JsonDocument ack;
  ack["id"] = id; ack["type"] = "water_change"; ack["action"] = action;
  ack["ok"] = ok; ack["reason"] = reason;
  addWaterState(ack); addRelayTimers(ack);
  for (uint8_t i = 0; i < PUMP_COUNT; ++i) ack["pumps"][PUMPS[i].key] = pumps[i].on;
  char buffer[1536];
  const size_t n = serializeJson(ack, buffer, sizeof(buffer));
  mqtt.publish(topicAck, reinterpret_cast<const uint8_t *>(buffer), n);
}
void handleWaterSettings(const uint8_t *payload, unsigned int length) {
  JsonDocument doc;
  WaterChange::Config next;
  const char *reason = "";
  if (deserializeJson(doc, payload, length) || !WaterSettings::parse(doc.as<JsonVariantConst>(), next)) reason = "invalid-config";
  else if (pumps[0].on || pumps[1].on || waterChange.active()) reason = "pumps-or-cycle-busy";
  else if (next.revision < waterChange.config.revision) reason = "server-revision-older";
  else if (!WaterSettings::saveConfig(doc.as<JsonVariantConst>(), next, waterChange)) reason = "storage-error";
  if (reason[0]) Serial.printf("[water] Config rejected: %s, requested=%lu, stored=%lu.\n", reason, static_cast<unsigned long>(next.revision), static_cast<unsigned long>(waterChange.config.revision));
  JsonDocument ack;
  ack["type"] = "config"; ack["ok"] = !reason[0]; ack["reason"] = reason;
  ack["requested_revision"] = next.revision;
  addWaterState(ack);
  char buffer[768];
  const size_t n = serializeJson(ack, buffer, sizeof(buffer));
  mqtt.publish(topicAck, reinterpret_cast<const uint8_t *>(buffer), n);
  publishState(); // The web only calls it synchronized after seeing this revision.
}
void handleWaterCommand(JsonDocument &doc) {
  const char *id = doc["id"] | "";
  const char *action = doc["action"] | "";
  bool ok = false;
  const char *reason = "water-change-unavailable";
  if (strcmp(action, "stop") == 0) {
    cancelWaterChange("cancelled-check-level");
    stopPump(0); stopPump(1);
    ok = true;
  } else if (strcmp(action, "reset") == 0 && !waterChange.active() && !pumps[0].on && !pumps[1].on) {
    const bool confirmationMissing = waterChange.requiresLevelCheck() && !(doc["confirm_level"] | false);
    ok = waterChange.resetAfterLevelCheck(doc["confirm_level"] | false);
    if (ok) ok = WaterSettings::guard(waterChange);
    reason = ok ? "" : confirmationMissing ? "level-confirmation-required" : "storage-error";
  } else if (strcmp(action, "start") == 0 && ENABLE_PUMPS &&
      doc["percent"].is<unsigned int>() && doc["settings_revision"].is<uint32_t>() &&
      doc["settings_revision"].as<uint32_t>() == waterChange.config.revision &&
      !pumps[0].on && !pumps[1].on) {
    const unsigned int percent = doc["percent"].as<unsigned int>();
    if (percent >= 1 && percent <= 50) {
      ok = waterChange.start(percent, false, millis(), floatTriggered());
      serviceWaterChange();
      if (waterChange.stage == WaterChange::Stage::Error) ok = false;
    }
  }
  if (ok && id[0]) {
    snprintf(lastCommandIds[commandHistoryIndex], sizeof(lastCommandIds[0]), "%s", id);
    commandHistoryIndex = (commandHistoryIndex + 1) % 8;
  }
  publishState();
  publishWaterAck(id, action, ok, ok ? "" : reason);
}

NetworkConfig::Config defaultNetworkConfig() {
  NetworkConfig::Config cfg;
  cfg.ssid = WIFI_SSID;
  cfg.wifiPassword = WIFI_PASSWORD;
  cfg.host = MQTT_HOST;
  cfg.port = MQTT_PORT;
  cfg.tls = MQTT_TLS;
  cfg.user = MQTT_USER;
  cfg.password = MQTT_PASSWORD;
  return cfg;
}

void configureMqttTransport() {
  if (networkSettings.tls) {
    tlsClient.setCACert(MQTT_ROOT_CA);
    tlsClient.setHandshakeTimeout(5);
    mqtt.setClient(tlsClient);
  } else {
    mqtt.setClient(netClient);  // Local LAN test mode only.
  }
  mqtt.setServer(networkSettings.host.c_str(), networkSettings.port);
}

void applyNetworkSettings() {
  cancelWaterChange("network-change-check-level");
  stopAllPumps();
  if (mqtt.connected()) {
    publishState();
    mqtt.publish(topicStatus, "offline", true);
    mqtt.disconnect();
  }
  netClient.stop();
  tlsClient.stop();
  WiFi.disconnect(false, false);
  configureMqttTransport();
  ntpStarted = false;
  lastWifiAttemptMs = 0;
  lastReconnectMs = 0;
  if (networkSettings.ssid.length()) WiFi.begin(networkSettings.ssid.c_str(), networkSettings.wifiPassword.c_str());
  NetworkConfig::print(networkSettings);
}

// Kiem tra tung kenh bang DEN, khong can Wi-Fi hay MQTT.
// Chi mot kenh bat tai mot thoi diem; tu tat sau 3 giay.
void startSerialTest(uint8_t index) { // index = 0,1,. tuong ung IN1,IN2,IN3
  if (!ENABLE_PUMPS || index >= PUMP_COUNT) return; // Chan chi so khong hop le
  if (index == 1 && floatTriggered()) return;
  cancelWaterChange("serial-test-check-level");
  if (index < 2 && waterChange.manualBlocked()) return;
  stopAllPumps(); // Tat kenh truoc khi thu kenh moi
  lightControl.manual(millis(), index == 2 ? RELAY_TEST_DURATION_MS : 3600000UL);
  pumps[index].on = true; // Cap nhat trang thai
  pumps[index].localTest = true; // Danh dau thu truc tiep tu Serial
  pumps[index].startedAtMs = millis(); // Lay moc thoi gian bat
  pumps[index].offAtMs = millis() + RELAY_TEST_DURATION_MS; // Hen gio tat 3 giay
  setRelay(PUMPS[index].pin, true); // Bat relay dang chon
  Serial.printf("[TEST] IN%u / GPIO%u / %s -> BAT 3 giay\n", index + 1, PUMPS[index].pin, PUMPS[index].key); // In thong tin
  if (mqtt.connected()) publishState(); // Cap nhat trang thai neu MQTT dang ket noi
}

void handleSerialCommand(const char *rawCommand) {
  String line(rawCommand);
  line.trim();
  int separator = line.indexOf(' ');
  String operation = separator >= 0 ? line.substring(0, separator) : line;
  operation.toLowerCase();
  const char *command = operation.c_str();
  if (operation == "sensors") {
    // Read-only diagnostics must never pause an active water phase or reset its guard.
    if (pumps[0].on || pumps[1].on || waterChange.active()) {
      Serial.println("[sensor] Hay dung bom/chu trinh truoc khi do chan doan."); return;
    }
    WaterSensors::rescanTemperature();
    Serial.printf("[sensor] Pins: PH=%u TDS=%u TURB=%u DS18B20=%u; devices=%u\n", WaterSensors::PIN_PH, WaterSensors::PIN_TDS, WaterSensors::PIN_TURBIDITY, WaterSensors::PIN_TEMPERATURE, WaterSensors::temperatureDevices);
    latestSensors = WaterSensors::read();
    Serial.printf("[sensor] ADC raw 12-bit: PH GPIO%u=%u, TDS GPIO%u=%u, TURB GPIO%u=%u\n", WaterSensors::PIN_PH, analogRead(WaterSensors::PIN_PH), WaterSensors::PIN_TDS, analogRead(WaterSensors::PIN_TDS), WaterSensors::PIN_TURBIDITY, analogRead(WaterSensors::PIN_TURBIDITY));
    if (mqtt.connected()) publishTelemetry();
    return;
  }
  if (operation == "netset") {
    if (!USE_SAVED_NETWORK_CONFIG) {
      Serial.println("[net] Dang dung Wi-Fi co dinh trong code. Sua WIFI_SSID/WIFI_PASSWORD roi nap lai.");
      return;
    }
    NetworkConfig::Config next;
    String error;
    if (separator < 0 || !NetworkConfig::update(line.substring(separator + 1).c_str(), networkSettings, next, error)) {
      Serial.printf("[net] Tu choi: %s\n", error.length() ? error.c_str() : "Can JSON sau netset.");
      return;
    }
    if (!NetworkConfig::save(next)) { Serial.println("[net] Khong luu duoc NVS, giu cau hinh hien tai."); return; }
    networkSettings = next;
    applyNetworkSettings();
    Serial.println("[net] Da luu. Khong can nap lai firmware; hay doi ket noi lai.");
    return;
  }
  if (operation == "netshow") { NetworkConfig::print(networkSettings); return; }
  if (operation == "netreset") {
    if (!USE_SAVED_NETWORK_CONFIG) {
      Serial.println("[net] Dang dung cau hinh trong code; khong can xoa NVS.");
      return;
    }
    if (!NetworkConfig::reset()) { Serial.println("[net] Khong xoa duoc NVS."); return; }
    networkSettings = defaultNetworkConfig();
    applyNetworkSettings();
    Serial.println("[net] Da xoa cau hinh mang, GIU NGUYEN hieu chuan pH.");
    return;
  }
  if (strcmp(command, "t1") == 0) { startSerialTest(0); return; } // Test IN1
  if (strcmp(command, "t2") == 0) { startSerialTest(1); return; } // Test IN2
  if (strcmp(command, "t3") == 0) { startSerialTest(2); return; } // Test IN3
  if (strcmp(command, "waterreset") == 0) {
    waterChange.resetAfterLevelCheck(true); // The explicit Serial waterreset command is the operator's confirmation.
    WaterSettings::guard(waterChange);
    publishState();
    return;
  }
  if (strcmp(command, "off") == 0) {
    lightControl.manual(millis(), 3600000UL);
    cancelWaterChange("cancelled-check-level"); // Tat tat ca ngay
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
    Serial.println("Lenh Serial: t1 | t2 | t3 | off | status | sensors | waterreset | ph7 | ph4 | phstatus | phfilter on/off | phmode calibrated/estimated | resetph | help");
    Serial.println("waterreset: chi gui SAU KHI da kiem tra va can bang muc nuoc.");
    Serial.println("t1/t2/t3: lan luot bat IN1/IN2/IN3 trong 3 giay, sau do tu tat"); // Giai thich
    WaterSensors::printHelp();
    if (USE_SAVED_NETWORK_CONFIG) Serial.println("Mang: netset {JSON} | netshow | netreset.");
    else Serial.println("Mang: sua WIFI_SSID/WIFI_PASSWORD/MQTT_HOST o dau file roi nap lai; netshow de xem.");
    return; // Ket thuc
  }
  // Only this parser consumes Serial; delegate complete calibration commands.
  if (operation == "phstatus" || operation == "phfilter" || operation == "phmode" || strcmp(command, "ph7") == 0 || strcmp(command, "ph4") == 0 || strcmp(command, "resetph") == 0 || strcmp(command, "resetapprox") == 0) {
    if (operation != "phstatus" && (pumps[0].on || pumps[1].on || waterChange.active())) {
      Serial.println("[pH] Dung bom/chu trinh truoc khi doi che do, loc hoac hieu chuan."); return;
    }
    WaterSensors::executeCommand(line);
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
      // Preserve SSID/password case inside JSON. Only the operation is normalized.
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
  if (strcmp(doc["type"] | "", "time") == 0) {
    if (doc["epoch"].is<uint32_t>()) {
      const uint32_t epoch = doc["epoch"];
      if (epoch >= 1704067200UL && epoch <= 4102444800UL) {
        timeval clock = {static_cast<time_t>(epoch), 0};
        settimeofday(&clock, nullptr);
      }
    }
    return;
  }
  const char *pumpKey = doc["pump"] | "";
  const char *action = doc["action"] | "";
  const char *commandId = doc["id"] | "";
  // QoS 1 can redeliver a command; never restart its timer a second time.
  for (uint8_t i = 0; commandId[0] && i < 8; ++i) {
    if (strcmp(lastCommandIds[i], commandId) == 0) {
      publishState();
      if (strcmp(doc["type"] | "", "water_change") == 0) publishWaterAck(commandId, action, true, "duplicate-ignored");
      else publishAck(pumpKey, true, action, "duplicate-ignored", commandId);
      return;
    }
  }
  if (strcmp(doc["type"] | "", "water_change") == 0) { handleWaterCommand(doc); return; }
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
    if (index == 2) lightControl.manual(millis(), 3600000UL);
    if (index < 2) cancelWaterChange("cancelled-check-level");
    stopPump(index);
    publishState();
    publishAck(pumpKey, true, "off", "", commandId);
    return;
  }
  if (strcmp(action, "on") != 0) {
    publishAck(pumpKey, false, action, "unknown-action", commandId);
    return;
  }
  if (index < 2 && (waterChange.active() || waterChange.manualBlocked())) {
    publishAck(pumpKey, false, action, "water-change-busy-or-check-level", commandId); return;
  }
  // ---- các chốt an toàn trước khi đóng relay ----
  if (floatTriggered() && strcmp(pumpKey, "fill") == 0) {
    publishAck(pumpKey, false, "on", "overflow-fill-blocked", commandId);
    return;
  }
  if (!mqtt.connected()) {
    publishAck(pumpKey, false, "on", "mat-ket-noi", commandId);
    return;
  }
  // Liên động: hai bơm nước không chạy đồng thời.
  if (strcmp(pumpKey, "drain") == 0) stopPump(pumpIndexByKey("fill"));
  if (strcmp(pumpKey, "fill") == 0) stopPump(pumpIndexByKey("drain"));
  // Missing/invalid manual duration defaults to a short test.
  double duration = doc["duration"] | 3.0;
  if (!isfinite(duration) || duration <= 0) duration = 3;
  const uint32_t requested = static_cast<uint32_t>(constrain(duration, 1.0, static_cast<double>(PUMPS[index].maxSeconds)));
  if (index == 2) lightControl.manual(millis(), requested * 1000UL);
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
  snprintf(topicConfig, sizeof(topicConfig), "%s/%s/config", TOPIC_PREFIX, DEVICE_ID);
}
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED && !ntpStarted) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    ntpStarted = true;
  }
  if (WiFi.status() == WL_CONNECTED) return;
  if (!networkSettings.ssid.length()) return;
  if (millis() - lastWifiAttemptMs < RECONNECT_INTERVAL_MS) return;
  lastWifiAttemptMs = millis();
  Serial.printf("[wifi] Kết nối %s ...\n", networkSettings.ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(networkSettings.ssid.c_str(), networkSettings.wifiPassword.c_str());
}
void ensureMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  // A TCP/TLS reconnect can block. Finish local safety timers first while a load is on.
  for (uint8_t i = 0; i < PUMP_COUNT; ++i) {
    if (pumps[i].on && !(i == 2 && lightControl.automaticOn)) return;
  }
  if (millis() - lastReconnectMs < RECONNECT_INTERVAL_MS) return;
  lastReconnectMs = millis();
  if (networkSettings.tls && time(nullptr) < 1704067200) {
    if (!ntpStarted) {
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      ntpStarted = true;
    }
    Serial.println("[mqtt] Doi dong bo gio NTP de xac minh chung chi TLS.");
    return;
  }
  Serial.printf("[mqtt] Kết nối %s:%u (TLS %s) ...\n", networkSettings.host.c_str(), networkSettings.port,
                networkSettings.tls ? "ON" : "OFF");
  // Last Will: broker tự báo "offline" khi mất điện / mất Wi-Fi.
  bool ok = mqtt.connect(
      DEVICE_ID,
      networkSettings.user.c_str(),
      networkSettings.password.c_str(),
      topicStatus, 1, true, "offline");
  if (!ok) {
    Serial.printf("[mqtt] Thất bại, mã %d\n", mqtt.state());
    return;
  }
  lastMqttConnectedMs = millis();
  Serial.println("[mqtt] Đã kết nối");
  mqtt.publish(topicStatus, "online", true);
  mqtt.subscribe(topicCmd, 1);
  mqtt.subscribe(topicConfig, 1);
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
  doc["turbidity_percent"] = latestSensors.turbidityPercent;
  doc["water_level"] = nullptr;
  doc["food_level"] = nullptr;
  JsonObject sensorStatus = doc["sensor_status"].to<JsonObject>();
  sensorStatus["ph_calibrated"] = latestSensors.phCalibrated;
  sensorStatus["temperature_detected"] = latestSensors.temperatureDetected;
  sensorStatus["temperature_device_count"] = latestSensors.temperatureDeviceCount;
  sensorStatus["ph_status"] = latestSensors.phStatus;
  sensorStatus["tds_status"] = latestSensors.tdsStatus;
  sensorStatus["turbidity_status"] = latestSensors.turbidityStatus;
  sensorStatus["ph_estimated"] = latestSensors.phEstimated;
  sensorStatus["ph_fixed_reference"] = latestSensors.phFixedReference;
  sensorStatus["calibration_mode"] = latestSensors.phFixedReference ? "estimated_reference" : latestSensors.phCalibrated ? "two_point" : "uncalibrated";
  sensorStatus["ph_filter_enabled"] = WaterSensors::phFilterEnabled;
  sensorStatus["ph_calibration_v7"] = WaterSensors::ph7V;
  sensorStatus["ph_calibration_v4"] = WaterSensors::ph4V;
  sensorStatus["ph_estimate_reference"] = latestSensors.phEstimated ? SensorEstimates::TAP_PH : NAN;
  sensorStatus["ph_reference_adc_voltage"] = latestSensors.phReferenceADC;
  sensorStatus["ph_filtered_adc_voltage"] = latestSensors.phFilteredADC;
  sensorStatus["ph_raw"] = latestSensors.phRaw;
  sensorStatus["turbidity_reference_voltage"] = latestSensors.turbidityReferenceVoltage;
  sensorStatus["turbidity_mode"] = "relative_percent";
  sensorStatus["turbidity_change_percent"] = latestSensors.turbidityChangePercent;
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
  addWaterState(doc);
  JsonObject pumpsJson = doc["pumps"].to<JsonObject>();
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    pumpsJson[PUMPS[i].key] = pumps[i].on;
  }
  char buffer[3072];
  size_t n = serializeJson(doc, buffer, sizeof(buffer));
  if (!mqtt.publish(topicTelemetry, (const uint8_t *)buffer, n)) {
    Serial.println("[mqtt] Gửi telemetry thất bại (hàng đợi đầy?)");
  }
}
/* ------------------------------------------------------------ chốt an toàn --- */
void runSafetyChecks() {
  if (!ENABLE_PUMPS) return;
  serviceWaterChange();
  // 1. Giới hạn thời gian chạy cứng
  for (uint8_t i = 0; i < PUMP_COUNT; i++) {
    if (!pumps[i].on || (i < 2 && waterChange.active())) continue;
    if (i == 2 && lightControl.automaticOn) continue;
    bool timedOut = pumps[i].offAtMs != 0 && static_cast<int32_t>(millis() - pumps[i].offAtMs) >= 0;
    bool overMax = millis() - pumps[i].startedAtMs > PUMPS[i].maxSeconds * 1000UL + 2000UL;
    if (timedOut || overMax) {
      bool wasLocalTest = pumps[i].localTest; // Ghi nho nguon lenh de khong gui ack sai
      stopPump(i);
      publishState();
      if (mqtt.connected() && !wasLocalTest) publishAck(PUMPS[i].key, true, "off", "het-thoi-gian");
    }
  }
  // .. Phao báo tràn: dừng hai bơm; chu trình tự động đã được khóa ở trên.
  bool overflowNow = floatTriggered();
  if (overflowNow != overflowDetected) {
    overflowDetected = overflowNow;
    Serial.printf("[an toàn] Nước tràn: %s\n", overflowDetected ? "CÓ" : "không");
    if (overflowDetected) {
      stopPump(pumpIndexByKey("drain"));
      stopPump(pumpIndexByKey("fill"));
      publishState();
    }
  }
  // 3. Mat MQTT qua lau: tat kenh duoc bat tu MQTT; khong can thiep test Serial 3 giay.
  if (!mqtt.connected() && millis() - lastMqttConnectedMs > MQTT_LOST_TIMEOUT_MS) {
    for (uint8_t i = 0; i < PUMP_COUNT; i++) {
      if (i == 2 && lightControl.automaticOn) continue;
      if (pumps[i].on && !pumps[i].localTest && !(i < 2 && waterChange.active())) {
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
  WaterSettings::begin(waterChange);
  networkSettings = USE_SAVED_NETWORK_CONFIG
    ? NetworkConfig::load(defaultNetworkConfig())
    : defaultNetworkConfig();
  buildTopics();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false); // Static credentials come from code; optional Serial mode uses aqua-net NVS.
  if (networkSettings.ssid.length()) WiFi.begin(networkSettings.ssid.c_str(), networkSettings.wifiPassword.c_str());
  configureMqttTransport();
  mqtt.setBufferSize(4096);
  mqtt.setSocketTimeout(2);
  mqtt.setKeepAlive(30);
  mqtt.setCallback([](char *topic, uint8_t *payload, unsigned int length) {
    if (strcmp(topic, topicCmd) == 0) handleCommand(payload, length);
    if (strcmp(topic, topicConfig) == 0) handleWaterSettings(payload, length);
  });
  Serial.printf("[hệ thống] Device ID: %s\n", DEVICE_ID);
  NetworkConfig::print(networkSettings);
  if (!USE_SAVED_NETWORK_CONFIG) Serial.println("[net] Wi-Fi/MQTT co dinh trong code; bo qua cau hinh mang NVS cu.");
  if (!networkSettings.ssid.length()) {
    Serial.println(USE_SAVED_NETWORK_CONFIG
      ? "[net] Chua co Wi-Fi. Gui netset {JSON} qua Serial 115200 + Newline."
      : "[net] Chua dien Wi-Fi. Sua local-config.h, sau do nap lai.");
  }
  Serial.println("[TEST] Gui t1, t2, t3 roi Enter (Newline) de thu tung kenh 3 giay.");
}
/* -------------------------------------------------------------------- loop --- */
void loop() {
  pollSerialCommands();
  runSafetyChecks();
  serviceLighting();
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
  // Keep the thermostat supplied with fresh DS18B20 data during water phases.
  if (!localTestRunning && (waterChange.drain() || waterChange.fill()) &&
      waterChange.config.lighting.heatEnabled && now - lastTemperatureReadMs >= 5000) {
    if (WaterSensors::temperatureDevices == 0 && now - WaterSensors::lastTemperatureSearchMs >= 10000)
      WaterSensors::rescanTemperature();
    WaterSensors::temperatureSensor.requestTemperatures();
    const float temp = WaterSensors::temperatureSensor.getTempCByIndex(0);
    latestSensors.temperature = isfinite(temp) && temp != DEVICE_DISCONNECTED_C && temp >= -55 && temp <= 125 ? temp : NAN;
    if (!isfinite(latestSensors.temperature)) WaterSensors::temperatureDevices = 0;
    lastTemperatureReadMs = millis(); temperatureSampled = true;
    runSafetyChecks(); serviceLighting();
  }
  if (!localTestRunning && !waterChange.drain() && !waterChange.fill() && now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    latestSensors = WaterSensors::read();
    lastTemperatureReadMs = millis();
    temperatureSampled = true;
    serviceLighting();
    const bool phReady = SensorEstimates::controlReady(latestSensors.ph, latestSensors.phCalibrated, latestSensors.phFixedReference);
    const float values[] = {latestSensors.temperature, phReady ? latestSensors.ph : NAN,
      latestSensors.tdsTemperatureFallback ? NAN : latestSensors.tds,
      waterChange.config.turbidityPercent ? latestSensors.turbidityPercent : latestSensors.turbidityVoltage};
    if (ENABLE_PUMPS) waterChange.sample(millis(), values, pumps[0].on || pumps[1].on, floatTriggered());
    serviceWaterChange();
    runSafetyChecks();
    if (mqtt.connected()) publishTelemetry();
  }
  if (mqtt.connected() && now - lastStateMs >= (waterChange.active() ? 5000UL : STATE_INTERVAL_MS)) {
    lastStateMs = now;
    publishState();
  }
  delay(10);
}
