#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// USB Serial configuration, persisted separately from sensor calibration.
namespace NetworkConfig {
struct Config {
  String ssid;
  String wifiPassword;
  String host;
  String user;
  String password;
  uint16_t port = 1883;
  bool tls = false;
};

void toJson(JsonDocument &doc, const Config &cfg) {
  doc["ssid"] = cfg.ssid;
  doc["wifi_password"] = cfg.wifiPassword;
  doc["mqtt_host"] = cfg.host;
  doc["mqtt_user"] = cfg.user;
  doc["mqtt_password"] = cfg.password;
  doc["mqtt_port"] = cfg.port;
  doc["mqtt_tls"] = cfg.tls;
}

bool update(const char *json, const Config &current, Config &next, String &error) {
  JsonDocument doc;
  if (deserializeJson(doc, json) || !doc.is<JsonObject>() || doc.size() == 0) {
    error = "Can mot JSON object hop le sau netset.";
    return false;
  }
  next = current;
  for (JsonPair item : doc.as<JsonObject>()) {
    const String key = item.key().c_str();
    if (key == "mqtt_tls") {
      if (!item.value().is<bool>()) { error = "mqtt_tls phai la true/false."; return false; }
      next.tls = item.value().as<bool>();
      continue;
    }
    if (key == "mqtt_port") {
      if (!item.value().is<int>() || item.value().as<int>() < 1 || item.value().as<int>() > 65535) {
        error = "mqtt_port phai la so nguyen 1..65535.";
        return false;
      }
      next.port = item.value().as<uint16_t>();
      continue;
    }
    if (!item.value().is<const char *>()) { error = "Truong chuoi khong hop le."; return false; }
    const String value = item.value().as<const char *>();
    if (value.length() != item.value().as<JsonString>().size()) { error = "Chuoi khong hop le."; return false; }
    if (key == "ssid") next.ssid = value;
    else if (key == "wifi_password") next.wifiPassword = value;
    else if (key == "mqtt_host") next.host = value;
    else if (key == "mqtt_user") next.user = value;
    else if (key == "mqtt_password") next.password = value;
    else { error = "Ten truong khong duoc ho tro: " + key; return false; }
  }
  if (next.ssid.length() == 0 || next.ssid.length() > 32 || next.wifiPassword.length() > 64 ||
      next.host.length() == 0 || next.host.length() > 253 || next.user.length() > 128 || next.password.length() > 256) {
    error = "Kiem tra do dai SSID/mat khau/hostname. Can SSID va mqtt_host.";
    return false;
  }
  if (next.wifiPassword.length() > 0 && next.wifiPassword.length() < 8) {
    error = "Mat khau WPA phai co it nhat 8 ky tu (hoac rong cho mang mo).";
    return false;
  }
  if (next.wifiPassword.length() == 64) {
    for (size_t i = 0; i < 64; ++i) {
      if (!isxdigit(static_cast<unsigned char>(next.wifiPassword[i]))) {
        error = "Khoa Wi-Fi 64 ky tu phai la hex.";
        return false;
      }
    }
  }
  for (size_t i = 0; i < next.host.length(); ++i) {
    const char c = next.host[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-')) {
      error = "mqtt_host chi la hostname/IPv4, khong co mqtt://, https:// hay :port.";
      return false;
    }
  }
  return true;
}

bool save(const Config &cfg) {
  JsonDocument doc;
  toJson(doc, cfg);
  String json;
  serializeJson(doc, json);
  Preferences prefs;
  if (!prefs.begin("aqua-net", false)) return false;
  const size_t written = prefs.putString("config", json);
  prefs.end();
  return written == json.length();
}

Config load(const Config &defaults) {
  Preferences prefs;
  if (!prefs.begin("aqua-net", true)) return defaults;
  String json = prefs.getString("config", "");
  prefs.end();
  if (!json.length()) return defaults;
  Config cfg;
  String error;
  if (!update(json.c_str(), defaults, cfg, error)) {
    Serial.println("[net] Cau hinh NVS khong hop le, dung mac dinh trong firmware.");
    return defaults;
  }
  return cfg;
}

bool reset() {
  Preferences prefs;
  if (!prefs.begin("aqua-net", false)) return false;
  const bool ok = !prefs.isKey("config") || prefs.remove("config");
  prefs.end();
  return ok;
}

void print(const Config &cfg) {
  Serial.printf("[net] SSID: %s | MQTT: %s:%u | TLS: %s | User: %s\n", cfg.ssid.c_str(),
                cfg.host.c_str(), cfg.port, cfg.tls ? "ON" : "OFF", cfg.user.c_str());
  Serial.println("[net] Mat khau duoc an. netset {JSON} de doi, netshow de xem, netreset de xoa cau hinh mang.");
}
}  // namespace NetworkConfig
